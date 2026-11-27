import type { ReviewAngle, ReviewScriptBlock, ReviewTakeGroup } from "../api/host";
import type { EditorialComment, EditorialOpinion } from "../api/planning";
import { collaborationAttention } from "../features/review/reviewAttention";

export interface TeamOpinionRecord extends EditorialOpinion {
  target?: {
    kind?: string;
    group_id?: string;
    segment_id?: string;
  };
}

export function formatClock(seconds: number | null | undefined): string {
  const value = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(value / 60);
  const secs = Math.floor(value % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function angleSourceWindow(angle: ReviewAngle): { start: number; end: number } {
  const start = Math.max(0, Number(angle.playback?.source_start ?? angle.source_start ?? 0));
  const span = Number(angle.timeline_end ?? 0) - Number(angle.timeline_start ?? 0);
  const declaredEnd = angle.playback?.source_end ?? angle.source_end;
  const end = declaredEnd !== null && declaredEnd !== undefined
    ? Number(declaredEnd)
    : span > 0
      ? start + span
      : Infinity;
  return { start, end };
}

/**
 * Compute the corresponding source timestamp when switching from one camera angle
 * to another within the same synchronized Take. Returns `null` if the target
 * angle has no coverage at that moment.
 */
export function syncAngleTime(
  fromAngle: ReviewAngle,
  toAngle: ReviewAngle,
  currentSourceTime: number,
): number | null {
  if (fromAngle.clip_id === toAngle.clip_id) return currentSourceTime;
  const fromStart = Number(fromAngle.playback?.source_start ?? fromAngle.source_start ?? 0);
  const toStart = Number(toAngle.playback?.source_start ?? toAngle.source_start ?? 0);
  const timelinePos = Number(fromAngle.timeline_start ?? 0) + (currentSourceTime - fromStart);
  const relative = timelinePos - Number(toAngle.timeline_start ?? 0);
  const duration = Number(toAngle.timeline_end ?? 0) - Number(toAngle.timeline_start ?? 0);
  if (duration > 0 && (relative < -0.05 || relative > duration + 0.05)) {
    return null;
  }
  const clamped = duration > 0 ? Math.max(0, Math.min(duration, relative)) : Math.max(0, relative);
  return Math.max(0, toStart + clamped);
}

export function allTakeOpinions(take: ReviewTakeGroup): TeamOpinionRecord[] {
  const opinions = (take.editorial_state as { individual_opinions?: { group?: TeamOpinionRecord[]; assignments?: TeamOpinionRecord[] } } | undefined)?.individual_opinions;
  return [
    ...(Array.isArray(opinions?.group) ? opinions.group : []),
    ...(Array.isArray(opinions?.assignments) ? opinions.assignments : []),
  ];
}

export function takeComments(take: ReviewTakeGroup): EditorialComment[] {
  const comments = (take.editorial_state as { comments?: EditorialComment[] } | undefined)?.comments;
  return Array.isArray(comments) ? comments : [];
}

export function myTakeOpinion(
  take: ReviewTakeGroup,
  segmentId: string | null | undefined,
  reviewerId: string,
): TeamOpinionRecord | null {
  const opinions = (take.editorial_state as { individual_opinions?: { group?: TeamOpinionRecord[]; assignments?: TeamOpinionRecord[] } } | undefined)?.individual_opinions;
  const groupMatch = (opinions?.group ?? []).find((row) => row.reviewer_id === reviewerId);
  if (groupMatch) return groupMatch;
  if (segmentId) {
    const segMatch = (opinions?.assignments ?? []).find(
      (row) => row.target?.segment_id === segmentId && row.reviewer_id === reviewerId,
    );
    if (segMatch) return segMatch;
  }
  return (opinions?.assignments ?? []).find((row) => row.reviewer_id === reviewerId) ?? null;
}

export function takeScriptContext(
  take: ReviewTakeGroup,
  blocksById: ReadonlyMap<string, ReviewScriptBlock>,
): { text: string; episode?: number; sceneId?: string } | null {
  const ids = [
    ...(take.effective_mapping?.script_segment_ids ?? []),
    ...(take.candidates ?? []).flatMap((c) => (c.script_segment_ids?.length ? c.script_segment_ids : [c.script_segment_id])),
    ...(take.context?.script_segment_ids ?? []),
  ];
  for (const id of ids) {
    const blk = id ? blocksById.get(id) : undefined;
    if (blk && blk.type !== "scene_heading" && (blk.text || blk.raw_text)) {
      return {
        text: blk.text || blk.raw_text || "",
        episode: blk.episode,
        sceneId: blk.scene_id,
      };
    }
  }
  return null;
}

export function reviewProgress(
  takes: readonly ReviewTakeGroup[],
  reviewerId: string,
): { reviewed: number; total: number } {
  let reviewed = 0;
  for (const take of takes) {
    const mine = myTakeOpinion(take, null, reviewerId);
    if (mine && mine.state && mine.state !== "unreviewed") reviewed += 1;
  }
  return { reviewed, total: takes.length };
}

export function hasTakeOpinionConflict(take: ReviewTakeGroup): boolean {
  const states = new Set(
    allTakeOpinions(take)
      .map((row) => String(row.state || ""))
      .filter((value) => value && value !== "unreviewed"),
  );
  return states.size > 1;
}

export function takeCollaborationSummary(take: ReviewTakeGroup): {
  opinionCount: number;
  commentCount: number;
  hasConflict: boolean;
  summaryText: string;
} {
  const attention = collaborationAttention(take.editorial_state as Parameters<typeof collaborationAttention>[0]);
  const comments = takeComments(take);
  const parts: string[] = [];
  if (attention.opinionCount > 0) parts.push(`${attention.opinionCount} 条意见`);
  if (comments.length > 0) parts.push(`${comments.length} 条批注`);
  return {
    opinionCount: attention.opinionCount,
    commentCount: comments.length,
    hasConflict: attention.conflictingTargets > 0 || hasTakeOpinionConflict(take),
    summaryText: parts.join(" · "),
  };
}
