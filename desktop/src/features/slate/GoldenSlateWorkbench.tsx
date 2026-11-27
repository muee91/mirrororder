import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefCallback } from "react";
import { DesktopClient, type SlateCandidateState } from "../../api/desktop";
import { HostConnection, HostConnectionError, type ReviewAngle, type ReviewModelPayload, type ReviewTakeGroup, errorMessage } from "../../api/host";
import { ProductionClient, type AssistantSelection, type SlateAttachment, type SlateBoard, type SlateEntry, type SlatePaperSuggestions, type SlateParseResult, type SlateRecord } from "../../api/production";
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
import { SlateInspectorClipHeader, SlateInspectorSources } from "./SlateInspectorSources";
import { SlateRow, SlateTableHead, SLATE_CAMERA_COLUMNS, SLATE_STATUS_OPTIONS, type SlateCameraColumn } from "./SlateRow";
import type { PendingSlateDrafts, SlateDraft as Draft, SlateDraftSession } from "./slateDraftSession";
import { originalPlaybackUrl } from "./SlateOriginalPlayback";
import {
  adjacentPaperSceneContext, automaticMappingConfirmed, deriveSlateTakeFields, mappedScene, parseTakeNumber, prettySceneId, type SceneLink,
} from "./slateTakeFields";
import type { ProductionSelectionContext, ProductionWorkspace } from "../production/productionNavigation";
import { readCurrentOperator, requestCurrentOperator } from "../../components/CurrentOperatorControl";
import { StudioIcon } from "../../components/StudioIcons";
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

type SlateOrder = "script" | "shooting";
type InspectorView = "take" | "media";
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
const SLATE_INSPECTOR_STORAGE_KEY = "mirrororder.slateInspectorOpen.v1";

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

function draftFromRecord(record: SlateRecord, take: ReviewTakeGroup | null, xmlOrder: number): Draft {
  return { ...record, attachments: mergeTakeAttachments(record, take), dirty: false, derived: false, derivedSource: "", xmlOrder };
}

