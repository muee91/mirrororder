import type { ReviewModelPayload, ReviewTakeGroup } from "../../api/host";
import type { AssemblyTimeline, SlateBoard, SlateEntry, SlateRecord } from "../../api/production";
import type { TimelineClip, TimelineProject, TimelineSequence } from "../../api/timeline";
import type { TimelineSourceOption } from "./timelineSourceEditing";

export interface EditorialIdentity {
  groupId: string;
  sceneId: string;
  scene: string;
  shot: string;
  takeNumber: number | null;
  status: string;
  note: string;
  preferredClipId: string;
  usableStartSeconds: number | null;
  usableEndSeconds: number | null;
  scriptSegmentIds: string[];
}

export interface EditorialInspectorModel {
  title: string;
  subtitle: string;
  identity: EditorialIdentity;
  currentCamera: string;
  currentSourceName: string;
  currentSourceId: string;
  decisionSource: string;
  trimBasis: string;
  scriptSegmentIds: string[];
  timelineRange: string;
  sourceRange: string;
}

export interface ReplacementTakeOption {
  key: string;
  groupId: string;
  sourceId: string;
  sourceIn: number;
  label: string;
  detail: string;
  camera: string;
  status: string;
  blockedReason: string | null;
  preferred: boolean;
}

export interface EditorialSuggestion {
  id: string;
  tone: "info" | "warning" | "critical";
  kind: "multicam" | "take" | "coverage" | "continuity" | "range" | "camera_pattern";
  title: string;
  detail: string;
  clipId?: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseSegmentIds(value: string | undefined): string[] {
  const raw = text(value);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((item) => text(item)).filter(Boolean);
  } catch {
    // Older clips may only carry segment_id.
  }
  return [];
}

function slateEntry(board: SlateBoard | null, groupId: string): SlateEntry | SlateRecord | null {
  if (!board || !groupId) return null;
  const direct = board.entries?.[groupId];
  if (direct) return direct;
  return Object.values(board.records ?? {}).find((record) => record.source_group_id === groupId) ?? null;
}

function takeGroup(review: ReviewModelPayload | null, groupId: string): ReviewTakeGroup | null {
  return review?.take_groups.find((group) => group.group_id === groupId) ?? null;
}

function identityForGroup(
  review: ReviewModelPayload | null,
  board: SlateBoard | null,
  groupId: string,
): EditorialIdentity {
  const slate = slateEntry(board, groupId);
  const group = takeGroup(review, groupId);
  const segmentIds = group?.effective_mapping?.script_segment_ids ?? group?.context?.script_segment_ids ?? [];
  const range = slate?.usable_range;
  return {
    groupId,
    sceneId: text(slate?.script_scene_id),
    scene: text(slate?.scene),
    shot: text(slate?.shot),
    takeNumber: integer(slate?.take_number) ?? integer(group?.take_index),
    status: text(slate?.status) || "未标记",
    note: text(slate?.note),
    preferredClipId: text(slate?.preferred_clip_id),
    usableStartSeconds: range && Number.isFinite(Number(range.start)) ? Number(range.start) : null,
    usableEndSeconds: range && Number.isFinite(Number(range.end)) ? Number(range.end) : null,
    scriptSegmentIds: segmentIds.map((item) => text(item)).filter(Boolean),
  };
}

function takeLabel(identity: EditorialIdentity): string {
  const scene = identity.scene ? `第 ${identity.scene} 场` : identity.sceneId || "未关联场次";
  const shot = identity.shot ? `${identity.shot} 镜` : "未标镜头";
  const take = identity.takeNumber !== null ? `第 ${identity.takeNumber} 条` : "未标镜次";
  return `${scene} · ${shot} · ${take}`;
}

function sourceCamera(project: TimelineProject, review: ReviewModelPayload | null, sourceId: string): string {
  const source = project.sources.find((item) => item.source_id === sourceId);
  if (!source) return "";
  for (const group of review?.take_groups ?? []) {
    const angle = group.angles.find((item) => item.clip_id === source.clip_id);
    if (angle) return text(angle.camera);
  }
  return "";
}

