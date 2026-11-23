import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefCallback } from "react";
import { DesktopClient } from "../../api/desktop";
import { HostConnection, HostConnectionError, type ReviewAngle, type ReviewModelPayload, type ReviewTakeGroup, errorMessage } from "../../api/host";
import { ProductionClient, type AssistantSelection, type SlateAttachment, type SlateBoard, type SlateEntry, type SlateParseResult, type SlateRecord } from "../../api/production";
import { SlateMediaClient, type SlateResolvedMediaItem } from "../../api/slateMedia";
import { SlateRecordClient } from "../../api/slateRecords";
import { TakeListRow } from "../material-script/TakeCard";
import { MirrorOrderMediaCard, mediaCardFromAngle, mediaCardFromAttachment } from "../media/MirrorOrderMediaCard";
import { canPreviewReviewPlayback } from "../media/mediaPlaybackProjection";
import { classifyPlaybackFailure, type PlaybackFailure } from "../media/playbackFailure";
import type { PaperRow, PaperVlmCandidate } from "../../api/paperIntake";
import { SlateOriginalFormSheet } from "./SlateOriginalFormSheet";
import { SlateIntervalBoardSurface } from "./SlateIntervalBoardSurface";
import type { ProductionSlateTarget } from "./SlatePaperFormSurface";
import type { ElectronicSlateIngest } from "./SlateElectronicImport";
import { type SlateIntervalLedgerProps } from "./SlateIntervalLedger";
import { useNativeSlateIntervalLedger } from "./useNativeSlateIntervalLedger";
import { SlatePaperIntake } from "./SlatePaperIntake";
import { SlateSourceIntervalPanel } from "./SlateSourceIntervalPanel";
import { SlateSpeechEvidencePanel } from "./SlateSpeechEvidencePanel";
import { SlateRow, SlateTableHead, SLATE_CAMERA_COLUMNS, type SlateCameraColumn } from "./SlateRow";
import type { PendingSlateDrafts, SlateDraft as Draft, SlateDraftSession } from "./slateDraftSession";
import { originalPlaybackUrl } from "./SlateOriginalPlayback";
import type { ProductionSelectionContext, ProductionWorkspace } from "../production/productionNavigation";
import { readCurrentOperator } from "../../components/CurrentOperatorControl";
import { closeDetailsMenu, handleDetailsMenuBlur, handleDetailsMenuToggle } from "../../components/detailsMenuDismiss";
import "../media/camera-presentation.css";
import "./golden-slate.css";
import "./golden-slate-media-experience.css";

interface Props {
  baseUrl: string;
  projectId: string;
  projectName?: string;
  draftSession?: SlateDraftSession;
  active?: boolean;
  focus?: ProductionSelectionContext | null;
  onSelection?: (selection: ProductionSelectionContext) => void;
  onOpenTake?: (destination: ProductionWorkspace, selection: ProductionSelectionContext) => void;
  onRepair?: () => void;
  onInspectSelection?: (selection: AssistantSelection) => void;
  // The interval ledger must be supplied by a private, project-verified adapter.
  enableNativeIntervalLedger?: boolean;
  intervalLedger?: Omit<SlateIntervalLedgerProps, "catalog"> & { projectId: string; importElectronic?: ElectronicSlateIngest };
}

type SceneLink = { episode: number; sceneId: string };
type SlateOrder = "script" | "shooting";
type DraftView = { board: SlateBoard | null; rows: Draft[]; pending: PendingSlateDrafts };

// 值是 supervisor 存储/解析层的英文枚举；下拉展示中文景别。
const SHOT_LABELS: Record<string, string> = {
  unknown: "未知",
  wide: "大远景",
  full: "全景",
  medium: "中景",
  medium_closeup: "中近景",
  closeup: "近景",
  extreme_closeup: "大特写",
  big_closeup: "特写",
  insert: "插入镜头",
};
const SHOT_OPTIONS = Object.keys(SHOT_LABELS);
const QUICK_SLATE_TAGS = ["保条 ★", "临场改词", "情绪爆发", "补拍特写", "OS", "空镜", "穿帮", "虚焦", "误录"] as const;
const SLATE_COLUMN_WIDTHS_STORAGE_KEY = "mirrororder.slateColumnWidths.v1";

function newRecordId(): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `slate-${id.replaceAll("-", "").toLowerCase()}`;
}

function closeGoldenSlateMenu(button: HTMLButtonElement): void {
  closeDetailsMenu(button);
}

function attachmentKey(attachment: SlateAttachment): string {
  return attachment.clip_id || attachment.media_id;
}

function attachmentFromAngle(angle: ReviewAngle): SlateAttachment {
  return {
    clip_id: angle.clip_id,
    media_id: angle.media_id,
    camera: angle.camera,
    display_name: angle.name,
    shot_type: angle.shot_type || "unknown",
    source_role: "sync_camera",
    note: "",
  };
}

function attachmentFromResolved(item: SlateResolvedMediaItem): SlateAttachment {
  return {
    clip_id: item.clip_id,
    media_id: item.media_id,
    camera: item.camera,
    display_name: item.display_name,
    shot_type: "unknown",
    source_role: item.source_role || "sync_camera",
    note: "",
  };
}

function mergeAttachments(current: SlateAttachment[], additions: SlateAttachment[]): SlateAttachment[] {
  const rows = [...current];
  const seen = new Set(rows.map(attachmentKey).filter(Boolean));
  for (const item of additions) {
    const key = attachmentKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push(item);
  }
  return rows;
}

function mergeTakeAttachments(record: SlateRecord, take: ReviewTakeGroup | null): SlateAttachment[] {
  if (!take) return record.attachments;
  const existing = new Map(record.attachments.map((item) => [attachmentKey(item), item]));
  const reviewAttachments = take.angles.map((angle) => {
    const prior = existing.get(angle.clip_id) ?? existing.get(angle.media_id);
    return prior ? {
      ...attachmentFromAngle(angle),
      ...prior,
      clip_id: prior.clip_id || angle.clip_id,
      media_id: prior.media_id || angle.media_id,
      camera: prior.camera || angle.camera,
      display_name: prior.display_name || angle.name,
    } : attachmentFromAngle(angle);
  });
  return mergeAttachments(reviewAttachments, record.attachments);
}

function automaticMappingConfirmed(take: ReviewTakeGroup): boolean {
  return take.automatic_state.status === "auto_confirmed" || take.automatic_state.status === "ai_confirmed";
}

function mappedScene(review: ReviewModelPayload, take: ReviewTakeGroup): SceneLink | null {
  const effectiveIds = take.effective_mapping.script_segment_ids;
  const automaticIds = automaticMappingConfirmed(take) ? take.automatic_state.script_segment_ids ?? [] : [];
  const ids = effectiveIds.length ? effectiveIds : automaticIds;
  if (!ids.length) return null;
  const wanted = new Set(ids);
  for (const episode of review.episodes) {
    for (const scene of episode.scenes) {
      if (scene.script_blocks.some((block) => wanted.has(block.segment_id))) {
        return { episode: episode.episode, sceneId: scene.scene_id };
      }
    }
  }
  return null;
}

function derivedEpisode(take: ReviewTakeGroup, mapped: SceneLink | null): number | null {
  const confirmedAutomaticEpisode = automaticMappingConfirmed(take) ? take.automatic_state.episode_ids?.[0] : undefined;
  return take.effective_mapping.episode_ids[0]
    ?? confirmedAutomaticEpisode
    ?? mapped?.episode
    ?? take.candidates.find((candidate) => candidate.episode_ids.length > 0 && candidate.confidence !== "context_only")?.episode_ids[0]
    ?? null;
}

function takeMatchesEpisode(take: ReviewTakeGroup, episode: number): boolean {
  if (take.effective_mapping.episode_ids.includes(episode)) return true;
  if (automaticMappingConfirmed(take) && take.automatic_state.episode_ids?.includes(episode)) return true;
  return take.candidates.some((candidate) => candidate.episode_ids.includes(episode) && candidate.confidence !== "context_only");
}

function derivedSource(take: ReviewTakeGroup): string {
  if (take.automatic_state.status === "ai_confirmed") return "AI";
  if (take.automatic_state.status === "auto_confirmed") return "自动";
  if (take.effective_mapping.source === "human") return "映射";
  return "Take";
}

function draftFromRecord(record: SlateRecord, take: ReviewTakeGroup | null, xmlOrder: number): Draft {
  return { ...record, attachments: mergeTakeAttachments(record, take), dirty: false, derived: false, derivedSource: "", xmlOrder };
}

function prettySceneId(value: string): string {
  // SC_1_1 这类内部段 ID 对用户没有意义；转成场号习惯的 "1-1"。
  const match = /^SC_?(\d+)_(\d+)$/.exec(value.trim());
  return match ? `${match[1]}-${match[2]}` : value;
}

function draftFromTake(review: ReviewModelPayload, take: ReviewTakeGroup, xmlOrder: number): Draft {
  const mapped = mappedScene(review, take);
  return {
    record_id: `derived-${take.group_id}`,
    source_group_id: take.group_id,
    script_scene_id: mapped?.sceneId ?? "",
    episode: derivedEpisode(take, mapped),
    scene: "",
    shot: "",
    take_number: take.take_index || null,
    status: "unmarked",
    note: "",
    preferred_clip_id: "",
    attachments: take.angles.map(attachmentFromAngle),
    actor: "",
    updated_at: "",
    dirty: false,
    derived: true,
    derivedSource: derivedSource(take),
    xmlOrder,
  };
}

function blankDraft(seed?: Partial<Draft>): Draft {
  return {
    record_id: newRecordId(),
    source_group_id: "",
    script_scene_id: "",
    episode: null,
    scene: "",
    shot: "",
    take_number: null,
    status: "unmarked",
    note: "",
    preferred_clip_id: "",
    attachments: [],
    actor: "",
    updated_at: "",
    dirty: true,
    derived: false,
    derivedSource: "",
    xmlOrder: Number.MAX_SAFE_INTEGER,
    ...seed,
  };
}

