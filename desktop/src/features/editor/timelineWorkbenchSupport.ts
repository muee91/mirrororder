import type { TimelineClip, TimelineSnapshot, TimelineTrack } from "../../api/timeline";

export function errorMessage(error: unknown): string {
  const value = error as { message?: string; issues?: Array<{ message?: string }> };
  if (value && typeof value === "object" && typeof value.message === "string") {
    const detail = Array.isArray(value.issues) ? value.issues[0]?.message : "";
    return detail ? `${value.message}：${detail}` : value.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function activeSequence(snapshot: TimelineSnapshot | null) {
  if (!snapshot) return null;
  return snapshot.project.sequences.find((sequence) => sequence.sequence_id === snapshot.project.active_sequence_id)
    ?? snapshot.project.sequences[0]
    ?? null;
}

export function findClip(snapshot: TimelineSnapshot | null, clipId: string): { track: TimelineTrack; clip: TimelineClip } | null {
  const sequence = activeSequence(snapshot);
  if (!sequence) return null;
  for (const track of sequence.tracks) {
    const clip = track.clips.find((item) => item.clip_id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

export function frameLabel(value: number): string {
  return `${Math.round(value)}f`;
}

export function positiveInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function statusLabel(value: string): string {
  return { usable: "可用", partial: "部分可用", ng: "NG", unmarked: "未标记", ready: "可建立", needs_review: "需复核", blocked: "阻塞" }[value] ?? (value || "未标记");
}

export function localizedEditorialText(value: string): string {
  return value
    .replaceAll("Assembly block", "初始顺片块")
    .replaceAll("Assembly", "初始顺片")
    .replaceAll("Review source inventory", "审阅媒体清单")
    .replaceAll("Review inventory", "审阅媒体清单")
    .replaceAll("Source pool", "素材池")
    .replaceAll("source pool", "素材池")
    .replaceAll("Timeline Inspector", "片段检查器")
    .replaceAll("Timeline", "时间线")
    .replaceAll("typed sync range", "结构化同步范围")
    .replaceAll("typed sync", "结构化同步")
    .replaceAll("Best/范围决策", "最佳镜次/范围决策")
    .replaceAll("Best", "最佳镜次")
    .replaceAll("replacement Source", "替换素材")
    .replaceAll("Source In", "源入点")
    .replaceAll("Duration", "时长")
    .replaceAll("Source", "素材");
}

export function decisionLabel(value: string): string {
  return { editorial_decision: "人工最终选择", script_supervisor: "场记事实", explicit_best: "明确最佳镜次", human_source_monitor: "人工素材监看", replace_take: "人工换镜次" }[value] ?? (value || "人工编辑");
}

export function trimLabel(value: string): string {
  return { script_supervisor_usable_range: "场记可用范围", script_supervisor_partial_pending: "场记部分可用 · 待精修", full_take_range: "完整镜次范围", human_source_monitor: "人工素材范围" }[value] ?? (value || "人工范围");
}
