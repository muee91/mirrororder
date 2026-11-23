import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { DesktopClient } from "../../api/desktop";
import { ProductionClient, type SlateBoard, type SlateRecord } from "../../api/production";
import { readCurrentOperator, requestCurrentOperator } from "../../components/CurrentOperatorControl";
import { SlateStatusIndicator } from "../../components/StatusIndicators";
import { cameraPresentation } from "../media/cameraPresentation";
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { ProductionSelectionContext } from "../production/productionNavigation";
import type {
  ProjectSummary,
  ReviewEpisode,
  ReviewScriptBlock,
  ReviewTakeGroup,
} from "../../api/host";
import { RoughPlacementClient, type RoughPlacementPayload } from "../../api/roughPlacement";
import { ScriptAssignmentDecision } from "./ScriptAssignmentDecision";
import { ScriptEpisodeView, dragGroupId, scriptDomId } from "../material-script/ScriptEpisodeView";
import type { ScriptProjectionMode } from "../material-script/ScriptBlock";
import { mappingLabel, takeDisplayLabel } from "../material-script/TakeCard";
import { isPlaceableScriptBlock } from "./scriptSemantics";
import { TakeInspector } from "../material-script/TakeInspector";
import { DRAG_TAKE_MIME, VirtualTakeList, episodeLabel } from "../material-script/VirtualTakeList";
import {
  candidateTakeIds,
  mappedTakeIds,
  preferredScriptSegmentId,
  relatedTakeIds,
  takeEpisodeIds,
} from "../material-script/model";
import {
  reviewModelErrorMessage,
  reviewWriteNeedsRefresh,
  useReviewModelSnapshot,
} from "../material-script/useReviewModelSnapshot";
import "../material-script/material-script.css";

// Cross-workspace labels remain part of the Material workspace contract. >在素材中打开</button> >在审阅中打开</button> >到时间线</button>

type DrawerView = "pool" | "segment" | "detail" | "batch";
type WriteState = "idle" | "saving" | "error";

interface Props {
  baseUrl: string;
  project: ProjectSummary;
  initialGroupId?: string | null;
  initialClipId?: string | null;
  initialScriptSegmentId?: string | null;
  playbackFocus?: ProductionSelectionContext;
  onSelectionChange?: (groupId: string | null, clipId: string | null, scriptSegmentId: string | null) => void;
  onOpenMaterial?: (groupId: string, clipId?: string | null, scriptSegmentId?: string | null) => void;
  onOpenSlate?: (groupId: string, clipId?: string | null, scriptSegmentId?: string | null) => void;
  onOpenReview?: (groupId: string, clipId?: string | null, scriptSegmentId?: string | null) => void;
  onOpenTimeline?: (groupId: string, clipId?: string | null, scriptSegmentId?: string | null) => void;
}

const ACTOR_STORAGE_KEY = "mirrororder.desktop-v2.review-actor";
const PROJECTION_OPTIONS: Array<{ value: ScriptProjectionMode; label: string }> = [
  { value: "script", label: "正文" },
  { value: "coverage", label: "覆盖" },
  { value: "issues", label: "问题" },
];

function storedActor(): string {
  try {
    return globalThis.localStorage?.getItem(ACTOR_STORAGE_KEY)?.trim() || readCurrentOperator();
  } catch {
    return readCurrentOperator();
  }
}

function saveActor(actor: string): void {
  try {
    globalThis.localStorage?.setItem(ACTOR_STORAGE_KEY, actor.trim());
  } catch {
    // Device-local convenience only.
  }
}

function roughPreviewLabel(plan: RoughPlacementPayload["plans"][number]): string {
  const range = plan.take_start === plan.take_end ? `T${plan.take_start}` : `T${plan.take_start}–T${plan.take_end}`;
  return `${range} → EP${plan.episode}`;
}

function firstPlaceableBlock(episode: ReviewEpisode | null): ReviewScriptBlock | null {
  if (!episode) return null;
  for (const scene of episode.scenes) {
    const block = scene.script_blocks.find(isPlaceableScriptBlock);
    if (block) return block;
  }
  return null;
}

function episodeHasSegment(episode: ReviewEpisode | null, segmentId: string | null): boolean {
  if (!episode || !segmentId) return false;
  return episode.scenes.some((scene) => scene.script_blocks.some((block) => block.segment_id === segmentId));
}

function findScriptBlock(episodes: ReviewEpisode[], segmentId: string | null | undefined): ReviewScriptBlock | null {
  if (!segmentId) return null;
  for (const episode of episodes) {
    for (const scene of episode.scenes) {
      const block = scene.script_blocks.find((item) => item.segment_id === segmentId);
      if (block) return block;
    }
  }
  return null;
}

function scriptBlockSearchText(sceneHeading: string, block: ReviewScriptBlock): string {
  return [sceneHeading, block.speaker, block.type, block.text, block.raw_text, ...block.issues.map((issue) => issue.label)]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("zh-CN");
}

function takeSearchText(take: ReviewTakeGroup): string {
  return [
    takeDisplayLabel(take),
    take.transcript.text,
    mappingLabel(take),
    ...take.angles.flatMap((angle) => [angle.name, angle.camera, angle.shot_type || ""]),
  ].join(" ").toLocaleLowerCase("zh-CN");
}

function slateRecordForTake(board: SlateBoard | null, take: ReviewTakeGroup): SlateRecord | null {
  if (!board) return null;
  const angles = new Set(take.angles.map((angle) => angle.clip_id).filter(Boolean));
  return Object.values(board.records).find((record) => (
    record.source_group_id === take.group_id
    || record.attachments.some((attachment) => angles.has(attachment.clip_id))
  )) ?? null;
}

function slateCoordinates(record: SlateRecord): string {
  return `场 ${record.scene || record.script_scene_id || "—"} · 镜 ${record.shot || "—"} · 次 ${record.take_number ?? "—"}`;
}

function slateStatusLabel(record: SlateRecord): string {
  return { usable: "可用", partial: "部分可用", ng: "NG", unmarked: "未标" }[record.status];
}

function normalizeSceneKey(value: string): string {
  const match = value.trim().match(/\b(\d+)\s*[-－]\s*(\d+)\b/);
  return match ? `${match[1]}-${match[2]}` : value.trim().toLocaleLowerCase("zh-CN");
}