function parseTakeNumber(value: string): number | null {
  const match = /(\d+)/.exec(value.trim());
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function buildDrafts(board: SlateBoard, review: ReviewModelPayload): Draft[] {
  const takes = new Map(review.take_groups.map((take) => [take.group_id, take]));
  const xmlOrderByGroup = new Map(review.take_groups.map((take, index) => [take.group_id, index]));
  const persisted = Object.values(board.records).map((record) => draftFromRecord(
    record,
    takes.get(record.source_group_id) ?? null,
    xmlOrderByGroup.get(record.source_group_id) ?? Number.MAX_SAFE_INTEGER,
  ));
  const represented = new Set(persisted.map((record) => record.source_group_id).filter(Boolean));
  const derived = review.take_groups
    .filter((take) => !represented.has(take.group_id))
    .map((take, index) => draftFromTake(review, take, xmlOrderByGroup.get(take.group_id) ?? index));
  return [...persisted, ...derived];
}

function isPlacedDraft(draft: Draft): boolean {
  return Boolean(draft.script_scene_id.trim() || draft.scene.trim());
}

function sceneOrderValue(draft: Draft): string {
  return draft.scene.trim() || draft.script_scene_id.trim();
}

function placedOrder(left: Draft, right: Draft): number {
  const leftEpisode = left.episode ?? Number.MAX_SAFE_INTEGER;
  const rightEpisode = right.episode ?? Number.MAX_SAFE_INTEGER;
  if (leftEpisode !== rightEpisode) return leftEpisode - rightEpisode;
  const scene = sceneOrderValue(left).localeCompare(sceneOrderValue(right), "zh-CN", { numeric: true });
  if (scene) return scene;
  const shot = left.shot.localeCompare(right.shot, "zh-CN", { numeric: true });
  if (shot) return shot;
  return (left.take_number ?? Number.MAX_SAFE_INTEGER) - (right.take_number ?? Number.MAX_SAFE_INTEGER) || left.xmlOrder - right.xmlOrder;
}

function displayOrder(rows: Draft[]): Draft[] {
  const placed = rows.filter(isPlacedDraft).slice().sort(placedOrder);
  const unplaced = rows.filter((row) => !isPlacedDraft(row)).slice().sort((left, right) => left.xmlOrder - right.xmlOrder);
  return [...placed, ...unplaced];
}

function orderRows(rows: Draft[], mode: SlateOrder): Draft[] {
  return mode === "shooting" ? rows.slice().sort((left, right) => left.xmlOrder - right.xmlOrder) : displayOrder(rows);
}

function recordPayload(draft: SlateRecord): Partial<SlateRecord> {
  return {
    source_group_id: draft.source_group_id,
    script_scene_id: draft.script_scene_id,
    episode: draft.episode,
    scene: draft.scene,
    shot: draft.shot,
    take_number: draft.take_number,
    status: draft.status,
    note: draft.note,
    ...(draft.usable_range ? { usable_range: draft.usable_range } : {}),
    preferred_clip_id: draft.preferred_clip_id,
    attachments: draft.attachments,
  };
}

function recordContents(record: SlateRecord | undefined): string | null {
  if (!record) return null;
  return JSON.stringify({
    ...recordPayload(record),
    usable_range: [record.usable_range?.start ?? null, record.usable_range?.end ?? null],
  });
}

function restoreDrafts(board: SlateBoard, review: ReviewModelPayload, pending: PendingSlateDrafts): DraftView {
  const remaining = new Map(pending);
  for (const [id, { row }] of pending) {
    // A write might have committed before a switch cancelled its response.
    if (recordContents(board.records[id]) === recordContents(row)) remaining.delete(id);
  }
  const groupsWithDrafts = new Set([...remaining.values()].map(({ row }) => row.source_group_id).filter(Boolean));
  const rows = buildDrafts(board, review).filter((row) => !row.derived || !groupsWithDrafts.has(row.source_group_id) || remaining.has(row.record_id));
  const projectedIds = new Set(rows.map((row) => row.record_id));
  return {
    board,
    rows: [
      ...rows.map((row) => {
        const local = remaining.get(row.record_id);
        return local ? { ...local.row, xmlOrder: row.xmlOrder } : row;
      }),
      ...[...remaining.values()].map(({ row }) => row).filter((row) => !projectedIds.has(row.record_id)),
    ],
    pending: remaining,
  };
}

function parsePrevious(draft: Draft): Partial<SlateEntry> {
  return {
    episode: draft.episode,
    scene: draft.scene,
    shot: draft.shot,
    take_number: draft.take_number,
    status: draft.status,
    note: draft.note,
  };
}

function cameraKey(value: string): string {
  return value.trim().toUpperCase().replace(/机/g, "");
}

function primaryAttachment(draft: Draft, camera: SlateCameraColumn, cameraColumns: readonly SlateCameraColumn[]): { item: SlateAttachment; count: number } | null {
  const rows = draft.attachments.filter((attachment) => {
    const key = cameraKey(attachment.camera);
    if (camera === "AUX") return key === "AUX" || !cameraColumns.includes(key) || attachment.source_role !== "sync_camera";
    return key === camera && attachment.source_role === "sync_camera";
  });
  return rows[0] ? { item: rows[0], count: rows.length } : null;
}

type DraftRowProps = {
  draft: Draft;
  rowNumber: number;
  selected: boolean;
  selectedClip?: string;
  cameraColumns: readonly SlateCameraColumn[];
  revealRow?: RefCallback<HTMLTableRowElement>;
  onEditStart: () => void;
  onEditEnd: () => void;
  onSelect: (recordId: string) => void;
  onPatch: (recordId: string, patch: Partial<Draft>) => void;
  onQuickParse: (recordId: string, text: string) => void | Promise<void>;
  mediaCell: (draft: Draft, camera: SlateCameraColumn, selectedClip?: string) => ReactNode;
};

const DraftSlateRow = memo(function DraftSlateRow({
  draft, rowNumber, selected, selectedClip, cameraColumns, revealRow, onEditStart, onEditEnd, onSelect, onPatch, onQuickParse, mediaCell,
}: DraftRowProps) {
  return (
    <SlateRow
      row={{
        recordId: draft.record_id, rowNumber, selected, dirty: draft.dirty, derivedSource: draft.derivedSource,
        episode: draft.episode, scene: draft.scene, shot: draft.shot, takeNumber: draft.take_number, status: draft.status, note: draft.note,
        mappedScenePlaceholder: !draft.scene && draft.script_scene_id ? prettySceneId(draft.script_scene_id) : "",
      }}
      rowRef={revealRow}
      cameraColumns={cameraColumns}
      onEditStart={onEditStart}
      onEditEnd={onEditEnd}
      onSelect={() => onSelect(draft.record_id)}
      onPatch={(patch) => onPatch(draft.record_id, patch)}
      onQuickParse={(text) => onQuickParse(draft.record_id, text)}
      renderMedia={(camera) => mediaCell(draft, camera, selectedClip)}
    />
  );
});

const ROW_HEIGHT = 105;
const OVERSCAN = 6;
const FALLBACK_VIEWPORT_HEIGHT = 720;

function VirtualizedSlateTbody({ rows, columns, active, revealId, renderRow }: {
  rows: Draft[];
  columns: number;
  active: boolean;
  revealId?: string;
  renderRow: (draft: Draft) => ReactNode;
}) {
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const [viewport, setViewport] = useState({ first: 0, last: Math.ceil(FALLBACK_VIEWPORT_HEIGHT / ROW_HEIGHT), rowHeight: ROW_HEIGHT });
  const rowHeightRef = useRef(ROW_HEIGHT);
  const syncWindow = useCallback((scroller: HTMLElement) => {
    const rowHeight = rowHeightRef.current;
    const height = scroller.clientHeight || FALLBACK_VIEWPORT_HEIGHT;
    const first = Math.max(0, Math.floor(scroller.scrollTop / rowHeight));
    const last = Math.ceil((Math.max(0, scroller.scrollTop) + height) / rowHeight);
    const body = bodyRef.current;
    const editor = document.activeElement;
    if (editor instanceof HTMLInputElement && body?.contains(editor)) {
      // Removing a focused input need not dispatch blur. Finish its pinned edit
      // before eviction, using the committed window and its leading spacer.
      const row = editor.closest("tr")!;
      const index = Number(body.dataset.startIndex) + row.sectionRowIndex - 1;
      if (index < first - OVERSCAN || index >= last + OVERSCAN) editor.blur();
    }
    setViewport(current => current.first === first && current.last === last && current.rowHeight === rowHeight
      ? current : { first, last, rowHeight });
  }, []);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    const scroller = body?.closest<HTMLElement>(".golden-slate-section-scroll");
    if (!active || !scroller || !body) return;
    let frame: number | undefined;
    let needsMeasurement = true;
    const update = () => {
      frame = undefined;
      if (needsMeasurement) {
        needsMeasurement = false;
        const mounted = body.querySelectorAll("tr.slate-row");
        if (mounted.length) {
          const first = mounted[0].getBoundingClientRect();
          const last = mounted[mounted.length - 1].getBoundingClientRect();
          const average = (last.bottom - first.top) / mounted.length;
          if (average > 0) rowHeightRef.current = average;
        }
      }
      syncWindow(scroller);
    };
    const schedule = () => { if (frame === undefined) frame = requestAnimationFrame(update); };
    const resized = () => { needsMeasurement = true; schedule(); };
    update();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resized) : undefined;
    observer?.observe(scroller);
    observer?.observe(body);
    scroller.addEventListener("scroll", schedule, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", schedule);
      observer?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [active, syncWindow]);

  // A source-sheet link can target an editor thousands of rows outside the DOM.
  useLayoutEffect(() => {
    if (!active || !revealId) return;
    const scroller = bodyRef.current?.closest<HTMLElement>(".golden-slate-section-scroll");
    const index = rows.findIndex(row => row.record_id === revealId);
    if (!scroller || index < 0) return;
    if (index < viewport.first - OVERSCAN || index >= viewport.last + OVERSCAN) {
      scroller.scrollTop = index * rowHeightRef.current;
      syncWindow(scroller);
    }
  }, [active, revealId, rows, syncWindow, viewport]);

  const startIndex = Math.max(0, Math.min(rows.length - 1, viewport.first) - OVERSCAN);
  const endIndex = Math.min(rows.length, viewport.last + OVERSCAN);
  function spacer(count: number) {
    return <tr className="slate-virtual-spacer" aria-hidden="true"><td colSpan={columns}><div style={{ height: count * viewport.rowHeight }} /></td></tr>;
  }
  return (
    <tbody ref={bodyRef} data-start-index={startIndex}>
      {spacer(startIndex)}
      {rows.slice(startIndex, endIndex).map(renderRow)}
      {spacer(rows.length - endIndex)}
    </tbody>
  );
}