export function buildEditorialInspector(
  review: ReviewModelPayload | null,
  board: SlateBoard | null,
  project: TimelineProject,
  clip: TimelineClip,
): EditorialInspectorModel {
  const groupId = text(clip.metadata.group_id);
  const identity = identityForGroup(review, board, groupId);
  const activeSourceId = clip.selected_angle_source_id ?? clip.source_id;
  const source = project.sources.find((item) => item.source_id === activeSourceId)
    ?? project.sources.find((item) => item.source_id === clip.source_id)
    ?? null;
  const scriptSegmentIds = parseSegmentIds(clip.metadata.script_segment_ids);
  if (!scriptSegmentIds.length && text(clip.metadata.segment_id)) scriptSegmentIds.push(text(clip.metadata.segment_id));
  const currentCamera = sourceCamera(project, review, activeSourceId);
  return {
    title: takeLabel(identity),
    subtitle: [currentCamera ? `${currentCamera} 机` : "", identity.status].filter(Boolean).join(" · "),
    identity,
    currentCamera,
    currentSourceName: source?.name || source?.clip_id || activeSourceId,
    currentSourceId: activeSourceId,
    decisionSource: text(clip.metadata.decision_source) || "人工编辑",
    trimBasis: text(clip.metadata.trim_basis) || "人工范围",
    scriptSegmentIds,
    timelineRange: `${clip.timeline_start}f–${clip.timeline_start + clip.duration}f`,
    sourceRange: `${clip.source_in}f–${clip.source_in + clip.duration}f`,
  };
}

function intersects(a: string[], b: string[]): boolean {
  const set = new Set(a);
  return b.some((item) => set.has(item));
}

function sameEditorialShot(current: EditorialIdentity, candidate: EditorialIdentity): boolean {
  if (current.scene && current.shot) return current.scene === candidate.scene && current.shot === candidate.shot;
  if (current.sceneId && current.shot) return current.sceneId === candidate.sceneId && current.shot === candidate.shot;
  return false;
}

function replacementSourceIn(
  identity: EditorialIdentity,
  option: TimelineSourceOption,
  sequence: TimelineSequence,
): number {
  if (identity.usableStartSeconds === null) return option.availableIn;
  const fps = sequence.frame_rate.numerator / sequence.frame_rate.denominator;
  return option.availableIn + Math.max(0, Math.round(identity.usableStartSeconds * fps));
}

function replacementRangeFrames(identity: EditorialIdentity, sequence: TimelineSequence): number | null {
  if (identity.usableStartSeconds === null || identity.usableEndSeconds === null) return null;
  const seconds = identity.usableEndSeconds - identity.usableStartSeconds;
  if (!(seconds > 0)) return null;
  const fps = sequence.frame_rate.numerator / sequence.frame_rate.denominator;
  return Math.max(1, Math.round(seconds * fps));
}

export function buildReplacementTakeOptions(
  review: ReviewModelPayload | null,
  board: SlateBoard | null,
  sequence: TimelineSequence,
  clip: TimelineClip,
  sourceOptions: TimelineSourceOption[],
): ReplacementTakeOption[] {
  const currentGroupId = text(clip.metadata.group_id);
  const current = identityForGroup(review, board, currentGroupId);
  const currentSegments = parseSegmentIds(clip.metadata.script_segment_ids);
  if (!currentSegments.length && text(clip.metadata.segment_id)) currentSegments.push(text(clip.metadata.segment_id));

  const byGroup = new Map<string, TimelineSourceOption[]>();
  for (const option of sourceOptions) {
    if (!option.groupId || option.groupId === currentGroupId) continue;
    const bucket = byGroup.get(option.groupId) ?? [];
    bucket.push(option);
    byGroup.set(option.groupId, bucket);
  }

  const result: ReplacementTakeOption[] = [];
  for (const [groupId, options] of byGroup) {
    const identity = identityForGroup(review, board, groupId);
    const related = sameEditorialShot(current, identity)
      || (!current.scene && !current.shot && intersects(currentSegments, identity.scriptSegmentIds));
    if (!related) continue;
    const preferred = identity.preferredClipId
      ? options.find((option) => option.source.clip_id === identity.preferredClipId)
      : null;
    const option = preferred ?? options[0];
    if (!option) continue;
    const sourceIn = replacementSourceIn(identity, option, sequence);
    const exactRangeFrames = replacementRangeFrames(identity, sequence);
    let blockedReason: string | null = null;
    if (identity.status === "ng") blockedReason = "场记标记为 NG";
    else if (sourceIn < option.availableIn || sourceIn + clip.duration > option.availableIn + option.availableDuration) {
      blockedReason = "当前可播放范围不足以保持本段时长";
    } else if (exactRangeFrames !== null && exactRangeFrames < clip.duration) {
      blockedReason = "场记可用范围短于当前剪辑长度";
    }
    const camera = option.camera || "";
    const detail = [
      camera ? `${camera} 机` : "",
      identity.status || "未标记",
      identity.note,
    ].filter(Boolean).join(" · ");
    result.push({
      key: `${groupId}:${option.source.source_id}`,
      groupId,
      sourceId: option.source.source_id,
      sourceIn,
      label: takeLabel(identity),
      detail,
      camera,
      status: identity.status,
      blockedReason,
      preferred: Boolean(preferred),
    });
  }

  return result.sort((a, b) => {
    if (Boolean(a.blockedReason) !== Boolean(b.blockedReason)) return a.blockedReason ? 1 : -1;
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
    return a.label.localeCompare(b.label, "zh-CN");
  });
}