function sceneRecordMatches(record: SlateRecord, episode: number, sceneKey: string): boolean {
  if (record.episode !== episode) return false;
  return [record.scene, record.script_scene_id].some((value) => normalizeSceneKey(value) === sceneKey);
}

function ScriptSlateLinkage({
  record,
  groupId,
  clipId,
  scriptSegmentId,
  onOpenSlate,
}: {
  record: SlateRecord;
  groupId: string;
  clipId?: string | null;
  scriptSegmentId?: string | null;
  onOpenSlate?: Props["onOpenSlate"];
}) {
  return (
    <div className="script-slate-linkage" aria-label="关联场记">
      <div className="script-slate-linkage-copy">
        <span className="script-slate-linkage-coordinates">{slateCoordinates(record)}</span>
        <SlateStatusIndicator state={record.status} label={slateStatusLabel(record)} />
        {record.note.trim() ? <small title={record.note}>{record.note.trim()}</small> : null}
      </div>
      {onOpenSlate ? (
        <button
          type="button"
          className="secondary script-slate-linkage-action"
          onClick={() => onOpenSlate(groupId, clipId, scriptSegmentId)}
        >
          在场记中打开
        </button>
      ) : null}
    </div>
  );
}

export function ScriptWorkspace({
  baseUrl,
  project,
  initialGroupId = null,
  initialClipId = null,
  initialScriptSegmentId = null,
  playbackFocus,
  onSelectionChange,
  onOpenSlate,
  onOpenReview,
}: Props) {
  const { connection, loadState, message, model, refresh } = useReviewModelSnapshot(baseUrl, project.project_id);
  const [slateBoard, setSlateBoard] = useState<SlateBoard | null>(null);
  const roughPlacement = useMemo(() => new RoughPlacementClient(baseUrl), [baseUrl]);
  const [activeEpisode, setActiveEpisode] = useState<number | null>(null);
  const [projectionMode, setProjectionMode] = useState<ScriptProjectionMode>("script");
  const [query, setQuery] = useState("");
  const [selectedScriptSegmentId, setSelectedScriptSegmentId] = useState<string | null>(initialScriptSegmentId);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(initialGroupId);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(initialClipId);
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [actor, setActor] = useState(storedActor);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [drawerView, setDrawerView] = useState<DrawerView>(initialGroupId ? "detail" : "pool");
  const [poolQuery, setPoolQuery] = useState("");
  const [poolSceneOnly, setPoolSceneOnly] = useState(false);
  const [detailReturnView, setDetailReturnView] = useState<"pool" | "segment">("pool");
  const [writeState, setWriteState] = useState<WriteState>("idle");
  const [scriptPath, setScriptPath] = useState("");
  const [attachState, setAttachState] = useState<"idle" | "saving" | "submitted" | "error">("idle");
  const [attachMessage, setAttachMessage] = useState("");
  const attaching = useRef(false);
  const [autoMatchState, setAutoMatchState] = useState<"idle" | "submitting" | "submitted" | "error">("idle");
  const [autoMatchMessage, setAutoMatchMessage] = useState("");
  const [autoMatchDismissed, setAutoMatchDismissed] = useState(false);
  const [writeMessage, setWriteMessage] = useState("");
  const [roughText, setRoughText] = useState("");
  const [roughPreview, setRoughPreview] = useState<RoughPlacementPayload | null>(null);
  const [auditionIndex, setAuditionIndex] = useState(0);
  const [auditionAutoAdvance, setAuditionAutoAdvance] = useState(true);
  const auditionVideoRef = useRef<HTMLVideoElement | null>(null);
  const appliedFocusKey = useRef("");

  useEffect(() => {
    let active = true;
    void new ProductionClient(baseUrl)
      .scriptSupervisor(project.project_id)
      .then((board) => { if (active) setSlateBoard(board); })
      .catch(() => { if (active) setSlateBoard(null); });
    return () => { active = false; };
  }, [baseUrl, project.project_id]);

  // The top-level operator control is shared by every workspace. Keep the
  // Script placement and assignment-decision writes in sync when that control
  // changes without requiring a workspace remount or manual refresh.
  useEffect(() => {
    const sync = () => setActor(storedActor());
    globalThis.addEventListener("mirrororder:operator-change", sync);
    globalThis.addEventListener("storage", sync);
    return () => {
      globalThis.removeEventListener("mirrororder:operator-change", sync);
      globalThis.removeEventListener("storage", sync);
    };
  }, []);

  const selectedTake = selectedGroupId
    ? model?.take_groups.find((take) => take.group_id === selectedGroupId) ?? null
    : null;
  const selectedEpisode = model?.episodes.find((episode) => episode.episode === activeEpisode) ?? model?.episodes[0] ?? null;

  const selectedBlock = useMemo(() => {
    if (!model) return null;
    return findScriptBlock(model.episodes, selectedScriptSegmentId);
  }, [model, selectedScriptSegmentId]);

  useEffect(() => {
    setAuditionIndex(0);
  }, [selectedScriptSegmentId]);

  const auditionTakes = useMemo(() => {
    if (!model || !selectedBlock) return [];
    const ids = relatedTakeIds(model, selectedBlock.segment_id);
    const byId = new Map(model.take_groups.map((item) => [item.group_id, item]));
    return ids.map((id) => byId.get(id)).filter((item): item is ReviewTakeGroup => Boolean(item));
  }, [model, selectedBlock]);

  const activeAuditionTake = auditionTakes[Math.min(auditionIndex, Math.max(0, auditionTakes.length - 1))] ?? null;
  const activeAuditionAngle = activeAuditionTake?.angles.find((angle) => Boolean(angle.playback?.url)) ?? activeAuditionTake?.angles[0] ?? null;
  const activeAuditionUrl = activeAuditionAngle?.playback?.url ?? "";
  const activeAuditionStart = activeAuditionAngle?.playback?.source_start ?? activeAuditionAngle?.source_start ?? 0;
  const activeAuditionSlate = activeAuditionTake ? slateRecordForTake(slateBoard, activeAuditionTake) : null;

  useEffect(() => {
    if (!model) return;
    const focusKey = `${project.project_id}:${initialGroupId ?? ""}:${initialClipId ?? ""}:${initialScriptSegmentId ?? ""}`;
    const shouldApplyFocus = Boolean(initialGroupId || initialScriptSegmentId) && appliedFocusKey.current !== focusKey;
    const focused = initialGroupId && shouldApplyFocus
      ? model.take_groups.find((take) => take.group_id === initialGroupId) ?? null
      : null;
    const requestedBlock = shouldApplyFocus ? findScriptBlock(model.episodes, initialScriptSegmentId) : null;

    if (focused || requestedBlock) {
      const segmentId = requestedBlock?.segment_id ?? (focused ? preferredScriptSegmentId(focused) : null);
      const episode = requestedBlock?.episode
        ?? focused?.effective_mapping.episode_ids[0]
        ?? (focused ? takeEpisodeIds(focused)[0] : null)
        ?? model.episodes[0]?.episode
        ?? null;
      setSelectedGroupId(focused?.group_id ?? null);
      setSelectedClipId(
        focused && initialClipId && focused.angles.some((angle) => angle.clip_id === initialClipId)
          ? initialClipId
          : focused?.angles[0]?.clip_id ?? null,
      );
      setActiveEpisode(episode);
      setSelectedScriptSegmentId(segmentId ?? firstPlaceableBlock(model.episodes.find((item) => item.episode === episode) ?? null)?.segment_id ?? null);
      setDrawerView(focused ? "detail" : "pool");
      setDetailReturnView("pool");
      setDrawerOpen(true);
      appliedFocusKey.current = focusKey;
      return;
    }

    setActiveEpisode((current) => current ?? model.episodes[0]?.episode ?? null);
    setSelectedScriptSegmentId((current) => current ?? firstPlaceableBlock(model.episodes[0] ?? null)?.segment_id ?? null);
    setSelectedGroupId((current) => current && model.take_groups.some((take) => take.group_id === current) ? current : null);
  }, [initialClipId, initialGroupId, initialScriptSegmentId, model, project.project_id]);

  useEffect(() => {
    if (!selectedEpisode) return;
    if (!episodeHasSegment(selectedEpisode, selectedScriptSegmentId)) {
      setSelectedScriptSegmentId(firstPlaceableBlock(selectedEpisode)?.segment_id ?? null);
    }
  }, [selectedEpisode, selectedScriptSegmentId]);

  useEffect(() => {
    if (!selectedScriptSegmentId) return;
    const frame = globalThis.requestAnimationFrame(() => {
      document.getElementById(scriptDomId(selectedScriptSegmentId))?.scrollIntoView({ block: "center" });
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [activeEpisode, selectedScriptSegmentId]);

  useEffect(() => {
    if (!model) return;
    onSelectionChange?.(selectedTake?.group_id ?? null, selectedClipId, selectedScriptSegmentId);
  }, [model, selectedTake?.group_id, selectedClipId, selectedScriptSegmentId]);

  const visibleEpisode = useMemo(() => {
    if (!selectedEpisode || !model) return null;
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    const scenes = selectedEpisode.scenes.flatMap((scene) => {
      const sceneMatches = Boolean(needle && scene.heading.toLocaleLowerCase("zh-CN").includes(needle));
      const scriptBlocks = scene.script_blocks.filter((block) => {
        const canPlace = isPlaceableScriptBlock(block);
        const mapped = mappedTakeIds(model, block.segment_id);
        const issueProjection = projectionMode !== "issues" || (canPlace && (mapped.length === 0 || block.issues.length > 0));
        if (!issueProjection) return false;
        if (!needle || sceneMatches) return true;
        return scriptBlockSearchText(scene.heading, block).includes(needle);
      });
      return scriptBlocks.length ? [{ ...scene, script_blocks: scriptBlocks }] : [];
    });
    return { ...selectedEpisode, scenes };
  }, [model, projectionMode, query, selectedEpisode]);

  const episodeStats = useMemo(() => {
    const result = { blocks: 0, mapped: 0, candidate: 0, attention: 0 };
    if (!selectedEpisode || !model) return result;
    for (const scene of selectedEpisode.scenes) {
      for (const block of scene.script_blocks) {
        if (!isPlaceableScriptBlock(block)) continue;
        result.blocks += 1;
        const mapped = mappedTakeIds(model, block.segment_id).length;
        const candidates = candidateTakeIds(model, block.segment_id).length;
        if (mapped) result.mapped += 1;
        if (candidates) result.candidate += 1;
        if (!mapped || block.issues.length) result.attention += 1;
      }
    }
    return result;
  }, [model, selectedEpisode]);

  useEffect(() => {
    if (!visibleEpisode || !selectedScriptSegmentId) return;
    const visible = episodeHasSegment(visibleEpisode, selectedScriptSegmentId);
    if (!visible && visibleEpisode.scenes.length) {
      setSelectedScriptSegmentId(firstPlaceableBlock(visibleEpisode)?.segment_id ?? null);
    }
  }, [selectedScriptSegmentId, visibleEpisode]);

  const selectedMappedTakeIds = selectedScriptSegmentId && model ? mappedTakeIds(model, selectedScriptSegmentId) : [];
  const selectedCandidateTakeIds = selectedScriptSegmentId && model ? candidateTakeIds(model, selectedScriptSegmentId) : [];
  const selectedTakeMappedHere = Boolean(selectedTake && selectedScriptSegmentId && selectedTake.effective_mapping.script_segment_ids.includes(selectedScriptSegmentId));

  const selectedScene = useMemo(() => selectedEpisode?.scenes.find((scene) => scene.script_blocks.some((block) => block.segment_id === selectedScriptSegmentId)) ?? null, [selectedEpisode, selectedScriptSegmentId]);
  const selectedSceneKey = selectedScene ? normalizeSceneKey(selectedScene.heading || selectedScene.scene_id) : "";
  const unmappedTakes = useMemo(() => model?.take_groups.filter((take) => take.effective_mapping.script_segment_ids.length === 0) ?? [], [model]);
  const autoMatchSummary = useMemo(() => {
    const takes = model?.take_groups ?? [];
    return {
      totalMappedCount: takes.filter((take) => take.effective_mapping.script_segment_ids.length > 0).length,
      totalCandidateCount: takes.filter((take) => take.candidates.length > 0).length,
    };
  }, [model]);
  const needsAutoMatch = Boolean(model?.episodes.length && model.take_groups.length && autoMatchSummary.totalMappedCount === 0 && autoMatchSummary.totalCandidateCount === 0);
  const scenePoolCount = useMemo(() => {
    if (!selectedSceneKey || !selectedEpisode) return 0;
    return unmappedTakes.filter((take) => {
      const record = slateRecordForTake(slateBoard, take);
      return record ? sceneRecordMatches(record, selectedEpisode.episode, selectedSceneKey) : false;
    }).length;
  }, [selectedEpisode, selectedSceneKey, slateBoard, unmappedTakes]);
  const poolTakes = useMemo(() => {
    const needle = poolQuery.trim().toLocaleLowerCase("zh-CN");
    return unmappedTakes.filter((take) => {
      const record = slateRecordForTake(slateBoard, take);
      const searchable = [
        takeSearchText(take),
        record ? slateCoordinates(record) : "",
        record?.note ?? "",
      ].join(" ").toLocaleLowerCase("zh-CN");
      if (needle && !searchable.includes(needle)) return false;
      if (poolSceneOnly && selectedEpisode && selectedSceneKey) {
        return Boolean(record && sceneRecordMatches(record, selectedEpisode.episode, selectedSceneKey));
      }
      return true;
    });
  }, [poolQuery, poolSceneOnly, selectedEpisode, selectedSceneKey, slateBoard, unmappedTakes]);

  function selectTake(take: ReviewTakeGroup, openDetail = false): void {
    setSelectedGroupId(take.group_id);
    setSelectedClipId(take.angles[0]?.clip_id ?? null);
    if (openDetail) {
      setDrawerView("detail");
      setDetailReturnView(selectedScriptSegmentId ? "segment" : "pool");
      setDrawerOpen(true);
    }
  }

  function selectBlock(block: ReviewScriptBlock): void {
    setSelectedScriptSegmentId(block.segment_id);
  }

  function openBlockContext(block: ReviewScriptBlock): void {
    setSelectedScriptSegmentId(block.segment_id);
    setDrawerView("segment");
    setDrawerOpen(true);
  }

  async function runAutoMatch(): Promise<void> {
    if (autoMatchState === "submitting") return;
    setAutoMatchState("submitting");
    setAutoMatchMessage("正在提交后台转写与匹配任务…");
    try {
      await new DesktopClient(baseUrl).prepareProject(project.project_id);
      setAutoMatchState("submitted");
      setAutoMatchMessage("后台转写与匹配任务已提交，可在顶栏「任务」查看进度，完成后刷新本页");
    } catch (error) {
      setAutoMatchState("error");
      setAutoMatchMessage(reviewModelErrorMessage(error));
    }
  }

  async function refreshAutoMatch(): Promise<void> {
    try {
      await refresh();
      setAutoMatchState("idle");
      setAutoMatchMessage("");
      setAutoMatchDismissed(false);
    } catch (error) {
      setAutoMatchState("error");
      setAutoMatchMessage(reviewModelErrorMessage(error));
    }
  }

  function beginDrag(event: DragEvent<HTMLElement>, groupId: string): void {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_TAKE_MIME, groupId);
    event.dataTransfer.setData("text/plain", groupId);
    setDraggingGroupId(groupId);
  }

  async function refreshSelectionAfterWrite(groupId: string): Promise<void> {
    const next = await refresh();
    const refreshed = next.take_groups.find((take) => take.group_id === groupId) ?? null;
    setSelectedGroupId(refreshed?.group_id ?? null);
    setSelectedClipId((current) => refreshed?.angles.some((angle) => angle.clip_id === current) ? current : refreshed?.angles[0]?.clip_id ?? null);
  }

  async function placeTake(
    groupId: string,
    episodeIds: number[],
    segmentIds: string[],
    interaction: "drag" | "click",
    sourceSurface: string,
  ): Promise<void> {
    if (!model) return;
    if (!actor.trim()) {
      requestCurrentOperator();
      setWriteState("error");
      setWriteMessage("先填写审核昵称，再写入人工归集。");
      return;
    }
    setWriteState("saving");
    setWriteMessage("正在写入人工归集…");
    saveActor(actor);
    try {
      await connection.setGroupPlacement(project.project_id, {
        groupId,
        actor,
        expectedRevision: model.revisions.review,
        episodeIds,
        scriptSegmentIds: segmentIds,
        interaction,
        sourceSurface,
        sourceClipId: groupId === selectedGroupId ? selectedClipId ?? undefined : undefined,
      });
      const take = model.take_groups.find((item) => item.group_id === groupId) ?? null;
      const label = take ? takeDisplayLabel(take) : "Take";
      const summary = segmentIds.length
        ? `已人工归集 ${label} → 当前剧本段`
        : `已人工粗归集 ${label} → ${episodeIds.map(episodeLabel).join(" / ")}`;
      // 写入已落库；随后的只读刷新失败不能改写成功结果，只报告刷新失败。
      setWriteState("idle");
      setWriteMessage(summary);
      try {
        await refreshSelectionAfterWrite(groupId);
      } catch {
        setWriteMessage(`${summary}；界面刷新失败，请手动刷新核对状态。`);
      }
    } catch (error) {
      setWriteState("error");
      if (reviewWriteNeedsRefresh(error)) {
        try {
          await refresh();
          setWriteMessage("制作状态已变化并刷新；请重新操作。");
        } catch {
          setWriteMessage(reviewModelErrorMessage(error));
        }
      } else {
        setWriteMessage(reviewModelErrorMessage(error));
      }
    } finally {
      setDraggingGroupId(null);
    }
  }

  async function placeTakeOnSelectedBlock(take: ReviewTakeGroup): Promise<void> {
    if (!selectedBlock) return;
    setSelectedGroupId(take.group_id);
    setSelectedClipId(take.angles[0]?.clip_id ?? null);
    await placeTake(
      take.group_id,
      selectedBlock.episode > 0 ? [selectedBlock.episode] : [],
      [selectedBlock.segment_id],
      "click",
      "desktop-script-segment-context",
    );
  }

  async function clearPlacement(): Promise<void> {
    if (!selectedTake || !model) return;
    if (!actor.trim()) {
      requestCurrentOperator();
      setWriteState("error");
      setWriteMessage("先填写审核昵称，再清除人工归集。");
      return;
    }
    setWriteState("saving");
    saveActor(actor);
    try {
      await connection.clearGroupPlacement(project.project_id, {
        groupId: selectedTake.group_id,
        actor,
        expectedRevision: model.revisions.review,
        sourceSurface: "desktop-script",
      });
      const summary = `已清除 ${takeDisplayLabel(selectedTake)} 的人工归集；自动状态未改动。`;
      setWriteState("idle");
      setWriteMessage(summary);
      try {
        await refreshSelectionAfterWrite(selectedTake.group_id);
      } catch {
        setWriteMessage(`${summary}；界面刷新失败，请手动刷新核对状态。`);
      }
    } catch (error) {
      setWriteState("error");
      if (reviewWriteNeedsRefresh(error)) {
        try {
          await refresh();
          setWriteMessage("制作状态已变化并刷新；请重新操作。");
        } catch {
          setWriteMessage(reviewModelErrorMessage(error));
        }
      } else {
        setWriteMessage(reviewModelErrorMessage(error));
      }
    }
  }

  async function previewRoughPlacement(): Promise<void> {
    if (!roughText.trim()) return;
    setWriteState("saving");
    setWriteMessage("正在解析批量归集范围…");
    try {
      const preview = await roughPlacement.preview(project.project_id, roughText);
      setRoughPreview(preview);
      setWriteState("idle");
      setWriteMessage(`已识别 ${preview.plans.length} 段范围；确认前不会写入。`);
    } catch (error) {
      setWriteState("error");
      setWriteMessage(reviewModelErrorMessage(error));
    }
  }

  async function applyRoughPlacement(): Promise<void> {
    if (!model || !roughPreview || !actor.trim()) {
      if (!actor.trim()) requestCurrentOperator();
      setWriteState("error");
      setWriteMessage("先预览批量归集并填写审核昵称。");
      return;
    }
    setWriteState("saving");
    setWriteMessage("正在确认批量归集…");
    saveActor(actor);
    try {
      const result = await roughPlacement.apply(project.project_id, roughText, actor, model.revisions.review);
      const summary = `已批量归集 ${result.resolved_groups} 个 Take`;
      setRoughPreview(null);
      setWriteState("idle");
      setWriteMessage(summary);
      try {
        await refresh();
      } catch {
        setWriteMessage(`${summary}；界面刷新失败，请手动刷新核对状态。`);
      }
      setDrawerOpen(false);
    } catch (error) {
      setWriteState("error");
      if (reviewWriteNeedsRefresh(error)) {
        await refresh().catch(() => null);
        setRoughPreview(null);
        setWriteMessage("制作状态已变化，预览已作废；请重新预览后确认。");
      } else {
        setWriteMessage(reviewModelErrorMessage(error));
      }
    }
  }

  async function chooseScript(): Promise<void> {
    try {
      const file = await openDialog({ multiple: false,
        filters: [{ name: "剧本", extensions: ["docx", "txt", "md", "markdown"] }] });
      if (typeof file === "string") setScriptPath(file);
    } catch (error) {
      setAttachState("error");
      setAttachMessage(reviewModelErrorMessage(error));
    }
  }

  async function attachScript(): Promise<void> {
    if (attaching.current || !scriptPath.trim()) return;
    attaching.current = true;
    setAttachState("saving");
    setAttachMessage("");
    try {
      const result = await new DesktopClient(baseUrl).attachScript(project.project_id, scriptPath.trim());
      setAttachState("submitted");
      setAttachMessage(result.task?.task_id
        ? "剧本已保存。后台关联已提交，完成后刷新此页查看。"
        : "剧本已保存，请刷新剧本关联。");
    } catch (error) {
      setAttachState("error");
      setAttachMessage(reviewModelErrorMessage(error));
    } finally {
      attaching.current = false;
    }
  }

  const { hasDuplicateTakeIndex, takeSequenceByGroupId } = useMemo(() => {
    const seen = new Set<number>();
    let duplicate = false;
    const sequence = new Map<string, number>();
    for (const [index, take] of (model?.take_groups ?? []).entries()) {
      sequence.set(take.group_id, index + 1);
      if (take.take_index > 0) {
        if (seen.has(take.take_index)) duplicate = true;
        else seen.add(take.take_index);
      }
    }
    return { hasDuplicateTakeIndex: duplicate, takeSequenceByGroupId: sequence };
  }, [model]);

  function poolTakeLabel(take: ReviewTakeGroup): string {
    if (!hasDuplicateTakeIndex) return takeDisplayLabel(take);
    const seq = takeSequenceByGroupId.get(take.group_id) ?? 1;
    const clipStem = take.angles[0]?.name?.replace(/\.[^.]+$/, "").trim();
    return clipStem ? `#${seq} · ${clipStem}` : `#${seq}`;
  }

  function renderPoolCard(take: ReviewTakeGroup): ReactNode {
    const record = slateRecordForTake(slateBoard, take);
    const placeableSelected = Boolean(selectedBlock && isPlaceableScriptBlock(selectedBlock));
    const displayLabel = poolTakeLabel(take);
    return (
      <article
        className="script-pool-card"
        key={take.group_id}
        draggable
        onDragStart={(event) => beginDrag(event, take.group_id)}
        onDragEnd={() => setDraggingGroupId(null)}
        aria-label={`${displayLabel} · 待归集`}
      >
        <header className="script-pool-card-heading">
          <div><strong>{displayLabel}</strong><span>{take.duration.toFixed(1)}s</span></div>
          {record ? <ScriptSlateLinkage record={record} groupId={take.group_id} clipId={take.angles[0]?.clip_id} scriptSegmentId={selectedScriptSegmentId} onOpenSlate={onOpenSlate} /> : null}
        </header>
        <div className="script-pool-camera-list" aria-label={`${displayLabel} 机位素材`}>
          {take.angles.map((angle) => {
            const camera = cameraPresentation(angle.camera);
            return (
              <span className="script-pool-camera" data-camera-tone={camera.tone} key={angle.clip_id} title={angle.name}>
                <strong>{camera.label}</strong><span>{angle.name || "未命名素材"} · {(angle.duration ?? take.duration).toFixed(1)}s</span>
              </span>
            );
          })}
        </div>
        <p className="script-pool-transcript">{take.transcript.text || "无可靠对白"}</p>
        <div className="script-pool-actions">
          <button type="button" disabled={!placeableSelected || writeState === "saving"} onClick={() => void placeTakeOnSelectedBlock(take)}>挂到当前段</button>
          <button type="button" className="secondary" onClick={() => selectTake(take, true)}>预览</button>
          {record && onOpenSlate ? <button type="button" className="secondary" onClick={() => onOpenSlate(take.group_id, take.angles[0]?.clip_id ?? null, selectedScriptSegmentId)}>场记</button> : null}
        </div>
      </article>
    );
  }

  if (loadState !== "ready" || !model) {
    return (
      <section className="script-workspace">
        <div className={`projection-status ${loadState === "error" ? "is-error" : ""}`} role={loadState === "error" ? "alert" : "status"}>{message}
          {loadState === "error" && <button type="button" className="secondary" onClick={() => void refresh().catch(() => null)}>重新读取</button>}
        </div>
      </section>
    );
  }

  return (
    <section className="script-workspace">
      {!model.episodes.length && project.input_kind === "media-directory" && <section className="script-source-intake">
        <h2>导入剧本</h2>
        <p>将剧本关联到已有 Take。同步母版和工程文件会保留。</p>
        {attachState !== "submitted" && <form onSubmit={(event) => { event.preventDefault(); void attachScript(); }}>
          <label>剧本文件<input value={scriptPath} onChange={(event) => setScriptPath(event.target.value)} disabled={attachState === "saving"} /></label>
          {isTauri() && <button type="button" className="secondary" onClick={() => void chooseScript()} disabled={attachState === "saving"}>选择文件…</button>}
          <button disabled={!scriptPath.trim() || attachState === "saving"}>导入并关联</button>
        </form>}
        {attachMessage && <p role={attachState === "error" ? "alert" : "status"}>{attachMessage}</p>}
        <button type="button" className="secondary" onClick={() => void refresh().catch((error) => {
          setAttachState("error"); setAttachMessage(reviewModelErrorMessage(error));
        })}>刷新剧本关联</button>
      </section>}
      <header className="script-command-bar">
        <div className="script-projection-switch" aria-label="剧本显示模式">
          {PROJECTION_OPTIONS.map((option) => (
            <button
              type="button"
              className={projectionMode === option.value ? "is-active" : ""}
              aria-pressed={projectionMode === option.value}
              key={option.value}
              title={{
                script: "按剧本正文查看已关联实拍素材",
                coverage: "按已归集、有候选与未拍摄直观标色",
                issues: "只显示缺拍或待处理的剧本段",
              }[option.value]}
              onClick={() => setProjectionMode(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <input
          className="script-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索剧本、角色或场景"
          aria-label="搜索剧本"
        />
        <div className="workspace-toolbar-actions">
          {model.episodes.length > 0 && model.take_groups.length > 0 ? (
            <button
              type="button"
              className={needsAutoMatch ? "script-auto-match-primary" : "secondary"}
              disabled={autoMatchState === "submitting"}
              onClick={() => void runAutoMatch()}
            >
              {autoMatchState === "submitting" ? "提交中…" : "自动匹配"}
            </button>
          ) : null}
          <button type="button" className="secondary" disabled={!selectedBlock} title="为当前剧本段挑选对应实拍素材" onClick={() => selectedBlock && openBlockContext(selectedBlock)}>匹配素材</button>
          <button type="button" className="secondary" title="按场次范围一次性归集多条素材" onClick={() => { setDrawerView("batch"); setRoughPreview(null); setDrawerOpen(true); }}>批量归集</button>
        </div>
      </header>

      <div className="script-episode-bar">
        <div className="episode-strip" aria-label="剧本集数">
          {model.episodes.map((episode) => (
            <button
              type="button"
              className={`${episode.episode === selectedEpisode?.episode ? "is-active" : ""} ${draggingGroupId ? "is-drop-target" : ""}`}
              key={episode.episode}
              onClick={() => {
                setActiveEpisode(episode.episode);
                setSelectedScriptSegmentId(firstPlaceableBlock(episode)?.segment_id ?? null);
              }}
              onDragOver={(event) => {
                if (!draggingGroupId) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={(event) => {
                event.preventDefault();
                const groupId = dragGroupId(event);
                if (!groupId) return;
                // set_group_placement 是整项替换：把已有精确剧本归集的 Take
                // 拖到集数条会把它降级为 episode-only。先确认，防止误拖销毁
                // 人工精确归集。
                const dragged = model.take_groups.find((item) => item.group_id === groupId);
                if (
                  dragged
                  && dragged.effective_mapping.script_segment_ids.length > 0
                  && !globalThis.confirm(
                    `${takeDisplayLabel(dragged)} 已精确归集到 ${dragged.effective_mapping.script_segment_ids.length} 个剧本段。拖到 ${episodeLabel(episode.episode)} 会替换为仅集数粗归集。继续？`,
                  )
                ) {
                  return;
                }
                void placeTake(groupId, [episode.episode], [], "drag", "desktop-script-episode");
              }}
            >
              {episodeLabel(episode.episode)}
            </button>
          ))}
        </div>
        {selectedTake ? (
          <div
            className="script-current-take"
            draggable
            onDragStart={(event) => beginDrag(event, selectedTake.group_id)}
            onDragEnd={() => setDraggingGroupId(null)}
            title="当前从其它工作区带入的 Take；可拖到集数或剧本段"
          >
            <span>当前 Take</span><strong>{takeDisplayLabel(selectedTake)}</strong>
          </div>
        ) : null}
      </div>

      {needsAutoMatch && !autoMatchDismissed ? (
        <div className="script-auto-match-banner" role="status">
          <span>尚未完成对白转写与剧本自动匹配 · 共 {model.take_groups.length} 条实拍素材待关联（不影响已交付同步母版）</span>
          <button type="button" onClick={() => void runAutoMatch()} disabled={autoMatchState === "submitting"}>
            {autoMatchState === "submitting" ? "提交中…" : "自动转写并匹配剧本"}
          </button>
          <button type="button" className="secondary script-auto-match-dismiss" onClick={() => setAutoMatchDismissed(true)}>稍后</button>
        </div>
      ) : null}
      {autoMatchMessage ? (
        <div className={`script-auto-match-status is-${autoMatchState}`} role={autoMatchState === "error" ? "alert" : "status"}>
          <span>{autoMatchMessage}</span>
          {autoMatchState === "submitted" ? <button type="button" className="secondary" onClick={() => void refreshAutoMatch()}>刷新结果</button> : null}
        </div>
      ) : null}

      <div className="script-coverage-summary" aria-label="当前集剧本归集摘要">
        <span><strong>{episodeStats.blocks}</strong>剧本段</span>
        <span><strong>{episodeStats.mapped}</strong>已归集</span>
        <span><strong>{episodeStats.candidate}</strong>有候选</span>
        <span className={episodeStats.attention ? "needs-attention" : ""}><strong>{episodeStats.attention}</strong>需处理</span>
      </div>

      {writeMessage ? <div className={`write-status write-${writeState}`}>{writeMessage}</div> : null}

      <div className={"script-split-workbench" + (drawerOpen ? "" : " is-alignment-collapsed")}>
        <main className="script-primary-canvas">
          {visibleEpisode && visibleEpisode.scenes.length ? (
            <ScriptEpisodeView
              episode={visibleEpisode}
              model={model}
              selectedSegmentId={selectedScriptSegmentId}
              projectionMode={projectionMode}
              draggingGroupId={draggingGroupId}
              placementGroupId={selectedTake?.group_id ?? null}
              onSelectBlock={selectBlock}
              onOpenContext={openBlockContext}
              onShowTake={(groupId) => {
                const take = model.take_groups.find((item) => item.group_id === groupId);
                if (take) selectTake(take, true);
              }}
              onDropPlacement={(groupId, block) => {
                setSelectedScriptSegmentId(block.segment_id);
                void placeTake(groupId, block.episode > 0 ? [block.episode] : [], [block.segment_id], "drag", "desktop-script-segment");
              }}
              onClickPlacement={(block: ReviewScriptBlock) => {
                setSelectedScriptSegmentId(block.segment_id);
                if (!selectedTake) {
                  openBlockContext(block);
                  return;
                }
                void placeTake(selectedTake.group_id, block.episode > 0 ? [block.episode] : [], [block.segment_id], "click", "desktop-script-segment");
              }}
            />
          ) : <p className="empty-copy">当前搜索 / 显示模式下没有剧本段。</p>}
        </main>

        <aside className={"script-alignment-pane" + (drawerOpen ? "" : " is-collapsed")} aria-label="剧本素材对齐">
          {!drawerOpen ? (
            <button type="button" className="script-alignment-reopen" onClick={() => setDrawerOpen(true)}>展开素材对齐</button>
          ) : (
            <>
              <header className="script-alignment-heading">
                <div><span>剧本素材对齐</span><strong>{drawerView === "detail" && selectedTake ? takeDisplayLabel(selectedTake) : drawerView === "batch" ? "批量归集" : selectedBlock ? "当前剧本段" : "待归集素材"}</strong></div>
                <button type="button" className="secondary" onClick={() => setDrawerOpen(false)} aria-label="收起剧本素材对齐">收起</button>
              </header>
              <nav className="script-alignment-tabs" aria-label="剧本素材对齐视图">
                <button type="button" className={drawerView === "pool" ? "is-active" : ""} onClick={() => setDrawerView("pool")}>待归集 <strong>{unmappedTakes.length}</strong></button>
                <button type="button" className={drawerView === "segment" ? "is-active" : ""} onClick={() => setDrawerView("segment")}>当前段 <strong>{selectedMappedTakeIds.length + selectedCandidateTakeIds.length}</strong></button>
                <button type="button" className={drawerView === "batch" ? "is-active" : ""} onClick={() => setDrawerView("batch")}>批量归集</button>
              </nav>

              {drawerView === "pool" ? (
                <section className="script-pool-panel" aria-label="待归集素材">
                  <div className="script-pool-controls">
                    <input
                      className="script-candidate-search"
                      type="search"
                      value={poolQuery}
                      onChange={(event) => setPoolQuery(event.target.value)}
                      placeholder="搜索文件名、对白、场记"
                      aria-label="搜索待归集素材"
                    />
                    {selectedSceneKey && scenePoolCount > 0 ? (
                      <button type="button" className={"script-scene-filter" + (poolSceneOnly ? " is-active" : "")} aria-pressed={poolSceneOnly} onClick={() => setPoolSceneOnly((value) => !value)}>
                        仅看本场记 ({scenePoolCount})
                      </button>
                    ) : null}
                  </div>
                  <div className="script-pool-list">
                    {poolTakes.map(renderPoolCard)}
                    {!poolTakes.length ? <div className="script-alignment-empty">没有匹配的待归集 Take。</div> : null}
                  </div>
                </section>
              ) : drawerView === "batch" ? (
                <section className="rough-placement-tool script-batch-panel">
                  <div className="rough-placement-copy">
                    <strong>按 Take 范围粗归集到集数</strong>
                    <p>例如：1-10 第1集；11-20 第2集。确认前不会写入。</p>
                  </div>
                  <textarea value={roughText} onChange={(event) => { setRoughText(event.target.value); setRoughPreview(null); }} placeholder="1-10 第1集；11-20 第2集" rows={5} />
                  <div className="rough-placement-actions">
                    <button type="button" className="secondary" disabled={writeState === "saving" || !roughText.trim()} onClick={() => void previewRoughPlacement()}>预览</button>
                    <button type="button" disabled={writeState === "saving" || !roughPreview} onClick={() => void applyRoughPlacement()}>确认归集</button>
                  </div>
                  {roughPreview ? <div className="rough-placement-preview">{roughPreview.plans.map((plan, index) => <span key={plan.take_start + "-" + plan.take_end + "-" + index}>{roughPreviewLabel(plan)}</span>)}</div> : null}
                </section>
              ) : drawerView === "segment" ? (
                <section className="script-segment-context">
                  {selectedBlock ? (
                    <>
                      <div className="script-segment-summary">
                        <p>{selectedBlock.raw_text || selectedBlock.text || "—"}</p>
                        <div>
                          <span><strong>{selectedMappedTakeIds.length}</strong>已归集</span>
                          <span><strong>{selectedCandidateTakeIds.length}</strong>候选</span>
                          <span className={selectedBlock.issues.length ? "needs-attention" : ""}><strong>{selectedBlock.issues.length}</strong>问题</span>
                        </div>
                      </div>
                      {activeAuditionTake && auditionTakes.length > 0 ? (
                        <section className="script-audition-reel" aria-label="当前段试听">
                          <header className="script-audition-head">
                            <div><strong>当前段试听</strong><span>{Math.min(auditionIndex + 1, auditionTakes.length)} / {auditionTakes.length} · {takeDisplayLabel(activeAuditionTake)}{activeAuditionAngle ? " · " + activeAuditionAngle.camera + "机" : ""}</span></div>
                            <label className="script-audition-loop"><input type="checkbox" checked={auditionAutoAdvance} onChange={(event) => setAuditionAutoAdvance(event.target.checked)} />3秒连播</label>
                          </header>
                          {activeAuditionUrl ? (
                            <video ref={auditionVideoRef} key={activeAuditionTake.group_id + ":" + (activeAuditionAngle?.clip_id ?? "")} className="script-audition-video" src={activeAuditionUrl} controls playsInline preload="metadata" onLoadedMetadata={(event) => { const video = event.currentTarget; if (activeAuditionStart > 0 && activeAuditionStart < video.duration) video.currentTime = activeAuditionStart; }} onTimeUpdate={(event) => { if (!auditionAutoAdvance || auditionTakes.length <= 1) return; const video = event.currentTarget; if (!video.paused && video.currentTime - activeAuditionStart >= 3) setAuditionIndex((index) => (index + 1) % auditionTakes.length); }} />
                          ) : <p className="script-audition-empty">该 Take 当前设备无可播放预览。</p>}
                          <div className="script-audition-transcript"><span>实际对白</span><p>{activeAuditionTake.transcript.text || "尚未转写实际对白"}</p></div>
                          {activeAuditionSlate ? <ScriptSlateLinkage record={activeAuditionSlate} groupId={activeAuditionTake.group_id} clipId={activeAuditionAngle?.clip_id ?? null} scriptSegmentId={selectedBlock.segment_id} onOpenSlate={onOpenSlate} /> : null}
                          <div className="script-audition-controls">
                            <button type="button" className="secondary" disabled={auditionTakes.length <= 1} onClick={() => setAuditionIndex((index) => (index - 1 + auditionTakes.length) % auditionTakes.length)}>上一条</button>
                            <button type="button" className="secondary" disabled={auditionTakes.length <= 1} onClick={() => setAuditionIndex((index) => (index + 1) % auditionTakes.length)}>下一条</button>
                            {!activeAuditionTake.effective_mapping.script_segment_ids.includes(selectedBlock.segment_id) ? <button type="button" disabled={writeState === "saving"} onClick={() => void placeTakeOnSelectedBlock(activeAuditionTake)}>挂到当前段</button> : <button type="button" className="secondary" onClick={() => onOpenReview?.(activeAuditionTake.group_id, activeAuditionAngle?.clip_id ?? null, selectedBlock.segment_id)}>去审阅看片</button>}
                          </div>
                        </section>
                      ) : null}
                      {selectedTake && selectedTakeMappedHere ? <ScriptAssignmentDecision baseUrl={baseUrl} projectId={project.project_id} groupId={selectedTake.group_id} segmentId={selectedBlock.segment_id} actor={actor} onDecisionChange={refresh} /> : null}
                      <div className="script-current-takes">
                        {auditionTakes.length ? <VirtualTakeList variant="compact" takes={auditionTakes} selectedGroupId={selectedGroupId} onSelect={(take) => selectTake(take, true)} onDragBegin={(groupId) => setDraggingGroupId(groupId)} onDragFinish={() => setDraggingGroupId(null)} detailForTake={(take) => mappingLabel(take)} actionForTake={(take) => selectedBlock && !take.effective_mapping.script_segment_ids.includes(selectedBlock.segment_id) ? () => void placeTakeOnSelectedBlock(take) : () => selectTake(take, true)} actionLabelForTake={(take) => selectedBlock && !take.effective_mapping.script_segment_ids.includes(selectedBlock.segment_id) ? "归集到此段" : "预览"} /> : <div className="script-alignment-empty">当前段暂无已归集或候选 Take。</div>}
                      </div>
                    </>
                  ) : <div className="script-alignment-empty">先在剧本正文选择一个可归集剧本段。</div>}
                </section>
              ) : (
                <section className="script-take-detail">
                  <div className="script-detail-back">
                    <button type="button" className="secondary" onClick={() => { setDrawerView(detailReturnView); setSelectedGroupId(null); }}>返回{detailReturnView === "segment" ? "当前段" : "待归集"}</button>
                    <strong>Take 详情</strong>
                  </div>
                  {selectedTake ? (
                    <>
                      {(() => {
                        const record = slateRecordForTake(slateBoard, selectedTake);
                        return record ? <ScriptSlateLinkage record={record} groupId={selectedTake.group_id} clipId={selectedClipId} scriptSegmentId={selectedScriptSegmentId} onOpenSlate={onOpenSlate} /> : null;
                      })()}
                      <div className="script-detail-actions">
                        {(() => {
                          const record = slateRecordForTake(slateBoard, selectedTake);
                          return record && onOpenSlate ? <button type="button" className="secondary" onClick={() => onOpenSlate(selectedTake.group_id, selectedClipId, selectedScriptSegmentId)}>在场记中打开</button> : null;
                        })()}
                        {onOpenReview ? <button type="button" className="secondary" onClick={() => onOpenReview(selectedTake.group_id, selectedClipId, selectedScriptSegmentId)}>去审阅看片</button> : null}
                        {selectedBlock && !selectedTakeMappedHere ? <button type="button" disabled={writeState === "saving"} onClick={() => void placeTakeOnSelectedBlock(selectedTake)}>挂到当前段</button> : null}
                      </div>
                      <TakeInspector connection={connection} projectId={project.project_id} take={selectedTake} selectedClipId={selectedClipId} playbackFocus={playbackFocus} onSelectClip={setSelectedClipId} onClearPlacement={() => void clearPlacement()} writeSaving={writeState === "saving"} hideHeader />
                    </>
                  ) : <div className="script-alignment-empty">当前没有可查看的 Take。</div>}
                </section>
              )}
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