export function GoldenSlateWorkbench({ baseUrl, projectId, projectName, draftSession, active = true, focus, onSelection, onOpenTake, onRepair, onInspectSelection, intervalLedger, enableNativeIntervalLedger=false }: Props) {
  const [slateSurface, setSlateSurface] = useState<"intervals" | "takes">("takes");
  const nativeIntervalLedger=useNativeSlateIntervalLedger(baseUrl,projectId,enableNativeIntervalLedger);
  const ledger = intervalLedger?.projectId === projectId ? intervalLedger : nativeIntervalLedger.ledger;
  const ledgerSurface=Boolean(ledger || nativeIntervalLedger.available);
  const intervalSurface = ledgerSurface && slateSurface === "intervals";
  const host = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const production = useMemo(() => new ProductionClient(baseUrl), [baseUrl]);
  const desktopClient = useMemo(() => new DesktopClient(baseUrl), [baseUrl]);
  const [clapperBusy, setClapperBusy] = useState(false);
  const records = useMemo(() => new SlateRecordClient(baseUrl), [baseUrl]);
  const slateMedia = useMemo(() => new SlateMediaClient(baseUrl), [baseUrl]);
  const [paperSource, setPaperSource] = useState<{row:PaperRow;revision:number}|null>(null);
  const [review, setReview] = useState<ReviewModelPayload | null>(null);
  const [draftView, renderDraftView] = useState<DraftView>(() => ({ board: null, rows: [], pending: draftSession?.read() ?? new Map() }));
  const draftViewRef = useRef(draftView);
  const { board, rows: drafts, pending } = draftView;
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const canUseSlate = useCallback(() => mounted.current && !draftSession?.signal.aborted, [draftSession]);
  const publishDraftView = useCallback((next: DraftView) => {
    if (!canUseSlate()) return;
    draftViewRef.current = next;
    draftSession?.write(next.pending);
    renderDraftView(next);
  }, [canUseSlate, draftSession]);

  const setDrafts = useCallback((update: (current: Draft[]) => Draft[]): void => {
    if (!canUseSlate()) return;
    const current = draftViewRef.current;
    const rows = update(current.rows);
    const nextPending = new Map(current.pending);
    for (const row of current.rows) {
      if (row.dirty) nextPending.delete(row.record_id);
    }
    for (const row of rows) {
      if (!row.dirty) continue;
      const prior = current.pending.get(row.record_id);
      nextPending.set(row.record_id, {
        row,
        baseline: prior ? prior.baseline : recordContents(current.board?.records[row.record_id]),
      });
    }
    publishDraftView({ ...current, rows, pending: nextPending });
  }, [canUseSlate, publishDraftView]);
  // Keep the actual unsaved values live for Save, but do not move an editor
  // between table parents until focus leaves the row (or Enter completes it).
  const [editLayout, setEditLayout] = useState<Map<string, { index: number; placed: boolean }> | null>(null);
  const [selectedRecordId, setSelectedRecordId] = useState("");
  const [selectedClipId, setSelectedClipId] = useState("");
  const [actor, setActor] = useState(readCurrentOperator);
  const [message, setMessage] = useState("正在读取多机位电子场记…");
  const [busy, setBusy] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [advancedToolsOpen, setAdvancedToolsOpen] = useState(false);
  const [showAuxColumn, setShowAuxColumn] = useState(false);
  const [hideNgRows, setHideNgRows] = useState(false);
  const [orderMode, setOrderMode] = useState<SlateOrder>("shooting");
  const [paperIntakeOpen, setPaperIntakeOpen] = useState(false);
  const [quickLookOpen, setQuickLookOpen] = useState(false);
  const quickLookFocusRef = useRef<HTMLElement | null>(null);
  const quickLookCloseRef = useRef<HTMLButtonElement | null>(null);
  const quickLookInspectorRef = useRef(true);
  const [videoGeometry, setVideoGeometry] = useState<{ key: string; aspect: number } | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [takePickerOpen, setTakePickerOpen] = useState(false);
  const [takeSearch, setTakeSearch] = useState("");
  const takePickerRef = useRef<HTMLElement | null>(null);
  const takePickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [playbackFailedClipId, setPlaybackFailedClipId] = useState("");
  const [playbackRetry, setPlaybackRetry] = useState(0);
  const [playbackFailureDetail, setPlaybackFailureDetail] = useState<PlaybackFailure | null>(null);
  const slateRef = useRef<HTMLDivElement>(null);
  const appliedFocus = useRef<ProductionSelectionContext | null>(null);
  const [locatedRange, setLocatedRange] = useState<{ recordId: string; clipId: string; start: number } | null>(null);
  const playerRef = useRef<HTMLVideoElement | null>(null);
  const [sourceEditorFocus, setSourceEditorFocus] = useState<{ recordId: string; field?: "scene" | "shot" | "take" | "note" } | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem(SLATE_COLUMN_WIDTHS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value > 0)) as Record<string, number>;
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try { localStorage.setItem(SLATE_COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(columnWidths)); } catch { /* local persistence is best effort */ }
  }, [columnWidths]);
  const productionRows = useMemo(() => {
    const groups = new Map<string, Draft>();
    const ambiguous = new Set<string>();
    for (const row of drafts) {
      if (!row.source_group_id) continue;
      if (groups.has(row.source_group_id)) ambiguous.add(row.source_group_id);
      groups.set(row.source_group_id, row);
    }
    for (const group of ambiguous) groups.delete(group);
    return groups;
  }, [drafts]);
  const openProductionSource = useCallback((target: ProductionSlateTarget) => {
    const row = productionRows.get(target.groupId);
    if (!row) return;
    const take = review?.take_groups.find(item => item.group_id === target.groupId);
    const exact = target.clipId && target.mediaId
      ? take?.angles.find(angle => angle.clip_id === target.clipId && angle.media_id === target.mediaId)
      : undefined;
    const attachment = exact && row.attachments.find(item => item.clip_id === exact.clip_id && item.media_id === exact.media_id);
    if ((target.clipId || target.mediaId) && !attachment) return;
    const clip = attachment ? attachmentKey(attachment) : row.preferred_clip_id || (row.attachments[0] ? attachmentKey(row.attachments[0]) : "");
    setSelectedRecordId(row.record_id);
    setSelectedClipId(clip);
    setLocatedRange(attachment && target.sourceTime !== undefined && Number.isFinite(target.sourceTime) && target.sourceTime >= 0
      ? { recordId: row.record_id, clipId: clip, start: target.sourceTime } : null);
    setPlaybackFailedClipId("");
    setPlaybackRetry(0);
    setInspectorOpen(true);
    setSlateSurface("takes");
    setSourceEditorFocus({ recordId: row.record_id, field: target.field });
  }, [productionRows, review]);

  const revealRow = useCallback((row: HTMLTableRowElement | null) => {
    if (!row || !sourceEditorFocus) return;
    if (sourceEditorFocus.field) {
      if (sourceEditorFocus.field === "note") {
        row.querySelector<HTMLInputElement>("td.col-note input")?.focus({ preventScroll: true });
      } else {
        const index = { scene: 1, shot: 2, take: 3 }[sourceEditorFocus.field];
        row.querySelectorAll<HTMLInputElement>("input")[index]?.focus({ preventScroll: true });
      }
    }
    row.scrollIntoView?.({ block: "nearest" });
    setSourceEditorFocus(null);
  }, [sourceEditorFocus]);

  useEffect(() => {
    const syncOperator = (event: Event) => {
      const next = event instanceof CustomEvent && typeof event.detail === "string" ? event.detail : readCurrentOperator();
      setActor(next);
    };
    globalThis.addEventListener("mirrororder:operator-change", syncOperator);
    globalThis.addEventListener("storage", syncOperator);
    return () => {
      globalThis.removeEventListener("mirrororder:operator-change", syncOperator);
      globalThis.removeEventListener("storage", syncOperator);
    };
  }, []);

  async function reload(preferredRecordId?: string): Promise<void> {
    if (!canUseSlate()) return;
    const beforeRead = draftViewRef.current.board;
    setMessage("正在读取多机位电子场记…");
    try {
      const [nextReview, nextBoard] = await Promise.all([host.refreshReviewModel(projectId), production.scriptSupervisor(projectId)]);
      if (!canUseSlate() || draftViewRef.current.board !== beforeRead) return;
      const fresh = restoreDrafts(nextBoard, nextReview, draftViewRef.current.pending);
      const nextDrafts = fresh.rows;
      const nextSelected = preferredRecordId && nextDrafts.some((row) => row.record_id === preferredRecordId)
        ? preferredRecordId
        : nextDrafts.some((row) => row.record_id === selectedRecordId)
          ? selectedRecordId
          : nextDrafts.find((row) => !isPlacedDraft(row))?.record_id ?? nextDrafts[0]?.record_id ?? "";
      setReview(nextReview);
      publishDraftView(fresh);
      setSelectedRecordId(nextSelected);
      const selected = nextDrafts.find((row) => row.record_id === nextSelected) ?? null;
      setSelectedClipId(selected?.preferred_clip_id || (selected?.attachments[0] ? attachmentKey(selected.attachments[0]) : ""));
      setPlaybackFailedClipId("");
      setPlaybackRetry(0);
      setMessage("已刷新");
    } catch (error) {
      if (canUseSlate()) setMessage(`刷新失败：${errorMessage(error)}`);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setEditLayout(null);
    Promise.all([host.reviewModel(projectId), production.scriptSupervisor(projectId)])
      .then(([nextReview, nextBoard]) => {
        if (cancelled || !canUseSlate()) return;
        const fresh = restoreDrafts(nextBoard, nextReview, draftViewRef.current.pending);
        const nextDrafts = fresh.rows;
        setReview(nextReview);
        publishDraftView(fresh);
        const first = nextDrafts.find((row) => row.dirty) ?? nextDrafts.find((row) => !isPlacedDraft(row)) ?? nextDrafts[0] ?? null;
        setSelectedRecordId(first?.record_id ?? "");
        setSelectedClipId(first?.preferred_clip_id || (first?.attachments[0] ? attachmentKey(first.attachments[0]) : ""));
        setMessage("");
      })
      .catch((error) => { if (!cancelled) setMessage(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [host, production, projectId, canUseSlate, publishDraftView]);

  useEffect(() => {
    if (!active) slateRef.current?.querySelectorAll("video, audio").forEach((node) => (node as HTMLMediaElement).pause());
  }, [active]);

  useEffect(() => {
    if (!focus || !board || focus === appliedFocus.current || focus.projectId !== projectId || !active) return;
    const row = drafts.find((draft) => {
      if (focus.recordId && draft.record_id === focus.recordId) return true;
      if (focus.groupId && draft.source_group_id === focus.groupId) return true;
      return Boolean(focus.clipId && draft.attachments.some((attachment) => attachment.clip_id === focus.clipId));
    });
    if (!row) return;
    appliedFocus.current = focus;
    const attachment = row.attachments.find((item) => (!focus.clipId || focus.clipId === item.clip_id)
      && (!focus.mediaId || focus.mediaId === item.media_id));
    const clip = attachment ? attachmentKey(attachment) : row.preferred_clip_id || (row.attachments[0] ? attachmentKey(row.attachments[0]) : "");
    setSlateSurface("takes");
    setInspectorOpen(true);
    setSelectedRecordId(row.record_id);
    setSelectedClipId(clip);
    setLocatedRange(focus.sourceRange?.basis === "source" && attachment
      ? { recordId: row.record_id, clipId: clip, start: focus.sourceRange.start } : null);
    setSourceEditorFocus({ recordId: row.record_id });
  }, [focus, board, drafts, projectId, active]);

  const hasAuxMedia = useMemo(() => {
    const attachmentNeedsAux = drafts.some((draft) => draft.attachments.some((attachment) => {
      const key = cameraKey(attachment.camera);
      return key === "AUX" || attachment.source_role !== "sync_camera" || !/^[A-Z]$/.test(key);
    }));
    const angleNeedsAux = (review?.take_groups ?? []).some((take) => take.angles.some((angle) => {
      const key = cameraKey(angle.camera);
      const sourceRole = angle.coverage_role || "sync_camera";
      return key === "AUX" || sourceRole !== "sync_camera" || !/^[A-Z]$/.test(key);
    }));
    return attachmentNeedsAux || angleNeedsAux;
  }, [drafts, review]);
  const cameraColumns = useMemo(() => {
    const cameras = new Set<string>(SLATE_CAMERA_COLUMNS.filter(camera => camera !== "AUX"));
    for (const take of review?.take_groups ?? []) {
      for (const angle of take.angles) {
        const camera = cameraKey(angle.camera);
        if (/^[A-Z]$/.test(camera)) cameras.add(camera);
      }
    }
    for (const draft of drafts) {
      for (const attachment of draft.attachments ?? []) {
        const camera = cameraKey(attachment.camera);
        if (attachment.source_role === "sync_camera" && /^[A-Z]$/.test(camera)) cameras.add(camera);
      }
    }
    return [...cameras].sort().concat(hasAuxMedia || showAuxColumn ? ["AUX"] : []);
  }, [drafts, hasAuxMedia, review, showAuxColumn]);
  const selected = drafts.find((row) => row.record_id === selectedRecordId) ?? null;
  const selectedTake = selected?.source_group_id ? review?.take_groups.find((take) => take.group_id === selected.source_group_id) ?? null : null;
  const inspectorLinkage = selected && (
    Boolean(selectedTake)
    || Boolean(selected.script_scene_id.trim())
    || Boolean(selectedTake?.transcript.text.trim())
  );
  const selectedAttachment = selected?.attachments.find((item) => attachmentKey(item) === selectedClipId) ?? null;
  // 1500-Take 渲染预算：displayOrder/索引只随输入重建，行渲染一律 O(1) 查表。
  const angleIndex = useMemo(() => {
    const byClip = new Map<string, ReviewAngle>();
    const byMedia = new Map<string, ReviewAngle>();
    const byIdentity = new Map<string, ReviewAngle>();
    for (const take of review?.take_groups ?? []) {
      for (const angle of take.angles) {
        if (angle.clip_id && !byClip.has(angle.clip_id)) byClip.set(angle.clip_id, angle);
        if (angle.media_id && !byMedia.has(angle.media_id)) byMedia.set(angle.media_id, angle);
        const identity = JSON.stringify([angle.clip_id, angle.media_id]);
        if (!byIdentity.has(identity)) byIdentity.set(identity, angle);
      }
    }
    return { byClip, byMedia, byIdentity };
  }, [review]);
  const selectedAngle = selectedAttachment
    ? selectedTake?.angles.find(angle => angle.clip_id === selectedAttachment.clip_id && angle.media_id === selectedAttachment.media_id)
      ?? angleIndex.byIdentity.get(JSON.stringify([selectedAttachment.clip_id, selectedAttachment.media_id]))
      ?? null
    : angleIndex.byClip.get(selectedClipId) ?? null;
  const selectedFilename = selectedAttachment?.display_name || selectedAngle?.name || "";
  const selectedPlaybackKey = selectedAngle?.clip_id || selectedClipId;
  const clipId = selectedAttachment?.clip_id || selectedAngle?.clip_id || undefined;
  const mediaId = selectedAttachment?.media_id || selectedAngle?.media_id || undefined;
  // A manually attached insert can belong to another Take.
  const inTake = selectedTake?.angles.some(angle => (!clipId || angle.clip_id === clipId) && (!mediaId || angle.media_id === mediaId));
  const groupId = inTake || (!clipId && !mediaId) ? selected?.source_group_id || undefined : undefined;
  const recordId = selected?.record_id;
  const selection = useMemo(() => ({ projectId, recordId, groupId, clipId, mediaId }), [projectId, recordId, groupId, clipId, mediaId]);
  useLayoutEffect(() => {
    if (!active || intervalSurface) return;
    onInspectSelection?.({ group_id: selection.groupId, clip_id: selection.clipId, media_id: selection.mediaId });
    if (selection.recordId) onSelection?.(selection);
  }, [active, intervalSurface, onInspectSelection, onSelection, selection]);
  const selectedPlaybackFailed = Boolean(selectedPlaybackKey && playbackFailedClipId === selectedPlaybackKey);
  const standaloneUrl = selectedAttachment?.clip_id && selectedAttachment.media_id && !selectedAngle
    ? originalPlaybackUrl(baseUrl, projectId, { clipId: selectedAttachment.clip_id, mediaId: selectedAttachment.media_id, selectionKey: selectedPlaybackKey })
    : null;
  const playbackUrl = (selectedAngle?.playback.url && canPreviewReviewPlayback(selectedAngle.playback) ? selectedAngle.playback.url : null) || standaloneUrl;
  const playbackStart = locatedRange && locatedRange.recordId === selectedRecordId && locatedRange.clipId === selectedClipId
    ? locatedRange.start : selectedAngle?.playback.source_start ?? selectedAngle?.source_start ?? 0;
  const playbackKey = `${selectedPlaybackKey}-${playbackRetry}-${playbackStart}`;
  const videoAspect = videoGeometry?.key === playbackKey ? videoGeometry.aspect : 16 / 9;

  function closeQuickLook(restoreFocus = true): void {
    setQuickLookOpen(false);
    setInspectorOpen(quickLookInspectorRef.current);
    if (restoreFocus && quickLookFocusRef.current?.isConnected) quickLookFocusRef.current.focus({ preventScroll: true });
  }

  function toggleQuickLook(): void {
    if (quickLookOpen) { closeQuickLook(); return; }
    if (!active || intervalSurface || !playbackUrl) return;
    quickLookFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    quickLookInspectorRef.current = inspectorOpen;
    setInspectorOpen(true);
    setQuickLookOpen(true);
  }

  function updateVideoGeometry(video: HTMLVideoElement): void {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      setVideoGeometry({ key: playbackKey, aspect: video.videoWidth / video.videoHeight });
    }
  }

  useLayoutEffect(() => {
    if (quickLookOpen) quickLookCloseRef.current?.focus({ preventScroll: true });
  }, [quickLookOpen]);

  useEffect(() => {
    if (!active || intervalSurface || !inspectorOpen) playerRef.current?.pause();
    if (quickLookOpen && (!active || intervalSurface || !inspectorOpen || !playbackUrl)) closeQuickLook(false);
  }, [active, intervalSurface, inspectorOpen, playbackUrl, quickLookOpen]);

  useEffect(() => {
    const player = playerRef.current;
    const pauseHidden = () => { if (document.hidden) player?.pause(); };
    document.addEventListener("visibilitychange", pauseHidden);
    return () => {
      document.removeEventListener("visibilitychange", pauseHidden);
      player?.pause();
    };
  }, [playbackKey]);

  function currentLocation(): ProductionSelectionContext {
    const player = playerRef.current;
    const start = player && player.readyState >= 1 ? player.currentTime : playbackStart;
    if (!playbackUrl || !selection.clipId || !Number.isFinite(start) || start < 0) return selection;
    return { ...selection, sourceRange: { basis: "source", start } };
  }

  function publishPlaybackLocation(): void {
    if (active && !intervalSurface) onSelection?.(currentLocation());
  }

  useEffect(() => {
    if (!selectedPlaybackFailed) setPlaybackFailureDetail(null);
  }, [selectedPlaybackFailed]);
  const selectedPersisted = Boolean(selected && board?.records[selected.record_id]);
  const selectedCanDelete = Boolean(selected && (selectedPersisted || !selected.derived));
  const dirtyCount = pending.size;
  const draftConflicts = useMemo(() => {
    const ids = new Set<string>();
    if (!board || !pending.size) return ids;
    const savedGroups = new Set(Object.values(board.records).map((row) => row.source_group_id).filter(Boolean));
    for (const [id, { row, baseline }] of pending) {
      const saved = board.records[id];
      if (baseline !== recordContents(saved) || (!saved && savedGroups.has(row.source_group_id))) ids.add(id);
    }
    return ids;
  }, [board, pending]);
  const selectedConflict = Boolean(selected && draftConflicts.has(selected.record_id));
  const selectedServerRecord = selectedConflict && selected ? board?.records[selected.record_id] : undefined;
  const ngCount = useMemo(() => drafts.filter((row) => row.status === "ng").length, [drafts]);
  const displayedDrafts = useMemo(() => {
    const ordered = orderRows(hideNgRows ? drafts.filter((row) => row.status !== "ng") : drafts, orderMode);
    if (!editLayout) return ordered;
    ordered.sort((a, b) => (editLayout.get(a.record_id)?.index ?? Number.MAX_SAFE_INTEGER)
      - (editLayout.get(b.record_id)?.index ?? Number.MAX_SAFE_INTEGER));
    // The split tables render placed rows before unplaced rows, including rows
    // added while an editor has pinned the existing layout.
    const placed = (row: Draft) => editLayout.get(row.record_id)?.placed ?? isPlacedDraft(row);
    return orderMode === "shooting" ? ordered : [...ordered.filter(placed), ...ordered.filter(row => !placed(row))];
  }, [drafts, editLayout, hideNgRows, orderMode]);
  const displayIndexByRecord = useMemo(
    () => new Map(displayedDrafts.map((row, index) => [row.record_id, index])),
    [displayedDrafts],
  );
  const placedDrafts = useMemo(() => displayedDrafts.filter((row) => editLayout?.get(row.record_id)?.placed ?? isPlacedDraft(row)), [displayedDrafts, editLayout]);
  const unplacedDrafts = useMemo(() => displayedDrafts.filter((row) => !(editLayout?.get(row.record_id)?.placed ?? isPlacedDraft(row))), [displayedDrafts, editLayout]);
  const usedTakeIds = useMemo(() => new Set(drafts.filter((row) => !row.derived && row.source_group_id).map((row) => row.source_group_id)), [drafts]);
  const takeCandidates = useMemo(() => {
    const query = takeSearch.trim().toLowerCase();
    return (review?.take_groups ?? []).filter((take) => {
      if (!query) return true;
      const text = [take.group_id, `T${take.take_index}`, take.transcript.text, ...take.angles.flatMap((angle) => [angle.camera, angle.name])].join(" ").toLowerCase();
      return text.includes(query);
    });
  }, [review, takeSearch]);
  const episodeCandidates = useMemo(() => {
    if (!review || !selected?.episode || selected.attachments.length) return [];
    return review.take_groups
      .filter((take) => !usedTakeIds.has(take.group_id) && takeMatchesEpisode(take, selected.episode as number))
      .slice(0, 10);
  }, [review, selected, usedTakeIds]);

  useEffect(() => {
    if (!selected) return;
    if (selectedClipId && selected.attachments.some((item) => attachmentKey(item) === selectedClipId)) return;
    setSelectedClipId(selected.preferred_clip_id || (selected.attachments[0] ? attachmentKey(selected.attachments[0]) : ""));
  }, [selected, selectedClipId]);

  const patchRecord = useCallback((recordId: string, patch: Partial<Draft>): void => {
    setDrafts((current) => current.map((row) => row.record_id === recordId ? { ...row, ...patch, dirty: true, derived: false, derivedSource: "" } : row));
  }, [setDrafts]);

  const resizeColumn = useCallback((columnKey: string, width: number): void => {
    setColumnWidths((current) => ({ ...current, [columnKey]: width }));
  }, []);

  const resetColumnWidth = useCallback((columnKey: string): void => {
    setColumnWidths((current) => {
      const next = { ...current };
      delete next[columnKey];
      return next;
    });
  }, []);

  function patchAttachment(recordId: string, key: string, patch: Partial<SlateAttachment>): void {
    setDrafts((current) => current.map((row) => row.record_id === recordId ? {
      ...row,
      attachments: row.attachments.map((attachment) => attachmentKey(attachment) === key ? { ...attachment, ...patch } : attachment),
      dirty: true,
      derived: false,
      derivedSource: "",
    } : row));
  }

  function removeAttachment(recordId: string, key: string): void {
    setDrafts((current) => current.map((row) => row.record_id === recordId ? {
      ...row,
      attachments: row.attachments.filter((attachment) => attachmentKey(attachment) !== key),
      preferred_clip_id: row.preferred_clip_id === key ? "" : row.preferred_clip_id,
      dirty: true,
      derived: false,
      derivedSource: "",
    } : row));
    if (selectedClipId === key) setSelectedClipId("");
  }

  const selectRecord = useCallback((recordId: string): void => {
    const row = draftViewRef.current.rows.find((item) => item.record_id === recordId);
    setSelectedRecordId(recordId);
    setSelectedClipId(row?.preferred_clip_id || (row?.attachments[0] ? attachmentKey(row.attachments[0]) : ""));
    setPlaybackFailedClipId("");
    setPlaybackRetry(0);
  }, []);

  const selectClip = useCallback(function selectClip(clipId: string): void {
    setSelectedClipId(clipId);
    setPlaybackFailedClipId("");
    setPlaybackRetry(0);
  }, []);

  function addBlank(seed?: Partial<Draft>): Draft {
    const row = blankDraft(seed);
    setDrafts((current) => [...current, row]);
    setSelectedRecordId(row.record_id);
    setSelectedClipId("");
    setMessage("已新增空白场记；保存后才写入项目。");
    return row;
  }

  function applyPaperDraftCandidates(candidates: PaperVlmCandidate[]): void {
    const created = candidates.map((candidate) => blankDraft({
      episode: candidate.episode,
      scene: candidate.scene,
      shot: candidate.shot,
      take_number: parseTakeNumber(candidate.take),
      status: candidate.status,
      note: candidate.note,
    }));
    if (!created.length) {
      setPaperIntakeOpen(false);
      return;
    }
    setDrafts((current) => [...current, ...created]);
    setSelectedRecordId(created[0].record_id);
    setSelectedClipId("");
    setMessage("已填入 " + created.length + " 条未保存草稿；请核对后点击右上角「保存」。");
    setPaperIntakeOpen(false);
  }

  function nextSameScene(): void {
    addBlank({
      episode: selected?.episode ?? null,
      script_scene_id: selected?.script_scene_id ?? "",
      scene: selected?.scene ?? "",
      shot: selected?.shot ?? "",
      take_number: selected?.take_number ? selected.take_number + 1 : null,
    });
  }

  function inheritPrevious(): void {
    const visualIndex = selected ? displayedDrafts.findIndex((row) => row.record_id === selected.record_id) : displayedDrafts.length;
    const previous = visualIndex > 0 ? displayedDrafts[visualIndex - 1] : null;
    if (!previous) {
      setMessage("当前没有上一条场记可沿用。");
      return;
    }
    if (!selected) {
      addBlank({ episode: previous.episode, script_scene_id: previous.script_scene_id, scene: previous.scene, shot: previous.shot, status: previous.status });
      return;
    }
    patchRecord(selected.record_id, { episode: previous.episode, script_scene_id: previous.script_scene_id, scene: previous.scene, shot: previous.shot, status: previous.status });
    setMessage("已沿用屏幕上一条的集 / 场 / 镜 / 剧本场景 / 状态；素材与 I/O 未复制。");
  }

  async function detectClapperboardFrame(): Promise<void> {
    if (!canUseSlate() || !selected || !clipId || clapperBusy) return;
    setClapperBusy(true);
    setMessage("正在抽取片头打板帧并调用视觉模型识别（仅生成草稿提案，不自动保存）…");
    try {
      const proposal = await desktopClient.detectClapperboard(projectId, clipId);
      if (!proposal.detected) {
        setMessage(proposal.warning || `已检视片头 ${proposal.frames_inspected} 帧，未发现清晰场记板，未修改当前草稿。`);
        return;
      }
      const patch: Partial<Draft> = {};
      if (proposal.episode) patch.episode = proposal.episode;
      if (proposal.scene) patch.scene = proposal.scene;
      if (proposal.shot) patch.shot = proposal.shot;
      const takeMatch = proposal.take.match(/\d+/);
      if (takeMatch) patch.take_number = Number(takeMatch[0]);
      if (proposal.slate_note) {
        patch.note = selected.note ? `${selected.note} · [打板] ${proposal.slate_note}` : `[打板] ${proposal.slate_note}`;
      }
      if (Object.keys(patch).length > 0) {
        patchRecord(selected.record_id, patch);
        setMessage(`AI (${proposal.provider}/${proposal.model}) 识别到打板信息并填入未保存草稿，请核对后点击保存。`);
      } else {
        setMessage(proposal.warning || "识别到打板画面但未能提取有效场/镜/次号，请人工录入。");
      }
    } catch (error) {
      setMessage(`打板帧识别失败：${errorMessage(error)}`);
    } finally {
      setClapperBusy(false);
    }
  }

  function addTake(take: ReviewTakeGroup): void {
    const existing = drafts.find((row) => row.source_group_id === take.group_id);
    const attachments = take.angles.map(attachmentFromAngle);
    const mapped = review ? mappedScene(review, take) : null;
    const episode = review ? derivedEpisode(take, mapped) : take.effective_mapping.episode_ids[0] ?? null;

    if (selected && !selected.source_group_id && selected.attachments.length === 0) {
      setDrafts((current) => current
        .filter((row) => row.record_id === selected.record_id || row.source_group_id !== take.group_id)
        .map((row) => row.record_id === selected.record_id ? {
          ...row,
          source_group_id: take.group_id,
          take_number: take.take_index || null,
          episode: row.episode ?? episode,
          script_scene_id: row.script_scene_id || mapped?.sceneId || "",
          attachments,
          dirty: true,
          derived: false,
          derivedSource: "",
        } : row));
      setSelectedClipId(attachments[0] ? attachmentKey(attachments[0]) : "");
      setTakePickerOpen(false);
      setTakeSearch("");
      setMessage(`已把 T${take.take_index} 填入当前场记 · ${take.angles.length} 机位；保存后才写入项目。`);
      return;
    }

    if (existing) {
      selectRecord(existing.record_id);
      setTakePickerOpen(false);
      setTakeSearch("");
      setMessage(existing.derived
        ? `已选中 T${take.take_index}；编辑后保存即可成为人工场记。`
        : `T${take.take_index} 已在场记中，已定位现有记录。`);
      return;
    }

    addBlank({
      source_group_id: take.group_id,
      episode: episode ?? selected?.episode ?? null,
      script_scene_id: mapped?.sceneId ?? "",
      scene: selected?.scene ?? "",
      shot: selected?.shot ?? "",
      take_number: take.take_index || null,
      attachments,
    });
    setTakePickerOpen(false);
    setTakeSearch("");
    setMessage(`已加入 T${take.take_index} · ${take.angles.length} 机位；保存后才写入项目。`);
  }

  function attachResolvedMedia(items: SlateResolvedMediaItem[]): void {
    if (!items.length) return;
    const additions = items.map(attachmentFromResolved);
    if (selectedRecordId) {
      setDrafts((current) => current.map((row) => row.record_id === selectedRecordId ? {
        ...row,
        attachments: mergeAttachments(row.attachments, additions),
        dirty: true,
        derived: false,
        derivedSource: "",
      } : row));
      setSelectedClipId(attachmentKey(additions[0]));
    } else {
      const row = blankDraft({ attachments: additions });
      setDrafts((current) => [...current, row]);
      setSelectedRecordId(row.record_id);
      setSelectedClipId(attachmentKey(additions[0]));
    }
  }

  useEffect(() => {
    if (!active || !isTauri() || intervalSurface) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") { setDropActive(true); return; }
      if (event.payload.type === "leave") { setDropActive(false); return; }
      if (event.payload.type !== "drop") return;
      setDropActive(false);
      const paths = event.payload.paths;
      if (!paths.length || !canUseSlate()) return;
      setBusy(true);
      setMessage(`正在解析 ${paths.length} 个 Finder / Explorer 素材…`);
      void slateMedia.resolveDrop(projectId, paths).then((payload) => {
        if (disposed) return;
        attachResolvedMedia(payload.items);
        const suffix = payload.errors.length ? ` · ${payload.errors.length} 个文件未加入` : "";
        setMessage(`已把 ${payload.items.length} 个素材加入当前场记行${suffix}；保存后才写入项目。`);
      }).catch((error) => {
        if (!disposed) setMessage(errorMessage(error));
      }).finally(() => {
        if (!disposed) setBusy(false);
      });
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch((error) => {
      if (!disposed) setMessage(`无法启用 Finder 拖入：${errorMessage(error)}`);
    });
    return () => { disposed = true; unlisten?.(); };
  }, [projectId, selectedRecordId, slateMedia, intervalSurface, active, canUseSlate]);

  async function saveDraft(draft: Draft, revision: number): Promise<SlateBoard> {
    if (!canUseSlate()) throw new HostConnectionError("工作区正在切换，未发送场记写入");
    if (!actor.trim()) throw new HostConnectionError("保存场记前需要操作者昵称");
    return await records.upsert(projectId, {
      recordId: draft.record_id,
      expectedRevision: revision,
      expectedWorkspaceId: draftSession?.workspaceId,
      signal: draftSession?.signal,
      actor,
      record: recordPayload(draft),
    });
  }

  function acceptSavedDrafts(nextBoard: SlateBoard, submitted: ReadonlyMap<string, Draft>): void {
    if (!canUseSlate()) return;
    const current = draftViewRef.current;
    const nextPending = new Map(current.pending);
    const rows = current.rows.map((row) => {
      const sent = submitted.get(row.record_id);
      if (!sent) return row;
      const saved = nextBoard.records[row.record_id];
      if (row !== sent) {
        // Typing can continue during Save. Acknowledging an older edit must
        // not clear further edits that already exist in the editor.
        if (row.dirty) nextPending.set(row.record_id, { row, baseline: recordContents(saved) });
        return row;
      }
      nextPending.delete(row.record_id);
      return saved
        ? draftFromRecord(saved, review?.take_groups.find((take) => take.group_id === saved.source_group_id) ?? null, row.xmlOrder)
        : { ...row, dirty: false, derived: false, derivedSource: "" };
    });
    publishDraftView({ board: nextBoard, rows, pending: nextPending });
  }

  async function saveSelected(): Promise<void> {
    if (!canUseSlate() || !selected?.dirty || !board || busy) return;
    if (selectedConflict && (!selectedPersisted
      || !globalThis.confirm("用当前草稿覆盖下方所示的服务端场记？整行字段会以草稿为准。"))) return;
    setBusy(true);
    setMessage("正在保存当前场记…");
    try {
      const next = await saveDraft(selected, board.revision);
      if (!canUseSlate()) return;
      acceptSavedDrafts(next, new Map([[selected.record_id, selected]]));
      setMessage("已保存");
    } catch (error) {
      if (canUseSlate()) setMessage(errorMessage(error).includes("revision") ? `${errorMessage(error)}；请刷新后核对草稿。` : errorMessage(error));
    } finally { if (canUseSlate()) setBusy(false); }
  }

  async function saveAll(): Promise<void> {
    if (!canUseSlate() || !board || busy || draftConflicts.size) return;
    const toSave = draftViewRef.current.rows.filter((row) => row.dirty);
    if (!toSave.length) { setMessage("没有待保存修改。"); return; }
    if (!actor.trim()) { setMessage("保存场记前需要操作者昵称。"); return; }
    setBusy(true);
    setMessage(`正在顺序保存 ${toSave.length} 行…`);
    let nextBoard = board;
    const submitted = new Map<string, Draft>();
    try {
      for (const row of toSave) {
        nextBoard = await saveDraft(row, nextBoard.revision);
        if (!canUseSlate()) return;
        submitted.set(row.record_id, row);
      }
      setMessage("全部保存完成");
    } catch (error) {
      if (canUseSlate()) setMessage(`${errorMessage(error)}；顺序保存已停止，未执行的行保持未保存。`);
    } finally {
      if (canUseSlate()) {
        if (submitted.size) acceptSavedDrafts(nextBoard, submitted);
        setBusy(false);
      }
    }
  }

  function discardConflictingDraft(): void {
    if (!canUseSlate() || !selectedConflict || !selected || !review || !board || busy) return;
    if (!globalThis.confirm("放弃这条未保存的草稿？")) return;
    const remaining = new Map(draftViewRef.current.pending);
    remaining.delete(selected.record_id);
    const fresh = restoreDrafts(board, review, remaining);
    publishDraftView(fresh);
    if (!fresh.rows.some((row) => row.record_id === selected.record_id)) {
      setSelectedRecordId(orderRows(fresh.rows, orderMode)[0]?.record_id ?? "");
    }
    setMessage("已放弃这条草稿。");
  }

  async function deleteSelected(): Promise<void> {
    if (!canUseSlate() || !selected || !board || busy || selectedConflict) return;
    const persisted = Boolean(board.records[selected.record_id]);
    if (!persisted && selected.derived) {
      setMessage("自动派生场记来自 Review Take，不能在这里删除；请在审阅工作区处理排除。");
      return;
    }
    const visualIndex = displayedDrafts.findIndex((row) => row.record_id === selected.record_id);
    if (!persisted) {
      const fallback = displayedDrafts[visualIndex + 1] ?? displayedDrafts[visualIndex - 1] ?? null;
      setDrafts((current) => current.filter((row) => row.record_id !== selected.record_id));
      setSelectedRecordId(fallback?.record_id ?? "");
      setMessage("已移除尚未保存的场记草稿；Review Take 本身没有删除。");
      return;
    }
    if (!actor.trim()) { setMessage("删除场记前需要操作者昵称。"); return; }
    setBusy(true);
    try {
      const next = await records.delete(projectId, {
        recordId: selected.record_id,
        expectedRevision: board.revision,
        expectedWorkspaceId: draftSession?.workspaceId,
        signal: draftSession?.signal,
        actor,
      });
      if (!canUseSlate()) return;
      if (review) {
        const remaining = new Map(draftViewRef.current.pending);
        remaining.delete(selected.record_id);
        const fresh = restoreDrafts(next, review, remaining);
        const orderedNext = orderRows(fresh.rows, orderMode);
        publishDraftView(fresh);
        setSelectedRecordId(orderedNext[Math.min(Math.max(visualIndex, 0), Math.max(0, orderedNext.length - 1))]?.record_id ?? "");
      }
      setMessage("已删除人工场记记录（原素材未删除）");
    } catch (error) { if (canUseSlate()) setMessage(errorMessage(error)); }
    finally { if (canUseSlate()) setBusy(false); }
  }

  async function requestDeleteSelected(): Promise<void> {
    if (!canUseSlate() || !selected || !board || busy || selectedConflict) return;
    const persisted = Boolean(board.records[selected.record_id]);
    if (!persisted && selected.derived) {
      setMessage("自动派生场记来自 Review Take，不能在这里删除；请在审阅工作区处理排除。");
      return;
    }
    const prompt = persisted
      ? "删除这条人工场记记录？关联 Take 不会被删除；如果 Review 中仍有这个 Take，它会继续作为派生候选出现。"
      : "移除这条尚未保存的场记草稿？";
    if (typeof globalThis.confirm === "function" && !globalThis.confirm(prompt)) return;
    await deleteSelected();
  }

  const applyQuickEntryForRow = useCallback(async (recordId: string, rawText: string): Promise<void> => {
    const target = draftViewRef.current.rows.find((row) => row.record_id === recordId);
    if (!canUseSlate() || !target || !rawText.trim() || busy) return;
    setBusy(true);
    setMessage("正在解析场记原话…");
    try {
      const payload = await production.parseSlate(projectId, rawText, parsePrevious(target));
      const parsed: SlateParseResult = payload.result;
      const attachments = target.attachments.map((attachment) => {
        const shot = parsed.angle_shots[cameraKey(attachment.camera)];
        return shot ? { ...attachment, shot_type: shot } : attachment;
      });
      patchRecord(recordId, {
        episode: parsed.episode ?? target.episode,
        scene: parsed.scene || target.scene,
        shot: parsed.shot || target.shot,
        take_number: parsed.take_number ?? target.take_number,
        status: parsed.status !== "unmarked" ? parsed.status : target.status,
        note: parsed.note || rawText,
        attachments,
      });
      setMessage(`已填入解析结果${parsed.range_hint ? ` · 范围原话：${parsed.range_hint}` : ""}；仍需保存。`);
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }, [busy, canUseSlate, patchRecord, production, projectId]);

  function focusQuickEntry(): void {
    const targetId = selectedRecordId || displayedDrafts[0]?.record_id;
    if (!targetId) return;
    if (!selectedRecordId) selectRecord(targetId);
    const row = [...(slateRef.current?.querySelectorAll<HTMLTableRowElement>("tr.slate-row") ?? [])]
      .find((candidate) => candidate.dataset.recordId === targetId);
    const input = row?.querySelector<HTMLInputElement>("td.col-note input");
    if (input) {
      input.focus({ preventScroll: true });
      return;
    }
    setSourceEditorFocus({ recordId: targetId, field: "note" });
  }

  useEffect(() => {
    if (!hideNgRows || selected?.status !== "ng") return;
    const fallback = displayedDrafts.find((row) => row.status !== "ng");
    if (fallback) selectRecord(fallback.record_id);
    else setSelectedRecordId("");
  }, [displayedDrafts, hideNgRows, selectRecord, selected?.status]);

  function setIO(kind: "in" | "out"): void {
    if (!selected) return;
    const current = playerRef.current?.currentTime;
    if (typeof current !== "number" || !Number.isFinite(current)) { setMessage("当前没有可用播放器时间点。"); return; }
    const previous = selected.usable_range;
    if (kind === "in") {
      const end = previous?.end && previous.end > current ? previous.end : current + 0.04;
      patchRecord(selected.record_id, { usable_range: { start: current, end } });
      setMessage(`已设入点 ${current.toFixed(2)}s。`);
    } else {
      const start = previous?.start ?? 0;
      if (current <= start) { setMessage("出点必须晚于入点。"); return; }
      patchRecord(selected.record_id, { usable_range: { start, end: current } });
      setMessage(`已设出点 ${current.toFixed(2)}s。`);
    }
  }

  function appendNoteTagValue(current: string, tag: string): string {
    const trimmed = current.trim();
    return trimmed.includes(tag) ? trimmed : trimmed ? `${trimmed} · ${tag}` : tag;
  }

  function appendNoteTag(tag: string): void {
    if (!selected) return;
    const next = appendNoteTagValue(selected.note, tag);
    if (next !== selected.note.trim()) patchRecord(selected.record_id, { note: next });
  }

  function markSelectedMisrecorded(): void {
    if (!selected) return;
    patchRecord(selected.record_id, { status: "ng", note: appendNoteTagValue(selected.note, "误录") });
    setMessage("已标为 NG · 误录；未删原文件，仍需保存。");
  }

  const stepSelection = useCallback((delta: -1 | 1): void => {
    const visible = displayedDrafts;
    const index = visible.findIndex((row) => row.record_id === selectedRecordId);
    const next = visible[index < 0 ? (delta > 0 ? 0 : visible.length - 1) : index + delta];
    if (!next) return;
    selectRecord(next.record_id);
    const mounted = [...(slateRef.current?.querySelectorAll<HTMLTableRowElement>("tr.slate-row") ?? [])]
      .find((row) => row.dataset.recordId === next.record_id);
    if (mounted) mounted.scrollIntoView?.({ block: "nearest" });
    else setSourceEditorFocus({ recordId: next.record_id });
  }, [displayedDrafts, selectedRecordId, selectRecord]);

  const shortcutActionsRef = useRef({ canUseSlate, saveAll, addBlank, nextSameScene, setIO, patchRecord, selected, playbackUrl, quickLookOpen, closeQuickLook, toggleQuickLook, focusQuickEntry, stepSelection });
  useEffect(() => {
    shortcutActionsRef.current = { canUseSlate, saveAll, addBlank, nextSameScene, setIO, patchRecord, selected, playbackUrl, quickLookOpen, closeQuickLook, toggleQuickLook, focusQuickEntry, stepSelection };
  });

  useEffect(() => {
    if (!active || intervalSurface) return;
    const keydown = (event: KeyboardEvent) => {
      if (!shortcutActionsRef.current.canUseSlate() || event.isComposing || document.querySelector("dialog[open], .semantic-search-palette")) return;
      if (event.key === "Escape" && takePickerOpen) {
        event.preventDefault();
        setTakePickerOpen(false);
        setTakeSearch("");
        return;
      }
      if (event.key === "Escape" && shortcutActionsRef.current.quickLookOpen) {
        event.preventDefault();
        shortcutActionsRef.current.closeQuickLook();
        return;
      }
      const target = event.target as HTMLElement | null;
      const editing = target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable]"));
      if (event.key === "/" && !editing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        shortcutActionsRef.current.focusQuickEntry();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void shortcutActionsRef.current.saveAll(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") { event.preventDefault(); shortcutActionsRef.current.addBlank(); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") { event.preventDefault(); shortcutActionsRef.current.nextSameScene(); return; }
      if (!editing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          shortcutActionsRef.current.stepSelection(event.key === "ArrowUp" ? -1 : 1);
          return;
        }
        if (event.key.toLowerCase() === "i") { event.preventDefault(); shortcutActionsRef.current.setIO("in"); return; }
        if (event.key.toLowerCase() === "o") { event.preventDefault(); shortcutActionsRef.current.setIO("out"); return; }
        const currentSelected = shortcutActionsRef.current.selected;
        if (currentSelected && !target?.closest("button")) {
          if (event.key === "1") { event.preventDefault(); shortcutActionsRef.current.patchRecord(currentSelected.record_id, { status: "usable" }); return; }
          if (event.key === "2") { event.preventDefault(); shortcutActionsRef.current.patchRecord(currentSelected.record_id, { status: "partial" }); return; }
          if (event.key === "3") { event.preventDefault(); shortcutActionsRef.current.patchRecord(currentSelected.record_id, { status: "ng" }); return; }
          if (event.key === "4") { event.preventDefault(); shortcutActionsRef.current.patchRecord(currentSelected.record_id, { status: "unmarked" }); return; }
          if (event.code === "Space" && target?.tagName !== "TR" && shortcutActionsRef.current.playbackUrl) {
            event.preventDefault();
            shortcutActionsRef.current.toggleQuickLook();
          }
        }
      }
    };
    globalThis.addEventListener("keydown", keydown);
    return () => globalThis.removeEventListener("keydown", keydown);
  }, [takePickerOpen, intervalSurface, active]);

  useEffect(() => {
    if (!takePickerOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (takePickerRef.current?.contains(target) || takePickerTriggerRef.current?.contains(target)) return;
      setTakePickerOpen(false);
      setTakeSearch("");
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [takePickerOpen]);

  const previewsActive = active && !intervalSurface;
  const mediaCell = useCallback((draft: Draft, camera: SlateCameraColumn, selectedClip?: string) => {
    if (!previewsActive) return null;
    const row = primaryAttachment(draft, camera, cameraColumns);
    if (!row) {
      if (camera === "AUX") return <span className="golden-slate-empty-media">—</span>;
      return <button type="button" className="golden-slate-empty-media" onClick={(event) => { event.stopPropagation(); selectRecord(draft.record_id); setTakePickerOpen(true); }}>{`＋ ${camera}`}</button>;
    }
    const angle = angleIndex.byClip.get(row.item.clip_id) ?? (row.item.media_id ? angleIndex.byMedia.get(row.item.media_id) : undefined) ?? null;
    const model = angle ? mediaCardFromAngle(angle, row.item) : mediaCardFromAttachment(row.item);
    model.duplicateCount = row.count;
    const key = attachmentKey(row.item);
    return <MirrorOrderMediaCard model={model} compact selected={key === selectedClip} preferred={draft.preferred_clip_id === key} onSelect={() => { selectRecord(draft.record_id); selectClip(key); }} />;
  }, [previewsActive, cameraColumns, angleIndex, selectRecord, selectClip]);

  const startEdit = useCallback(() => {
    setEditLayout(current => current ?? new Map(orderRows(draftViewRef.current.rows, orderMode)
      .map((row, index) => [row.record_id, { index, placed: isPlacedDraft(row) }])));
  }, [orderMode]);
  const endEdit = useCallback(() => setEditLayout(null), []);
  function renderRow(draft: Draft) {
    const selected = draft.record_id === selectedRecordId;
    return <DraftSlateRow key={draft.record_id} draft={draft} rowNumber={(displayIndexByRecord.get(draft.record_id) ?? -1) + 1}
      selected={selected} selectedClip={selected ? selectedClipId : undefined} cameraColumns={cameraColumns} mediaCell={mediaCell}
      revealRow={previewsActive && sourceEditorFocus?.recordId === draft.record_id ? revealRow : undefined}
      onSelect={selectRecord} onPatch={patchRecord} onQuickParse={applyQuickEntryForRow} onEditStart={startEdit} onEditEnd={endEdit} />;
  }

  function section(title: string, rows: Draft[], tone: "placed" | "unplaced", showHeader = true) {
    if (!rows.length) return null;
    return (
      <section className={`golden-slate-section is-${tone}${showHeader ? "" : " is-headerless"}`}>
        {showHeader ? <header><span className="section-dot" /><strong>{title}</strong><small>{rows.length} 条</small></header> : null}
        <div className="golden-slate-section-scroll">
          <table className="golden-slate-table">
            <thead><SlateTableHead cameraColumns={cameraColumns} columnWidths={columnWidths} onResizeColumn={resizeColumn} onResetColumnWidth={resetColumnWidth} /></thead>
            {rows.length <= 60 ? <tbody>{rows.map(renderRow)}</tbody> : (
              <VirtualizedSlateTbody rows={rows} columns={7 + cameraColumns.length} active={previewsActive}
                revealId={sourceEditorFocus?.recordId} renderRow={renderRow} />
            )}
          </table>
        </div>
      </section>
    );
  }

  const inspectorAttachments = selected?.attachments ?? [];

  return (<div className="slate-workbench-content" data-view-switch={ledgerSurface || undefined} ref={slateRef}>
    {ledger && <div hidden={!intervalSurface}>
      {ledgerSurface && <nav className="slate-interval-view-switch" aria-label="场记工作视图">
        <button type="button" className={!intervalSurface ? "is-active" : undefined} aria-pressed={!intervalSurface} onClick={()=>setSlateSurface("takes")}>场记表</button>
        <button type="button" className={intervalSurface ? "is-active" : undefined} aria-pressed={intervalSurface} onClick={()=>setSlateSurface("intervals")}>原始片段</button>
      </nav>}
      <SlateIntervalBoardSurface key={JSON.stringify([baseUrl,projectId])} {...ledger} baseUrl={baseUrl} projectName={projectName} productionRows={productionRows} onOpenProduction={openProductionSource} catalog={(review?.episodes ?? []).flatMap((entry)=>entry.scenes.map((scene)=>({episode:entry.episode,scene_id:scene.scene_id,label:prettySceneId(scene.scene_id)})))}/>
    </div>}
    {intervalSurface && !ledger && <section aria-label="电子场记板">
      {ledgerSurface && <nav className="slate-interval-view-switch" aria-label="场记工作视图">
        <button type="button" className={!intervalSurface ? "is-active" : undefined} aria-pressed={!intervalSurface} onClick={()=>setSlateSurface("takes")}>场记表</button>
        <button type="button" className={intervalSurface ? "is-active" : undefined} aria-pressed={intervalSurface} onClick={()=>setSlateSurface("intervals")}>原始片段</button>
      </nav>}
      <SlateOriginalFormSheet page={{title:projectName?.trim()||"",day:"",date:"",printedPage:""}} rows={[]} />
      {nativeIntervalLedger.error ? <><p role="alert">{nativeIntervalLedger.error}</p><button type="button" onClick={()=>void nativeIntervalLedger.refresh().catch(()=>{})}>重读列表</button></> : <p role="status">正在读取电子场记板…</p>}
    </section>}
    <div hidden={intervalSurface}><section className={`golden-slate-workbench ${inspectorOpen ? "has-inspector" : ""} ${dropActive ? "is-file-drop-active" : ""}`}>
      <header className="golden-slate-subbar">
        <div className="golden-slate-subbar-left">
          {ledgerSurface && <nav className="slate-interval-view-switch" aria-label="场记工作视图">
            <button type="button" className={!intervalSurface ? "is-active" : undefined} aria-pressed={!intervalSurface} onClick={()=>setSlateSurface("takes")}>场记表</button>
            <button type="button" className={intervalSurface ? "is-active" : undefined} aria-pressed={intervalSurface} onClick={()=>setSlateSurface("intervals")}>原始片段</button>
          </nav>}
          <span className="golden-slate-count" aria-label="场记行数">{displayedDrafts.length} 条</span>
          <details className="golden-slate-menu golden-slate-menu-left" onToggle={handleDetailsMenuToggle} onBlur={handleDetailsMenuBlur} onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.currentTarget.open = false;
              event.currentTarget.querySelector<HTMLElement>("summary")?.focus();
            }
          }}>
            <summary>＋ 记一条</summary>
            <div className="golden-slate-menu-popover" role="group" aria-label="新增场记">
              <button type="button" onClick={(event) => { closeGoldenSlateMenu(event.currentTarget); nextSameScene(); }}>同场下一条</button>
              <button type="button" onClick={(event) => { closeGoldenSlateMenu(event.currentTarget); inheritPrevious(); }}>同上</button>
              <button type="button" onClick={(event) => { closeGoldenSlateMenu(event.currentTarget); addBlank(); }}>空白</button>
              <button ref={takePickerTriggerRef} type="button" onClick={(event) => { closeGoldenSlateMenu(event.currentTarget); setTakePickerOpen((value) => !value); }}>从 Take 加入</button>
            </div>
          </details>
        </div>
        <div className="golden-slate-actions golden-slate-subbar-right" role="group" aria-label="场记辅助操作">
          <details className="golden-slate-menu golden-slate-menu-right" onToggle={handleDetailsMenuToggle} onBlur={handleDetailsMenuBlur} onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.currentTarget.open = false;
              event.currentTarget.querySelector<HTMLElement>("summary")?.focus();
            }
          }}>
            <summary>工具</summary>
            <div className="golden-slate-menu-popover" role="group" aria-label="视图与工具">
              <button type="button" className={inspectorOpen ? "is-active" : ""} onClick={(event) => { closeGoldenSlateMenu(event.currentTarget); setInspectorOpen((value) => !value); }} aria-label={inspectorOpen ? "隐藏检视" : "显示检视"} aria-pressed={inspectorOpen} title={inspectorOpen ? "收起右侧详情栏" : "展开右侧详情栏"}>右侧详情栏</button>
              <button type="button" className={orderMode === "script" ? "is-active" : ""} aria-pressed={orderMode === "script"} onClick={(event) => { closeGoldenSlateMenu(event.currentTarget); setEditLayout(null); setOrderMode((value) => value === "script" ? "shooting" : "script"); }}>按场号归类</button>
              <button type="button" onClick={(event) => { closeGoldenSlateMenu(event.currentTarget); setPaperIntakeOpen(true); }}>导入纸面/照片场记…</button>
              {(ngCount > 0 || hideNgRows) ? <button type="button" className={hideNgRows ? "is-active" : ""} aria-pressed={hideNgRows} onClick={(event) => { closeGoldenSlateMenu(event.currentTarget); setHideNgRows((value) => !value); }}>隐藏 NG ({ngCount})</button> : null}
              {!hasAuxMedia ? <button type="button" className={showAuxColumn ? "is-active" : ""} aria-pressed={showAuxColumn} onClick={(event) => { closeGoldenSlateMenu(event.currentTarget); setShowAuxColumn((value) => !value); }} title="显示或隐藏空的 AUX 列">显示其他机位 (AUX)</button> : null}
              <button type="button" disabled={busy} onClick={(event) => { closeGoldenSlateMenu(event.currentTarget); void reload(selectedRecordId); }} aria-label="刷新场记" title="重新读取最新场记">刷新场记</button>
            </div>
          </details>
          <SlatePaperIntake key={`${baseUrl}:${projectId}`} baseUrl={baseUrl} projectId={projectId} open={paperIntakeOpen} onOpenChange={setPaperIntakeOpen} hideTrigger onSelect={setPaperSource} onApplyDraftCandidates={applyPaperDraftCandidates} />
          <span className="golden-slate-message" aria-live="polite">{message}</span>
          <span
            className="golden-slate-save-state"
            data-state={busy ? "saving" : dirtyCount ? "dirty" : board ? "saved" : "idle"}
            aria-live="polite"
          >
            {busy ? "保存中…" : draftConflicts.size ? `${draftConflicts.size} 条草稿需核对` : dirtyCount ? `未保存 ${dirtyCount}` : board ? "已保存" : "等待加载"}
          </span>
          <button type="button" className={`golden-slate-save-button${dirtyCount > 0 ? " is-dirty" : ""}`} disabled={busy || !board || dirtyCount === 0 || draftConflicts.size > 0 || !actor.trim()} onClick={() => void saveAll()}>保存{dirtyCount ? ` ${dirtyCount}` : ""}</button>
        </div>
      </header>

      {takePickerOpen ? (
        <section ref={takePickerRef} className="golden-take-picker" aria-label="加入 Take / 镜头">
          <header><strong>加入 Take / 镜头</strong><input autoFocus value={takeSearch} onChange={(event) => setTakeSearch(event.target.value)} placeholder="搜索 Take / 机位 / 文件名 / 对白" /><button type="button" className="secondary" onClick={() => { setTakePickerOpen(false); setTakeSearch(""); }}>关闭</button></header>
          <div className="golden-take-picker-list">
            {takeCandidates.map((take) => (
              <TakeListRow
                key={take.group_id}
                take={take}
                state={usedTakeIds.has(take.group_id) ? "used" : "default"}
                onSelect={() => addTake(take)}
              />
            ))}
            {!takeCandidates.length ? <span className="golden-take-picker-empty">没有匹配 Take。</span> : null}
          </div>
        </section>
      ) : null}

      <div className="golden-slate-body">
        <div className="golden-slate-table-shell">
          {dropActive ? <div className="golden-slate-drop-overlay">松开以加入当前场记</div> : null}
          {orderMode === "shooting" && displayedDrafts.length ? (
            section("真实拍摄顺序 · 全场记", displayedDrafts, "placed", false)
          ) : placedDrafts.length && unplacedDrafts.length ? (
            <div className="golden-slate-split-sections">{section("已按剧本归位", placedDrafts, "placed")}{section("待标记 · 保持 XML 顺序", unplacedDrafts, "unplaced")}</div>
          ) : placedDrafts.length ? section("已按剧本归位", placedDrafts, "placed") : unplacedDrafts.length ? section("待标记 · 保持 XML 顺序", unplacedDrafts, "unplaced") : (
            <div className="golden-slate-empty"><strong>从 Take 加入第一条多机位场记</strong><span>A / B / C 会落在同一行；场号、镜号、次号只记录一次。</span><div><button type="button" onClick={() => setTakePickerOpen(true)}>从 Take 加入</button><button type="button" className="secondary" onClick={() => addBlank()}>新建空白场记</button></div></div>
          )}
        </div>

          <aside className="golden-slate-inspector" hidden={!inspectorOpen}>
            {selected ? (
              <>
                <div className={`golden-slate-player${quickLookOpen ? " golden-quicklook-popover" : ""}`}
                  role={quickLookOpen ? "dialog" : undefined} aria-label={quickLookOpen ? "场记快速预览" : undefined}
                  style={{ "--slate-video-aspect": videoAspect } as CSSProperties}>
                  {quickLookOpen && <header>
                    <strong>EP {selected.episode ?? "—"} · 场 {selected.scene || selected.script_scene_id || "—"} · 镜 {selected.shot || "—"} · T{selected.take_number ?? "—"}</strong>
                    <button ref={quickLookCloseRef} type="button" className="secondary" onClick={() => closeQuickLook()}>关闭 (Esc)</button>
                  </header>}
                  {playbackUrl && !selectedPlaybackFailed ? (
                    <video ref={playerRef} key={`${selectedPlaybackKey}-${playbackRetry}-${playbackStart}`}
                      src={playbackUrl} controls preload={previewsActive ? "auto" : "none"} playsInline
                      onSeeked={publishPlaybackLocation} onPause={publishPlaybackLocation}
                      onError={() => { setPlaybackFailedClipId(selectedPlaybackKey); void classifyPlaybackFailure(playbackUrl).then(setPlaybackFailureDetail); }}
                      onLoadedMetadata={(event) => {
                        const video = event.currentTarget;
                        updateVideoGeometry(video);
                        if (playbackStart >= 0 && playbackStart < video.duration) video.currentTime = playbackStart;
                      }} onResize={(event) => updateVideoGeometry(event.currentTarget)} />
                  ) : selectedPlaybackFailed ? (
                    <div className="golden-player-error"><strong>当前设备无法读取或解码这个素材</strong><span>{playbackFailureDetail?.detail ?? "正在确认失败原因；可先确认素材盘在线后重新加载。"}</span><button type="button" className="secondary" onClick={() => { setPlaybackFailedClipId(""); setPlaybackRetry((value) => value + 1); }}>重新加载</button></div>
                  ) : <div className="golden-player-empty">{selectedAttachment ? "当前设备没有可播放素材" : "选择一个机位素材"}</div>}
                  {quickLookOpen && <footer><span>{selected.note || selectedTake?.transcript.text || "快捷键：1 可用 · 2 部分 · 3 NG · ⌘D 连拍下一条"}</span></footer>}
                </div>
                <div className="golden-inspector-head golden-inspector-meta"><div><span>EP {selected.episode ?? "—"} · 场 {selected.scene || selected.script_scene_id || "—"} · 镜 {selected.shot || "—"} · 次 {selected.take_number ?? "—"}</span>{selectedFilename ? <span className="golden-inspector-filename" title={selectedFilename}>{selectedFilename}</span> : null}</div><button type="button" className="secondary golden-inspector-quicklook" disabled={!playbackUrl} title="大窗快速预览当前选中素材" onClick={toggleQuickLook}>快速预览</button>{selected.dirty ? <em>未保存</em> : null}</div>

                {selectedPlaybackFailed && onRepair && <button type="button" className="secondary" onClick={onRepair}>检查本机素材</button>}
                {groupId && onOpenTake && <div className="golden-inspector-actions golden-inspector-navigation">
                  <button type="button" className="secondary" onClick={() => onOpenTake("material", currentLocation())}>在素材中打开</button>
                  <button type="button" className="secondary" onClick={() => onOpenTake("script", currentLocation())}>在剧本中打开</button>
                  <button type="button" className="secondary" onClick={() => onOpenTake("review", currentLocation())}>看片审阅</button>
                </div>}

                <label className="golden-inspector-field"><span>备注</span><textarea rows={3} value={selected.note} onChange={(event) => patchRecord(selected.record_id, { note: event.target.value })} placeholder="场记原话、可用范围、连续性提醒…" /></label>
                <div className="golden-quick-tags" role="group" aria-label="快捷现场标签">
                  {QUICK_SLATE_TAGS.map((tag) => (
                    <button key={tag} type="button" className="secondary" onClick={() => appendNoteTag(tag)}>
                      + {tag}
                    </button>
                  ))}
                  <button type="button" className="secondary" onClick={markSelectedMisrecorded}>标为误录</button>
                </div>

                {episodeCandidates.length ? <section className="golden-episode-candidates"><header><strong>第 {selected.episode} 集候选</strong><span>{episodeCandidates.length} Take</span></header>{episodeCandidates.map((take) => <TakeListRow key={take.group_id} take={take} onSelect={() => addTake(take)} />)}</section> : null}

                <section className="golden-inspector-media"><header><strong>机位素材</strong><span>{inspectorAttachments.length}</span></header>
                  {inspectorAttachments.map((attachment) => {
                    const key = attachmentKey(attachment);
                    const angle = angleIndex.byClip.get(attachment.clip_id) ?? (attachment.media_id ? angleIndex.byMedia.get(attachment.media_id) : undefined) ?? null;
                    const model = angle ? mediaCardFromAngle(angle, attachment) : mediaCardFromAttachment(attachment);
                    return (
                      <div className="golden-angle-editor" key={`${attachment.clip_id}-${attachment.media_id}`}>
                        <MirrorOrderMediaCard model={model} selected={key === selectedClipId} preferred={selected.preferred_clip_id === key} showPreview={previewsActive && inspectorOpen} onSelect={() => selectClip(key)} onPrefer={() => patchRecord(selected.record_id, { preferred_clip_id: selected.preferred_clip_id === key ? "" : key })} />
                        <div className="golden-angle-fields">
                          <label><span>机位</span><input value={attachment.camera} onChange={(event) => patchAttachment(selected.record_id, key, { camera: event.target.value })} /></label>
                          <label><span>景别</span><select value={attachment.shot_type || "unknown"} onChange={(event) => patchAttachment(selected.record_id, key, { shot_type: event.target.value })}>{SHOT_OPTIONS.map((shot) => <option value={shot} key={shot}>{SHOT_LABELS[shot] ?? shot}</option>)}</select></label>
                          <label className="golden-angle-note"><span>素材备注</span><input value={attachment.note || ""} onChange={(event) => patchAttachment(selected.record_id, key, { note: event.target.value })} placeholder="该机位独立备注" /></label>
                        </div>
                        <div className="golden-angle-actions"><button type="button" className="secondary" onClick={() => patchRecord(selected.record_id, { preferred_clip_id: selected.preferred_clip_id === key ? "" : key })}>{selected.preferred_clip_id === key ? "★ 取消首选" : "☆ 场记首选"}</button><button type="button" className="secondary danger-text" onClick={() => removeAttachment(selected.record_id, key)}>− 移除</button></div>
                      </div>
                    );
                  })}
                  {!inspectorAttachments.length ? <button type="button" className="golden-inspector-add-take" onClick={() => setTakePickerOpen(true)}>＋ 加入 Take / 镜头</button> : null}
                </section>

                <details
                  className="golden-inspector-advanced"
                  open={advancedToolsOpen || Boolean(paperSource)}
                  onToggle={(event) => setAdvancedToolsOpen(event.currentTarget.open)}
                >
                  <summary>进阶工具（打板帧 · 语音转写 · 入出点）</summary>
                  <div className="golden-inspector-advanced-body">
                    {clipId ? (
                      <div className="golden-clapper-bar">
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy || clapperBusy}
                          onClick={() => void detectClapperboardFrame()}
                        >
                          {clapperBusy ? "正在识别打板帧…" : "识别片头打板帧（AI 提案）"}
                        </button>
                        <span>仅回填草稿，需人工核对保存</span>
                      </div>
                    ) : null}
                    <div className="golden-io-row"><button type="button" className="secondary" onClick={() => setIO("in")}>I 设入点</button><label><span>入点</span><input type="number" step="0.01" min="0" value={selected.usable_range?.start ?? ""} onChange={(event) => { const start = event.target.value ? Number(event.target.value) : 0; const end = selected.usable_range?.end ?? start + 0.04; patchRecord(selected.record_id, { usable_range: { start, end: Math.max(end, start + 0.04) } }); }} /></label><label><span>出点</span><input type="number" step="0.01" min="0" value={selected.usable_range?.end ?? ""} onChange={(event) => { const end = event.target.value ? Number(event.target.value) : 0; const start = selected.usable_range?.start ?? 0; if (end > start) patchRecord(selected.record_id, { usable_range: { start, end } }); }} /></label><button type="button" className="secondary" onClick={() => setIO("out")}>O 设出点</button></div>
                    {(advancedToolsOpen || Boolean(paperSource)) && selectedAttachment?.clip_id ? <SlateSpeechEvidencePanel key={`${baseUrl}:${projectId}:${selectedAttachment.clip_id}:${selectedAttachment.media_id}`} baseUrl={baseUrl} projectId={projectId} clipId={selectedAttachment.clip_id} mediaId={selectedAttachment.media_id} /> : null}
                    {selectedAttachment?.clip_id && selectedAttachment.media_id ? (
                      <details className="golden-slate-advanced-interval" open={Boolean(paperSource)}>
                        <summary>精确源帧区间核验（可选）</summary>
                        <SlateSourceIntervalPanel key={`${baseUrl}:${projectId}:${selected.record_id}:${selectedAttachment.clip_id}:${selectedAttachment.media_id}:${board?.revision}:${paperSource?.row.paper_row_id}:${paperSource?.revision}`} paperSource={paperSource} baseUrl={baseUrl} projectId={projectId} recordId={selected.record_id} clipId={selectedAttachment.clip_id} mediaId={selectedAttachment.media_id} savedRecord={board?.records[selected.record_id]} boardRevision={board?.revision ?? -1} dirty={selected.dirty} />
                      </details>
                    ) : null}
                  </div>
                </details>

                {inspectorLinkage ? (
                  <div className="golden-inspector-link">
                    <span>关联</span>
                    {selectedTake ? <strong>Take {selectedTake.take_index}</strong> : null}
                    {selected.script_scene_id.trim() ? <small>剧本场景 · {selected.script_scene_id}</small> : null}
                    {selectedTake?.transcript.text.trim() ? <small>{selectedTake.transcript.text.trim()}</small> : null}
                  </div>
                ) : null}
                {selectedConflict && <section className="golden-inspector-link" aria-label="场记草稿冲突">
                  <strong>{selectedServerRecord ? "服务端已更新这条场记" : "服务端已删除或替换原场记"}</strong>
                  {selectedServerRecord && <details>
                    <summary>查看服务端场记</summary>
                    <p>第 {selectedServerRecord.episode ?? "—"} 集 · 场 {selectedServerRecord.scene || selectedServerRecord.script_scene_id || "—"} · 镜 {selectedServerRecord.shot || "—"} · 次 {selectedServerRecord.take_number ?? "—"}</p>
                    {selectedServerRecord.note && <p>{selectedServerRecord.note}</p>}
                  </details>}
                </section>}
                <div className="golden-inspector-actions">
                  <button type="button" disabled={busy || !board || !selected.dirty || !actor.trim() || (selectedConflict && !selectedPersisted)} onClick={() => void saveSelected()}>
                    {selectedConflict && selectedPersisted ? "用草稿覆盖…" : "保存当前行"}
                  </button>
                  {selectedConflict ? <button type="button" className="secondary" disabled={busy} onClick={discardConflictingDraft}>放弃此草稿…</button>
                    : selectedCanDelete ? <button type="button" className="danger-subtle" disabled={busy} onClick={() => void requestDeleteSelected()}>{selectedPersisted ? "删除人工场记…" : "移除草稿…"}</button> : null}
                </div>
              </>
            ) : <div className="golden-inspector-empty">选择一行或一张机位卡。</div>}
          </aside>
      </div>

    </section></div>
  </div>);
}