function assemblyRisk(plan: AssemblyTimeline | null, clip: TimelineClip): string {
  const blockId = text(clip.metadata.assembly_block_id);
  if (!plan || !blockId) return "";
  for (const scene of plan.scenes) {
    const block = scene.blocks.find((item) => item.block_id === blockId);
    if (block) return text(block.continuity_risk);
  }
  return "";
}

function cameraForClip(project: TimelineProject, review: ReviewModelPayload | null, clip: TimelineClip): string {
  return sourceCamera(project, review, clip.selected_angle_source_id ?? clip.source_id);
}

export function buildEditorialSuggestions(
  review: ReviewModelPayload | null,
  board: SlateBoard | null,
  plan: AssemblyTimeline | null,
  project: TimelineProject,
  sequence: TimelineSequence,
): EditorialSuggestion[] {
  const suggestions: EditorialSuggestion[] = [];
  const videoClips = sequence.tracks
    .filter((track) => track.kind === "video")
    .flatMap((track) => track.clips)
    .filter((clip) => clip.enabled)
    .slice()
    .sort((a, b) => a.timeline_start - b.timeline_start || a.clip_id.localeCompare(b.clip_id));

  for (const clip of videoClips) {
    const groupId = text(clip.metadata.group_id);
    const identity = identityForGroup(review, board, groupId);
    if (clip.multicam_group_id && !clip.selected_angle_source_id) {
      suggestions.push({
        id: `multicam:${clip.clip_id}`,
        tone: "critical",
        kind: "multicam",
        title: "多机位片段尚未选定机位",
        detail: `${takeLabel(identity)} 需要人工明确 A/B/C 机位后才能可靠交付。`,
        clipId: clip.clip_id,
      });
    }
    if (identity.status === "ng") {
      suggestions.push({
        id: `ng:${clip.clip_id}`,
        tone: "critical",
        kind: "take",
        title: "当前剪辑使用了场记 NG 镜次",
        detail: `${takeLabel(identity)} 已被场记标为 NG，建议检查同场同镜头的其他镜次。`,
        clipId: clip.clip_id,
      });
    }
    if (identity.status === "partial" && identity.usableStartSeconds === null) {
      suggestions.push({
        id: `range:${clip.clip_id}`,
        tone: "warning",
        kind: "range",
        title: "部分可用镜次缺少精确范围",
        detail: `${takeLabel(identity)} 目前只有“部分可用”状态，没有可核验的场记入出范围。`,
        clipId: clip.clip_id,
      });
    }
    const risk = assemblyRisk(plan, clip);
    if (risk && !["none", "low", "ok"].includes(risk.toLowerCase())) {
      suggestions.push({
        id: `continuity:${clip.clip_id}`,
        tone: "warning",
        kind: "continuity",
        title: "连续性需要复核",
        detail: `${takeLabel(identity)} 的组接证据标记连续性风险：${risk}。`,
        clipId: clip.clip_id,
      });
    }
  }

  const cameras = videoClips.map((clip) => cameraForClip(project, review, clip));
  for (let index = 2; index < cameras.length; index += 1) {
    const camera = cameras[index];
    if (camera && camera === cameras[index - 1] && camera === cameras[index - 2]) {
      const clip = videoClips[index];
      suggestions.push({
        id: `camera-pattern:${clip.clip_id}`,
        tone: "info",
        kind: "camera_pattern",
        title: `连续使用 ${camera} 机`,
        detail: "连续三个片段使用同一机位。它不一定是问题，但可以检查是否存在更合适的反应镜头或景别变化。",
        clipId: clip.clip_id,
      });
      break;
    }
  }

  const gaps = Number(review?.summary.script_gaps ?? 0);
  if (Number.isFinite(gaps) && gaps > 0) {
    suggestions.push({
      id: "coverage:gaps",
      tone: "warning",
      kind: "coverage",
      title: "仍有剧本覆盖缺口",
      detail: `当前审阅模型报告 ${gaps} 个剧本覆盖缺口；建议在最终交付前回到“剧本 / 覆盖”确认。`,
    });
  }

  return suggestions.slice(0, 18);
}