function draftFromTake(
  review: ReviewModelPayload,
  take: ReviewTakeGroup,
  xmlOrder: number,
  paperSuggestions?: SlatePaperSuggestions | null,
  paperSceneContext?: ReadonlyMap<string, string>,
): Draft {
  return {
    record_id: `derived-${take.group_id}`,
    source_group_id: take.group_id,
    ...deriveSlateTakeFields(review, take, paperSuggestions, paperSceneContext),
    status: "unmarked",
    note: "",
    preferred_clip_id: "",
    attachments: take.angles.map(attachmentFromAngle),
    actor: "",
    updated_at: "",
    dirty: false,
    derived: true,
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

function normalizeSceneLabel(value: string): string {
  return value.trim().replace(/^SC[_-]?/i, "").replace(/[_\s]+/g, "-").toLowerCase();
}

function sceneLabelMatches(candidate: PaperVlmCandidate, mapped: SceneLink): boolean {
  const left = normalizeSceneLabel(candidate.scene);
  if (!left) return false;
  const pretty = normalizeSceneLabel(prettySceneId(mapped.sceneId));
  if (left === pretty || left === normalizeSceneLabel(mapped.sceneId)) return true;
  // A bare paper scene ("12", "12B") may only attach to "1-12" when the
  // episode is known to agree. Trailing digits alone must never join 1-1 to 2-1.
  if (/^\d+[a-z]?$/.test(left) && candidate.episode !== null && candidate.episode === mapped.episode) {
    return (pretty.split("-").pop() ?? "") === left;
  }
  return false;
}

function noteClueScore(candidate: PaperVlmCandidate, take: ReviewTakeGroup): number {
  const note = candidate.note.trim().toLowerCase();
  if (note.length < 2) return 0;
  const haystack = [take.transcript?.text, ...take.angles.map((angle) => angle.name)]
    .filter((value): value is string => Boolean(value))
    .join(" ").toLowerCase();
  if (!haystack) return 0;
  const tokens = note.match(/[\u4e00-\u9fff]{2,}|[a-z0-9]{3,}/g) ?? [];
  return tokens.some((token) => haystack.includes(token)) ? 1 : 0;
}

function candidateTakeScore(candidate: PaperVlmCandidate, take: ReviewTakeGroup, review: ReviewModelPayload): number {
  const mapped = mappedScene(review, take);
  // Without a script-matched scene there is no safe automatic pairing.
  if (!mapped) return -1;
  let score = 0;
  if (candidate.episode !== null) {
    if (mapped.episode !== candidate.episode && !takeMatchesEpisode(take, candidate.episode)) return -1;
    score += 3;
  }
  if (candidate.scene.trim()) {
    if (!sceneLabelMatches(candidate, mapped)) return -1;
    score += 3;
  }
  const ordinal = parseTakeNumber(candidate.take);
  if (ordinal !== null) {
    // take_index is a long-recording subgroup number, NOT the paper take
    // number. Pair by occurrence order inside the matched scene instead.
    const sceneTakes = review.take_groups.filter((item) => mappedScene(review, item)?.sceneId === mapped.sceneId);
    const position = sceneTakes.indexOf(take);
    if (position >= 0) {
      if (position + 1 === ordinal) score += 2;
      else if (sceneTakes.length > 1) score -= 2;
    }
  }
  return score + noteClueScore(candidate, take);
}

function matchPaperCandidateToTake(
  candidate: PaperVlmCandidate,
  review: ReviewModelPayload | null,
  used: ReadonlySet<string> = new Set(),
): ReviewTakeGroup | null {
  if (!review) return null;
  const ranked = review.take_groups
    .filter((take) => !used.has(take.group_id))
    .map((take) => ({ take, score: candidateTakeScore(candidate, take, review) }))
    .filter((item) => item.score >= 3)
    .sort((left, right) => right.score - left.score);
  if (!ranked.length || (ranked[1] && ranked[1].score === ranked[0].score)) return null;
  return ranked[0].take;
}

function buildDrafts(board: SlateBoard, review: ReviewModelPayload): Draft[] {
  const takes = new Map(review.take_groups.map((take) => [take.group_id, take]));
  const xmlOrderByGroup = new Map(review.take_groups.map((take, index) => [take.group_id, index]));
  const paperSceneContext = adjacentPaperSceneContext(review, board.paper_suggestions);
  const persisted = Object.values(board.records).map((record) => draftFromRecord(
    record,
    takes.get(record.source_group_id) ?? null,
    xmlOrderByGroup.get(record.source_group_id) ?? Number.MAX_SAFE_INTEGER,
  ));
  const represented = new Set(persisted.map((record) => record.source_group_id).filter(Boolean));
  const derived = review.take_groups
    .filter((take) => !represented.has(take.group_id))
    .map((take, index) => draftFromTake(review, take, xmlOrderByGroup.get(take.group_id) ?? index, board.paper_suggestions, paperSceneContext));
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
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(() => {
    try { return localStorage.getItem(SLATE_INSPECTOR_STORAGE_KEY) !== "false"; } catch { return true; }
  });
  const [inspectorView, setInspectorView] = useState<InspectorView>("take");
  const inspectorContentId = useId();
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const inspectorContentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (inspectorContentRef.current) inspectorContentRef.current.scrollTop = 0;
  }, [selectedRecordId, selectedClipId, inspectorView]);
  function changeInspectorVisibility(open: boolean): void {
    setInspectorOpen(open);
    try { localStorage.setItem(SLATE_INSPECTOR_STORAGE_KEY, String(open)); } catch { /* optional preference */ }
  }
  const [advancedToolsOpen, setAdvancedToolsOpen] = useState(false);
  const [hideNgRows, setHideNgRows] = useState(false);
  const [orderMode, setOrderMode] = useState<SlateOrder>("shooting");
  const [paperIntakeOpen, setPaperIntakeOpen] = useState(false);
  // The attached slate is owned by project.config.slate. Recognition is a
  // durable task; this page only reads its persisted proposals and polls.
  const [slateState, setSlateState] = useState<SlateCandidateState | null>(null);
  const [slateBusy, setSlateBusy] = useState(false);
  const slateBusyRef = useRef(false);
  const slateAutoStarted = useRef("");
  const slateReviewShown = useRef("");
  useEffect(() => {
    setSlateState(null);
    slateAutoStarted.current = "";
    slateReviewShown.current = "";
  }, [projectId]);

  const loadSlateState = useCallback(async (): Promise<SlateCandidateState | null> => {
    try {
      const state = await desktopClient.slateCandidates(projectId);
      if (canUseSlate()) setSlateState(state);
      return state;
    } catch {
      return null;
    }
  }, [desktopClient, projectId, canUseSlate]);

  const startSlateRecognition = useCallback(async () => {
    if (slateBusyRef.current) return;
    slateBusyRef.current = true;
    if (canUseSlate()) setSlateBusy(true);
    try {
      await desktopClient.submitSlateOcr(projectId);
      await loadSlateState();
      if (canUseSlate()) setMessage("场记识别已在后台开始；完成后会提示核对。");
    } catch (error) {
      if (canUseSlate()) setMessage(`场记识别提交失败：${errorMessage(error)}`);
    } finally {
      slateBusyRef.current = false;
      if (canUseSlate()) setSlateBusy(false);
    }
  }, [desktopClient, projectId, loadSlateState, canUseSlate]);

  useEffect(() => {
    if (active === false) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      let state = await loadSlateState();
      if (cancelled || !state) return;
      if (state.slate_attached && state.status === "none" && slateAutoStarted.current !== projectId) {
        slateAutoStarted.current = projectId;
        await startSlateRecognition();
        state = await loadSlateState();
        if (cancelled || !state) return;
      }
      if (state.status === "queued" || state.status === "running") {
        timer = window.setTimeout(() => { void tick(); }, 2000);
      }
    };
    void tick();
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [active, projectId, loadSlateState, startSlateRecognition]);
  const applyPaperDraftsRef = useRef<(candidates: PaperVlmCandidate[]) => void>(() => {});
  const realignPaperDraftsRef = useRef<() => void>(() => {});
  const autoAlignedReviewKey = useRef("");
  useEffect(() => {
    autoAlignedReviewKey.current = "";
  }, [projectId]);
  useEffect(() => {
    if (active === false || !board) return;
    if (!slateState || slateState.status !== "completed" || !slateState.candidates.length) return;
    const key = `${projectId}:${slateState.revision}`;
    if (slateReviewShown.current === key) return;
    const storageKey = `mirrororder.slate.autoApplied:${projectId}`;
    try {
      if (globalThis.localStorage?.getItem(storageKey) === String(slateState.revision)) {
        slateReviewShown.current = key;
        return;
      }
      globalThis.localStorage?.setItem(storageKey, String(slateState.revision));
    } catch {
      // Device-local storage is best effort.
    }
    slateReviewShown.current = key;
    applyPaperDraftsRef.current(slateState.candidates);
  }, [active, board, projectId, slateState]);
  const [quickLookOpen, setQuickLookOpen] = useState(false);
  const quickLookFocusRef = useRef<HTMLElement | null>(null);
  const quickLookCloseRef = useRef<HTMLButtonElement | null>(null);
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
    setInspectorView(attachment ? "media" : "take");
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
    setLoadError(false);
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
      setSelectedClipId((current) => selected?.attachments.some((attachment) => attachmentKey(attachment) === current)
        ? current : selected?.preferred_clip_id || (selected?.attachments[0] ? attachmentKey(selected.attachments[0]) : ""));
      setPlaybackFailedClipId("");
      setPlaybackRetry(0);
      setMessage("已刷新");
      setLoadError(false);
    } catch (error) {
      if (canUseSlate()) {
        setLoadError(true);
        setMessage(errorMessage(error));
      }
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
        setLoadError(false);
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(true);
          setMessage(errorMessage(error));
        }
      });
    return () => { cancelled = true; };
  }, [host, production, projectId, canUseSlate, publishDraftView]);

  useEffect(() => {
    if (!active) slateRef.current?.querySelectorAll("video, audio").forEach((node) => (node as HTMLMediaElement).pause());
  }, [active]);

  useEffect(() => {
    if (!focus || !board || focus === appliedFocus.current || focus.projectId !== projectId || !active) return;
    const row = drafts.find(draft => focus.recordId && draft.record_id === focus.recordId)
      ?? drafts.find(draft => focus.groupId && draft.source_group_id === focus.groupId)
      ?? drafts.find(draft => focus.clipId && draft.attachments.some(attachment => attachment.clip_id === focus.clipId));
    if (!row) return;
    appliedFocus.current = focus;
    const attachment = row.attachments.find((item) => (!focus.clipId || focus.clipId === item.clip_id)
      && (!focus.mediaId || focus.mediaId === item.media_id));
    const clip = attachment ? attachmentKey(attachment) : row.preferred_clip_id || (row.attachments[0] ? attachmentKey(row.attachments[0]) : "");
    setSlateSurface("takes");
    setInspectorOpen(true);
    setInspectorView(attachment && (focus.clipId || focus.mediaId) ? "media" : "take");
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
    return [...cameras].sort().concat(hasAuxMedia ? ["AUX"] : []);
  }, [drafts, hasAuxMedia, review]);
  const hasUnlinkedPaperDrafts = useMemo(
    () => drafts.some((row) => row.derivedSource.startsWith("场记识别") && !row.source_group_id),
    [drafts],
  );
  useEffect(() => {
    if (active === false || !review || !hasUnlinkedPaperDrafts) return;
    const key = `${projectId}:${review.revisions?.review ?? 0}:${review.take_groups.length}`;
    if (autoAlignedReviewKey.current === key) return;
    autoAlignedReviewKey.current = key;
    realignPaperDraftsRef.current();
  }, [active, projectId, review, hasUnlinkedPaperDrafts]);
  const selected = drafts.find((row) => row.record_id === selectedRecordId) ?? null;
  const selectedTake = selected?.source_group_id ? review?.take_groups.find((take) => take.group_id === selected.source_group_id) ?? null : null;
  const selectedAttachment = selected?.attachments.find((item) => attachmentKey(item) === selectedClipId) ?? null;
  const inspectingMedia = inspectorView === "media" && Boolean(selectedAttachment);
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
    if (selection.recordId) onSelection?.(selection);
  }, [active, intervalSurface, onSelection, selection]);
  const sourceGroupId = selected?.source_group_id || undefined;
  useLayoutEffect(() => {
    if (!active || intervalSurface) return;
    onInspectSelection?.(inspectingMedia
      ? { group_id: groupId, clip_id: clipId, media_id: mediaId }
      : { group_id: sourceGroupId });
  }, [active, intervalSurface, onInspectSelection, inspectingMedia, sourceGroupId, groupId, clipId, mediaId]);
  const selectedPlaybackFailed = Boolean(selectedPlaybackKey && playbackFailedClipId === selectedPlaybackKey);
  const standaloneUrl = selectedAttachment?.clip_id && selectedAttachment.media_id && !selectedAngle
    ? originalPlaybackUrl(baseUrl, projectId, { clipId: selectedAttachment.clip_id, mediaId: selectedAttachment.media_id, selectionKey: selectedPlaybackKey })
    : null;
  const playbackUrl = (selectedAngle?.playback.url && canPreviewReviewPlayback(selectedAngle.playback) ? selectedAngle.playback.url : null) || standaloneUrl;
  const playbackStart = locatedRange && locatedRange.recordId === selectedRecordId && locatedRange.clipId === selectedClipId
    ? locatedRange.start : selectedAngle?.playback.source_start ?? selectedAngle?.source_start ?? 0;
  const playbackKey = `${selectedPlaybackKey}-${playbackRetry}-${playbackStart}`;
  const videoAspect = videoGeometry?.key === playbackKey ? videoGeometry.aspect : 16 / 9;
  const inlinePlayerVisible = inspectorOpen && inspectingMedia;

  function closeQuickLook(restoreFocus = true): void {
    setQuickLookOpen(false);
    if (restoreFocus && quickLookFocusRef.current?.isConnected) quickLookFocusRef.current.focus({ preventScroll: true });
  }

  function toggleQuickLook(): void {
    if (quickLookOpen) { closeQuickLook(); return; }
    if (!active || intervalSurface || !playbackUrl) return;
    quickLookFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
    const player = playerRef.current;
    if (player && !player.paused && (!active || intervalSurface || (!inlinePlayerVisible && !quickLookOpen))) player.pause();
    if (quickLookOpen && (!active || intervalSurface || !playbackUrl)) closeQuickLook(false);
  }, [active, intervalSurface, inlinePlayerVisible, playbackUrl, quickLookOpen]);

  useEffect(() => {
    const player = playerRef.current;
    const pauseHidden = () => { if (document.hidden && player && !player.paused) player.pause(); };
    document.addEventListener("visibilitychange", pauseHidden);
    return () => {
      document.removeEventListener("visibilitychange", pauseHidden);
      if (player && !player.paused) player.pause();
    };
  }, [playbackKey]);

  function currentLocation(): ProductionSelectionContext {
    const player = playerRef.current;
    const start = player && player.readyState >= 1 ? player.currentTime : playbackStart;
    if (!playbackUrl || !selection.clipId || !Number.isFinite(start) || start < 0) return selection;
    return { ...selection, sourceRange: { basis: "source", start } };
  }

  function openInspectedTake(destination: "script" | "review"): void {
    const takeGroupId = selected?.source_group_id;
    if (!takeGroupId) return;
    onOpenTake?.(destination, groupId === takeGroupId ? currentLocation() : { projectId, recordId, groupId: takeGroupId });
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
    setSelectedClipId((current) => row?.attachments.some((attachment) => attachmentKey(attachment) === current)
      ? current : row?.preferred_clip_id || (row?.attachments[0] ? attachmentKey(row.attachments[0]) : ""));
    setInspectorView("take");
  }, []);

  const selectClip = useCallback(function selectClip(clipId: string): void {
    setSelectedClipId(clipId);
    setInspectorView("media");
    setPlaybackFailedClipId("");
    setPlaybackRetry(0);
  }, []);

  function addBlank(seed?: Partial<Draft>): Draft {
    const row = blankDraft(seed);
    setDrafts((current) => [...current, row]);
    setSelectedRecordId(row.record_id);
    setSelectedClipId("");
    setInspectorView("take");
    setMessage("已新增空白场记；保存后才写入项目。");
    return row;
  }

  function applyPaperDraftCandidates(candidates: PaperVlmCandidate[]): void {
    if (!candidates.length) {
      setPaperIntakeOpen(false);
      return;
    }
    let firstRecordId = "";
    let firstClipId = "";
    let matchedCount = 0;
    let manualCount = 0;
    setDrafts((current) => {
      const next = [...current];
      const usedGroups = new Set<string>();
      // A take already owned by a saved human record must never be
      // overwritten by an AI proposal.
      for (const row of next) {
        if (row.source_group_id && !row.derived) usedGroups.add(row.source_group_id);
      }
      for (const candidate of candidates) {
        const matchedTake = matchPaperCandidateToTake(candidate, review, usedGroups);
        const take = matchedTake && !usedGroups.has(matchedTake.group_id) ? matchedTake : null;
        const existing = take
          ? next.find((row) => row.source_group_id === take.group_id && row.derived)
          : undefined;
        const mapped = take && review ? mappedScene(review, take) : null;
        const link = take ? "场记识别·已关联 Take" : "场记识别·待指定 Take";
        const patch: Partial<Draft> = {
          episode: candidate.episode,
          scene: candidate.scene,
          shot: candidate.shot,
          take_number: parseTakeNumber(candidate.take),
          status: candidate.status,
          note: candidate.note,
          ...(mapped ? { script_scene_id: mapped.sceneId } : {}),
          derivedSource: link,
        };
        const row: Draft = existing && take
          ? {
              ...existing,
              ...patch,
              attachments: mergeTakeAttachments(existing, take),
              dirty: true,
              derived: false,
            }
          : blankDraft({
              ...patch,
              ...(take ? {
                source_group_id: take.group_id,
                attachments: take.angles.map(attachmentFromAngle),
                xmlOrder: review?.take_groups.findIndex((item) => item.group_id === take.group_id) ?? Number.MAX_SAFE_INTEGER,
              } : {}),
            });
        if (existing && take) {
          const index = next.findIndex((item) => item.record_id === existing.record_id);
          if (index >= 0) next[index] = row;
        } else {
          next.push(row);
        }
        if (take) {
          usedGroups.add(take.group_id);
          matchedCount += 1;
        } else {
          manualCount += 1;
        }
        if (!firstRecordId) {
          firstRecordId = row.record_id;
          firstClipId = row.attachments[0] ? attachmentKey(row.attachments[0]) : "";
        }
      }
      return next;
    });
    setSelectedRecordId(firstRecordId);
    setSelectedClipId(firstClipId);
    setInspectorView("take");
    const linked = matchedCount ? `，已关联 ${matchedCount} 条同步 Take` : "";
    const manual = manualCount ? `，${manualCount} 条待人工指定 Take` : "";
    setMessage(`已填入 ${candidates.length} 条未保存草稿${linked}${manual}；请核对后点击右上角「保存」。`);
    setPaperIntakeOpen(false);
  }

  /** Re-run take alignment after sync/script matching has finished. */
  function realignPaperDrafts(): void {
    if (!review) {
      setMessage("同步数据或剧本映射尚未就绪，无法自动对齐；请稍后刷新再试。");
      return;
    }
    let aligned = 0;
    setDrafts((current) => {
      const next = current.map((row) => ({ ...row }));
      const usedGroups = new Set<string>();
      for (const row of next) {
        if (row.source_group_id && !row.derived) usedGroups.add(row.source_group_id);
      }
      for (const row of next) {
        if (!row.derivedSource.startsWith("场记识别") || row.source_group_id) continue;
        const candidate: PaperVlmCandidate = {
          page: "1",
          row: 1,
          episode: row.episode,
          scene: row.scene,
          shot: row.shot,
          take: row.take_number ? `T${row.take_number}` : "",
          status: row.status,
          note: row.note,
          confidence: 1,
          authority: false,
        };
        const take = matchPaperCandidateToTake(candidate, review, usedGroups);
        if (!take) continue;
        const mapped = mappedScene(review, take);
        row.source_group_id = take.group_id;
        row.script_scene_id = mapped?.sceneId || row.script_scene_id;
        row.attachments = mergeTakeAttachments(row, take);
        row.xmlOrder = review.take_groups.findIndex((item) => item.group_id === take.group_id) ?? Number.MAX_SAFE_INTEGER;
        row.derivedSource = "场记识别·已关联 Take";
        row.dirty = true;
        row.derived = false;
        usedGroups.add(take.group_id);
        aligned += 1;
      }
      return next;
    });
    setMessage(aligned
      ? `已按当前同步与剧本映射关联 ${aligned} 条场记；请核对后保存。`
      : "没有新的场记可自动关联；请确认同步与剧本匹配已完成，或手动指定 Take。");
  }
  applyPaperDraftsRef.current = applyPaperDraftCandidates;
  realignPaperDraftsRef.current = realignPaperDrafts;

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
          take_number: row.take_number ?? existing?.take_number ?? null,
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
      selectClip(attachmentKey(additions[0]));
    } else {
      const row = blankDraft({ attachments: additions });
      setDrafts((current) => [...current, row]);
      setSelectedRecordId(row.record_id);
      selectClip(attachmentKey(additions[0]));
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
    const player = playerRef.current;
    if (!player || player.readyState < 1 || !Number.isFinite(player.currentTime)) { setMessage("先打开素材预览。"); return; }
    const current = player.currentTime;
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
    return <MirrorOrderMediaCard model={model} compact selected={key === selectedClip} preferred={draft.preferred_clip_id === key}
      onSelect={() => { setSelectedRecordId(draft.record_id); selectClip(key); }} />;
  }, [previewsActive, cameraColumns, angleIndex, selectRecord, selectClip]);

  const startEdit = useCallback(() => {
    setEditLayout(current => current ?? new Map(orderRows(draftViewRef.current.rows, orderMode)
      .map((row, index) => [row.record_id, { index, placed: isPlacedDraft(row) }])));
  }, [orderMode]);
  const endEdit = useCallback(() => setEditLayout(null), []);
  function renderRow(draft: Draft) {
    const selected = draft.record_id === selectedRecordId;
    return <DraftSlateRow key={draft.record_id} draft={draft} rowNumber={(displayIndexByRecord.get(draft.record_id) ?? -1) + 1}
      selected={selected} selectedClip={selected && inspectingMedia ? selectedClipId : undefined} cameraColumns={cameraColumns} mediaCell={mediaCell}
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
  const inspectorRowNumber = selected && displayIndexByRecord.get(selected.record_id);
  const inspectorToggleLabel = inspectorOpen ? "收起右侧详情栏" : "展开右侧详情栏";

  return (<div className="slate-workbench-content" data-interval-surface={intervalSurface || undefined} ref={slateRef}>
    {intervalSurface ? (
      <header className="golden-slate-subbar">
        <div className="golden-slate-subbar-left">
          {ledgerSurface ? (
            <nav className="slate-interval-view-switch mo-segmented" aria-label="场记工作视图">
              <button type="button" aria-pressed={false} onClick={() => setSlateSurface("takes")}>场记表</button>
              <button type="button" className="is-active" aria-pressed={true} onClick={() => setSlateSurface("intervals")}>原始片段</button>
            </nav>
          ) : null}
        </div>
      </header>
    ) : null}
    {ledger && <div hidden={!intervalSurface} className="slate-interval-surface-pane">
      <SlateIntervalBoardSurface key={JSON.stringify([baseUrl,projectId])} {...ledger} baseUrl={baseUrl} projectName={projectName} productionRows={productionRows} onOpenProduction={openProductionSource} catalog={(review?.episodes ?? []).flatMap((entry)=>entry.scenes.map((scene)=>({episode:entry.episode,scene_id:scene.scene_id,label:prettySceneId(scene.scene_id)})))}/>
    </div>}
    {intervalSurface && !ledger && <section aria-label="电子场记板" className="slate-interval-surface-pane">
      <SlateOriginalFormSheet page={{title:projectName?.trim()||"",day:"",date:"",printedPage:""}} rows={[]} />
      {nativeIntervalLedger.error ? <><p role="alert">{nativeIntervalLedger.error}</p><button type="button" onClick={()=>void nativeIntervalLedger.refresh().catch(()=>{})}>重读列表</button></> : <p role="status">正在读取电子场记板…</p>}
    </section>}
    <div hidden={intervalSurface}><section className={`golden-slate-workbench ${inspectorOpen ? "has-inspector" : ""} ${dropActive ? "is-file-drop-active" : ""}`}>
      <header className="golden-slate-subbar">
        <div className="golden-slate-subbar-left">
          {ledgerSurface && <nav className="slate-interval-view-switch mo-segmented" aria-label="场记工作视图">
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
          <button
            type="button"
            className={`golden-slate-photo-import${paperIntakeOpen ? " is-active" : ""}`}
            aria-haspopup="dialog"
            aria-expanded={paperIntakeOpen}
            title="导入场记 PDF 或照片（AI 提取）"
            onClick={() => setPaperIntakeOpen(true)}
          >导入场记</button>
          <span className="golden-slate-message" aria-live="polite" title={message}>{message}</span>
        </div>
        <div className="golden-slate-actions golden-slate-subbar-right" role="group" aria-label="场记辅助操作">
          <div className="golden-slate-inline-tools" role="group" aria-label="视图与工具">
            {hasUnlinkedPaperDrafts && review ? (
              <button type="button" onClick={realignPaperDrafts} title="按场次和拍摄顺序把未关联的场记草稿对齐到同步 Take">对齐 Take</button>
            ) : null}
            <button type="button" className={orderMode === "script" ? "is-filter-active" : ""} aria-pressed={orderMode === "script"} title="按集 / 场号 / 镜号归类并检查漏填" onClick={() => { setEditLayout(null); setOrderMode((value) => value === "script" ? "shooting" : "script"); }}>按场号归类</button>
            <button type="button" className={`golden-slate-ng-filter${hideNgRows ? " is-filter-active" : ""}`}
              disabled={!ngCount && !hideNgRows} aria-pressed={hideNgRows} title={`${ngCount} 条场记 NG`}
              onClick={() => setHideNgRows((value) => !value)}>隐藏 NG ({ngCount})</button>
            <button type="button" className="golden-slate-refresh-btn" disabled={busy} onClick={() => void reload(selectedRecordId)} aria-label="刷新场记" title="重新读取最新场记">刷新</button>
          </div>
          <span
            className="golden-slate-save-state"
            data-state={busy ? "saving" : loadError ? "error" : dirtyCount ? "dirty" : board ? "saved" : "idle"}
            aria-live="polite"
          >
            {busy ? "保存中…" : loadError ? "读取失败" : draftConflicts.size ? `${draftConflicts.size} 条草稿需核对` : dirtyCount ? `未保存 ${dirtyCount}` : board ? "已保存" : "等待加载"}
          </span>
          <button type="button" className={`golden-slate-save-button${dirtyCount > 0 ? " is-dirty" : ""}`} disabled={busy || !board || dirtyCount === 0 || draftConflicts.size > 0} onClick={() => {
            if (!actor.trim()) { requestCurrentOperator(); setMessage("保存场记前需要操作者昵称。"); return; }
            void saveAll();
          }}>保存{dirtyCount ? ` ${dirtyCount}` : ""}</button>
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
        <div className={`golden-slate-table-shell${slateState?.slate_attached ? " has-pending-file" : ""}`}>
          {dropActive ? <div className="golden-slate-drop-overlay">松开以加入当前场记</div> : null}
          {slateState?.slate_attached ? (
            <div className="golden-slate-pending-file" role="region" aria-label="项目场记识别状态">
              <span>
                项目场记：{slateState.slate_name || "场记文件"}
                {slateState.status === "running" || slateState.status === "queued"
                  ? ` · 后台逐页识别 ${slateState.pages_done}/${slateState.pages_total || "?"}`
                  : slateState.status === "completed"
                    ? ` · 已自动识别 ${slateState.candidates.length} 条并填入主表草稿`
                    : slateState.status === "failed"
                      ? ` · 识别失败：${slateState.error || "请检查视觉模型设置"}`
                      : ""}
              </span>
              <div>
                <button type="button" onClick={() => setPaperIntakeOpen(true)}>{slateState.status === "completed" ? "查看候选明细" : "核对候选"}</button>
                {(slateState.status === "none" || slateState.status === "failed" || slateState.status === "cancelled" || slateState.status === "completed") ? (
                  <button type="button" className="secondary" disabled={busy || slateBusy} onClick={() => { void startSlateRecognition(); }}>
                    {slateState.status === "completed" ? "重新识别" : "开始识别"}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {orderMode === "shooting" && displayedDrafts.length ? (
            section("真实拍摄顺序 · 全场记", displayedDrafts, "placed", false)
          ) : placedDrafts.length && unplacedDrafts.length ? (
            <div className="golden-slate-split-sections">{section("已填场号 · 按场次排列", placedDrafts, "placed")}{section("未填场号 · 按拍摄顺序", unplacedDrafts, "unplaced")}</div>
          ) : placedDrafts.length ? section("已填场号 · 按场次排列", placedDrafts, "placed") : unplacedDrafts.length ? section("未填场号 · 按拍摄顺序", unplacedDrafts, "unplaced") : loadError ? (
            <div className="golden-slate-empty golden-slate-load-error" role="alert">
              <strong>场记读取失败</strong>
              <span>{message}</span>
              <button type="button" onClick={() => void reload(selectedRecordId)}>重新读取</button>
            </div>
          ) : (
            <div className="golden-slate-empty"><strong>从 Take 或场记 PDF / 照片开始</strong><span>A / B / C 机位落在同一行；场记 PDF 或照片可直接上传让 AI 提取草稿。</span><div><button type="button" onClick={() => setPaperIntakeOpen(true)}>导入场记 PDF / 照片</button><button type="button" className="secondary" onClick={() => setTakePickerOpen(true)}>从 Take 加入</button><button type="button" className="secondary" onClick={() => addBlank()}>新建空白场记</button></div></div>
          )}
        </div>

        <aside className="golden-slate-inspector" aria-label="场记详情" onKeyDown={(event) => {
          if (event.key !== "Escape" || event.defaultPrevented || !inspectorOpen || quickLookOpen || takePickerOpen) return;
          event.preventDefault();
          changeInspectorVisibility(false);
          inspectorToggleRef.current?.focus();
        }}>
          <header className="golden-inspector-bar">
            {inspectorOpen && selected ? <div className="golden-inspector-switch" role="group" aria-label="详情范围">
              <button type="button" aria-pressed={!inspectingMedia} onClick={() => setInspectorView("take")}>Take</button>
              <button type="button" aria-pressed={inspectingMedia} disabled={!selectedAttachment} onClick={() => setInspectorView("media")}>素材</button>
            </div> : null}
            <button ref={inspectorToggleRef} type="button" className="golden-inspector-toggle"
              aria-expanded={inspectorOpen} aria-controls={inspectorContentId}
              aria-label={inspectorToggleLabel} title={inspectorToggleLabel}
              onClick={() => changeInspectorVisibility(!inspectorOpen)}>
              <StudioIcon name="inspector" size={17} />
            </button>
          </header>
          <div ref={inspectorContentRef} className="golden-inspector-content" id={inspectorContentId} hidden={!inspectorOpen && !quickLookOpen}>
            {selected ? <>
              <div className="golden-inspector-overview" hidden={!inspectorOpen || inspectingMedia}>
                <header className="golden-inspector-head">
                  <h3>场记{typeof inspectorRowNumber === "number" ? ` ${String(inspectorRowNumber + 1).padStart(3, "0")}` : ""}</h3>
                  <select aria-label="Take 状态" value={selected.status}
                    onChange={(event) => patchRecord(selected.record_id, { status: event.target.value as SlateRecord["status"] })}>
                    {SLATE_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </header>
                <dl className="golden-inspector-slate-fields">
                  <div><dt>集</dt><dd>{selected.episode ?? "—"}</dd></div>
                  <div><dt>场号</dt><dd>{selected.scene || "—"}</dd></div>
                  <div><dt>镜号</dt><dd>{selected.shot || "—"}</dd></div>
                  <div><dt>次号</dt><dd>{selected.take_number ?? "—"}</dd></div>
                </dl>
              </div>
              <section className="golden-inspector-take" aria-label="Take 详情" hidden={!inspectorOpen || inspectingMedia}>
                <label className="golden-inspector-field"><span>Take 备注</span><textarea rows={3} value={selected.note}
                  onChange={(event) => patchRecord(selected.record_id, { note: event.target.value })} /></label>
                <div className="golden-quick-tags" role="group" aria-label="快捷现场标签">
                  {QUICK_SLATE_TAGS.map((tag) => (
                    <button key={tag} type="button" className="secondary" onClick={() => appendNoteTag(tag)}>+ {tag}</button>
                  ))}
                  <button type="button" className="secondary" onClick={markSelectedMisrecorded}>标为误录</button>
                </div>
                {inspectorAttachments.length ? <div className="golden-inspector-take-sources">
                  <h4>机位素材</h4>
                  <SlateInspectorSources attachments={inspectorAttachments} selected=""
                    preferred={selected.preferred_clip_id} onSelect={selectClip} />
                </div> : <button type="button" className="golden-inspector-add-take"
                  onClick={() => setTakePickerOpen(true)}>＋ 加入 Take / 镜头</button>}
                {selected.source_group_id && onOpenTake ? <div className="golden-inspector-navigation">
                  <button type="button" className="secondary" onClick={() => openInspectedTake("script")}>在剧本中打开</button>
                  <button type="button" className="secondary" onClick={() => openInspectedTake("review")}>看片审阅</button>
                </div> : null}
                {episodeCandidates.length ? <section className="golden-episode-candidates"><header><strong>第 {selected.episode} 集候选</strong><span>{episodeCandidates.length} Take</span></header>{episodeCandidates.map((take) => <TakeListRow key={take.group_id} take={take} onSelect={() => addTake(take)} />)}</section> : null}
                <details className="golden-inspector-advanced">
                  <summary>Take 入出点</summary>
                  <div className="golden-inspector-advanced-body golden-io-row">
                    <label><span>入点（秒）</span><input type="number" step="0.01" min="0" value={selected.usable_range?.start ?? ""}
                      onChange={(event) => {
                        const start = event.target.value ? Number(event.target.value) : 0;
                        const end = selected.usable_range?.end ?? start + 0.04;
                        patchRecord(selected.record_id, { usable_range: { start, end: Math.max(end, start + 0.04) } });
                      }} /></label>
                    <label><span>出点（秒）</span><input type="number" step="0.01" min="0" value={selected.usable_range?.end ?? ""}
                      onChange={(event) => {
                        const end = event.target.value ? Number(event.target.value) : 0;
                        const start = selected.usable_range?.start ?? 0;
                        if (end > start) patchRecord(selected.record_id, { usable_range: { start, end } });
                      }} /></label>
                  </div>
                </details>
                {selected.script_scene_id.trim() || selectedTake?.transcript.text.trim() ? <details className="golden-inspector-advanced">
                  <summary>剧本与对白</summary>
                  <div className="golden-inspector-advanced-body golden-inspector-script">
                    {selected.script_scene_id.trim() ? <strong>剧本场景 · {selected.script_scene_id}</strong> : null}
                    {selectedTake?.transcript.text.trim() ? <p>{selectedTake.transcript.text.trim()}</p> : null}
                  </div>
                </details> : null}
              </section>
              {selectedAttachment ? <SlateInspectorClipHeader camera={selectedAttachment.camera} filename={selectedFilename}
                hidden={!inlinePlayerVisible} /> : null}
                <div className={`golden-slate-player${quickLookOpen ? " golden-quicklook-popover" : ""}`}
                  hidden={!quickLookOpen && !inlinePlayerVisible}
                  role={quickLookOpen ? "dialog" : undefined} aria-label={quickLookOpen ? "场记快速预览" : undefined}
                  style={{ "--slate-video-aspect": videoAspect } as CSSProperties}>
                  {quickLookOpen && <header>
                    <strong>{selectedFilename || "素材"}</strong>
                    <button ref={quickLookCloseRef} type="button" className="secondary" onClick={() => closeQuickLook()}>关闭 (Esc)</button>
                  </header>}
                  {playbackUrl && !selectedPlaybackFailed ? (
                    <video ref={playerRef} key={playbackKey}
                      src={playbackUrl} controls preload={previewsActive && (inlinePlayerVisible || quickLookOpen) ? "auto" : "none"} playsInline
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
                </div>
              {selectedAttachment ? <section className="golden-inspector-media" aria-label="素材详情" hidden={!inlinePlayerVisible}>
                <SlateInspectorSources attachments={inspectorAttachments} selected={selectedClipId}
                  selectedCamera={selectedAttachment.camera} preferred={selected.preferred_clip_id} onSelect={selectClip} />
                <div className="golden-inspector-navigation">
                  <button type="button" className="secondary" disabled={!playbackUrl} onClick={toggleQuickLook}>快速预览</button>
                  {groupId && onOpenTake ? <button type="button" className="secondary"
                    onClick={() => onOpenTake("material", currentLocation())}>在素材中打开</button> : null}
                  {selectedPlaybackFailed && onRepair ? <button type="button" className="secondary" onClick={onRepair}>检查本机素材</button> : null}
                </div>
                <div className="golden-angle-fields">
                  <label><span>景别</span><select value={selectedAttachment.shot_type || "unknown"}
                    onChange={(event) => patchAttachment(selected.record_id, selectedClipId, { shot_type: event.target.value })}>
                    {SHOT_OPTIONS.map((shot) => <option value={shot} key={shot}>{SHOT_LABELS[shot] ?? shot}</option>)}
                  </select></label>
                  <button type="button" className="secondary golden-angle-prefer" aria-pressed={selected.preferred_clip_id === selectedClipId}
                    onClick={() => patchRecord(selected.record_id, { preferred_clip_id: selected.preferred_clip_id === selectedClipId ? "" : selectedClipId })}>
                    {selected.preferred_clip_id === selectedClipId ? "★ 取消首选" : "☆ 设为首选"}
                  </button>
                  <label className="golden-angle-note"><span>素材备注</span><input value={selectedAttachment.note || ""}
                    onChange={(event) => patchAttachment(selected.record_id, selectedClipId, { note: event.target.value })} /></label>
                </div>
                <details
                  className="golden-inspector-advanced"
                  open={advancedToolsOpen || Boolean(paperSource)}
                  onToggle={(event) => setAdvancedToolsOpen(event.currentTarget.open)}
                >
                  <summary>打板、转写与源区间</summary>
                  <div className="golden-inspector-advanced-body">
                    {clipId ? (
                      <div className="golden-clapper-bar">
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy || clapperBusy}
                          onClick={() => void detectClapperboardFrame()}
                        >
                          {clapperBusy ? "正在识别打板帧…" : "从打板填写 Take"}
                        </button>
                      </div>
                    ) : null}
                    <div className="golden-io-row">
                      <button type="button" className="secondary" onClick={() => setIO("in")}>I 设 Take 入点</button>
                      <button type="button" className="secondary" onClick={() => setIO("out")}>O 设 Take 出点</button>
                    </div>
                    {(advancedToolsOpen || Boolean(paperSource)) && selectedAttachment?.clip_id ? <SlateSpeechEvidencePanel key={`${baseUrl}:${projectId}:${selectedAttachment.clip_id}:${selectedAttachment.media_id}`} baseUrl={baseUrl} projectId={projectId} clipId={selectedAttachment.clip_id} mediaId={selectedAttachment.media_id} /> : null}
                    {selectedAttachment?.clip_id && selectedAttachment.media_id ? (
                      <details className="golden-slate-advanced-interval" open={Boolean(paperSource)}>
                        <summary>精确源帧区间核验（可选）</summary>
                        <SlateSourceIntervalPanel key={`${baseUrl}:${projectId}:${selected.record_id}:${selectedAttachment.clip_id}:${selectedAttachment.media_id}:${board?.revision}:${paperSource?.row.paper_row_id}:${paperSource?.revision}`} paperSource={paperSource} baseUrl={baseUrl} projectId={projectId} recordId={selected.record_id} clipId={selectedAttachment.clip_id} mediaId={selectedAttachment.media_id} savedRecord={board?.records[selected.record_id]} boardRevision={board?.revision ?? -1} dirty={selected.dirty} />
                      </details>
                    ) : null}
                  </div>
                </details>
                <details className="golden-inspector-advanced">
                  <summary>素材管理</summary>
                  <div className="golden-inspector-advanced-body golden-angle-fields">
                    <label><span>机位</span><input value={selectedAttachment.camera}
                      onChange={(event) => patchAttachment(selected.record_id, selectedClipId, { camera: event.target.value })} /></label>
                    <button type="button" className="secondary golden-angle-remove" onClick={() => removeAttachment(selected.record_id, selectedClipId)}>移出本条场记</button>
                  </div>
                </details>
              </section> : null}
            </> : <div className="golden-inspector-empty">选择一条场记</div>}
          </div>
          {selected && inspectorOpen ? <footer className="golden-inspector-footer">
                {selectedConflict && <section className="golden-inspector-link" aria-label="场记草稿冲突">
                  <strong>{selectedServerRecord ? "服务端已更新这条场记" : "服务端已删除或替换原场记"}</strong>
                  {selectedServerRecord && <details>
                    <summary>查看服务端场记</summary>
                    <p>第 {selectedServerRecord.episode ?? "—"} 集 · 场 {selectedServerRecord.scene || selectedServerRecord.script_scene_id || "—"} · 镜 {selectedServerRecord.shot || "—"} · 次 {selectedServerRecord.take_number ?? "—"}</p>
                    {selectedServerRecord.note && <p>{selectedServerRecord.note}</p>}
                  </details>}
                </section>}
                <div className="golden-inspector-actions">
                  <button type="button" disabled={busy || !board || !selected.dirty || (selectedConflict && !selectedPersisted)} onClick={() => {
                    if (!actor.trim()) { requestCurrentOperator(); setMessage("保存场记前需要操作者昵称。"); return; }
                    void saveSelected();
                  }}>
                    {selectedConflict && selectedPersisted ? "用草稿覆盖…" : "保存当前行"}
                  </button>
                  {selectedConflict ? <button type="button" className="secondary" disabled={busy} onClick={discardConflictingDraft}>放弃此草稿…</button>
                    : !inspectingMedia && selectedCanDelete ? <button type="button" className="danger-subtle" disabled={busy} onClick={() => void requestDeleteSelected()}>{selectedPersisted ? "删除人工场记…" : "移除草稿…"}</button> : null}
                </div>
          </footer> : null}
        </aside>
      </div>

      <SlatePaperIntake
        key={`${baseUrl}:${projectId}`}
        baseUrl={baseUrl}
        projectId={projectId}
        open={paperIntakeOpen}
        onOpenChange={setPaperIntakeOpen}
        hideTrigger
        onSelect={(source) => {
          setPaperSource(source);
          if (source) { setInspectorOpen(true); setInspectorView("media"); }
        }}
        onApplyDraftCandidates={applyPaperDraftCandidates}
        recognition={slateState}
        recognitionBusy={slateBusy}
        onStartRecognition={() => { void startSlateRecognition(); }}
      />

    </section></div>
  </div>);
}
