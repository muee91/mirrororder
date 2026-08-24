import type { ReviewModelPayload, ReviewTakeGroup } from "../../api/host";

export type TakeStatusFilter = "all" | "candidate" | "pending" | "placed" | "rejected";

export interface VirtualRange {
  start: number;
  end: number;
  paddingTop: number;
  paddingBottom: number;
}

export const TAKE_ROW_HEIGHT = 264;
export const TAKE_VIRTUAL_OVERSCAN = 3;

export function takeStatus(take: ReviewTakeGroup): Exclude<TakeStatusFilter, "all"> {
  if (take.editorial_state.legacy_manual?.effective_state === "reject") {
    return "rejected";
  }
  const mapping = take.effective_mapping;
  if (
    mapping.source !== "none" &&
    (mapping.episode_ids.length > 0 || mapping.script_segment_ids.length > 0)
  ) {
    return "placed";
  }
  const automaticStatus = take.automatic_state.status ?? "";
  if (take.candidates.length > 0 || automaticStatus === "needs_review") {
    return "candidate";
  }
  return "pending";
}

export function takeEpisodeIds(take: ReviewTakeGroup): number[] {
  const values = new Set<number>();
  for (const episode of take.effective_mapping.episode_ids) {
    if (episode > 0) values.add(episode);
  }
  for (const episode of take.context.episode_ids) {
    if (episode > 0) values.add(episode);
  }
  for (const candidate of take.candidates) {
    for (const episode of candidate.episode_ids ?? []) {
      if (episode > 0) values.add(episode);
    }
    for (const episode of candidate.context_episodes ?? []) {
      if (episode > 0) values.add(episode);
    }
  }
  return [...values].sort((left, right) => left - right);
}

export function takeMatchesFilters(
  take: ReviewTakeGroup,
  status: TakeStatusFilter,
  episode: number | null,
): boolean {
  if (status !== "all" && takeStatus(take) !== status) return false;
  if (episode !== null && !takeEpisodeIds(take).includes(episode)) return false;
  return true;
}

export function preferredScriptSegmentId(take: ReviewTakeGroup): string | null {
  const mapped = take.effective_mapping.script_segment_ids[0];
  if (mapped) return mapped;
  for (const candidate of take.candidates) {
    const segmentId = candidate.script_segment_ids?.[0] || candidate.script_segment_id;
    if (segmentId) return segmentId;
  }
  return take.context.script_segment_ids[0] ?? null;
}

export function relatedTakeIds(model: ReviewModelPayload, segmentId: string): string[] {
  const ranked: Array<{ rank: number; index: number; groupId: string }> = [];
  model.take_groups.forEach((take, index) => {
    if (take.effective_mapping.script_segment_ids.includes(segmentId)) {
      ranked.push({ rank: 0, index, groupId: take.group_id });
      return;
    }
    if (
      take.candidates.some((candidate) =>
        (candidate.script_segment_ids?.length ? candidate.script_segment_ids : [candidate.script_segment_id]).includes(segmentId),
      )
    ) {
      ranked.push({ rank: 1, index, groupId: take.group_id });
      return;
    }
    if (take.context.script_segment_ids.includes(segmentId)) {
      ranked.push({ rank: 2, index, groupId: take.group_id });
    }
  });
  ranked.sort((left, right) => left.rank - right.rank || left.index - right.index);
  return ranked.map((item) => item.groupId);
}

export function virtualRange(
  total: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = TAKE_ROW_HEIGHT,
  overscan = TAKE_VIRTUAL_OVERSCAN,
): VirtualRange {
  if (total <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 };
  }
  const safeScrollTop = Math.max(0, scrollTop);
  const safeViewport = Math.max(rowHeight, viewportHeight);
  const firstVisible = Math.floor(safeScrollTop / rowHeight);
  const visibleRows = Math.ceil(safeViewport / rowHeight);
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(total, firstVisible + visibleRows + overscan);
  return {
    start,
    end,
    paddingTop: start * rowHeight,
    paddingBottom: Math.max(0, (total - end) * rowHeight),
  };
}
