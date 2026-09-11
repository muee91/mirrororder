import type { ReviewModelPayload, ReviewTakeGroup } from "../../api/host";
import { reviewTakeAttention } from "../review/reviewAttention";

export type TakeStatusFilter = "all" | "attention" | "candidate" | "pending" | "placed" | "rejected";

export interface VirtualRange {
  start: number;
  end: number;
  paddingTop: number;
  paddingBottom: number;
}

export const TAKE_ROW_HEIGHT = 314;
export const TAKE_VIRTUAL_OVERSCAN = 3;

export function takeStatus(take: ReviewTakeGroup): Exclude<TakeStatusFilter, "all" | "attention"> {
  if (take.editorial_state.excluded === true || take.editorial_state.legacy_manual?.effective_state === "reject") {
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
  if (status === "attention") {
    if (!reviewTakeAttention(take).hasAttention) return false;
  } else if (status !== "all" && takeStatus(take) !== status) {
    return false;
  }
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

function candidateSegmentIds(take: ReviewTakeGroup): string[] {
  const values = new Set<string>();
  for (const candidate of take.candidates) {
    const segmentIds = candidate.script_segment_ids?.length
      ? candidate.script_segment_ids
      : [candidate.script_segment_id];
    for (const segmentId of segmentIds) {
      if (segmentId) values.add(segmentId);
    }
  }
  return [...values];
}

export interface ScriptTakeProjection {
  mappedTakeIds: Map<string, string[]>;
  candidateTakeIds: Map<string, string[]>;
  relatedTakeIds: Map<string, string[]>;
}

/**
 * 派生读模型：一次 O(takes × segments) 扫描建立 segmentId → Take 索引，
 * 剧本侧所有 mapped/candidate/related 查询都应消费这里的结果，而不是在
 * render 路径里反复全量扫描 take_groups（1500 Take 规模下每键一扫不可接受）。
 * 顺序语义与旧的逐 take filter 完全一致：mapped → candidate → context，
 * 同 rank 内保持 take_groups 顺序。
 *
 * 缓存契约：projection 按 ReviewModelPayload 对象身份缓存（WeakMap）。
 * payload 视为不可变值——唯一更新路径是 useReviewModelSnapshot 用新解码的
 * payload 整体替换（setModel(next)），任何代码不得原地修改
 * model / take_groups / effective_mapping / candidates；对象身份变化即重建，
 * 由此保证不会出现 stale derived state。
 */
export function buildScriptTakeProjection(model: ReviewModelPayload): ScriptTakeProjection {
  const mapped = new Map<string, Array<{ index: number; groupId: string }>>();
  const candidates = new Map<string, Array<{ index: number; groupId: string }>>();
  const contextOnly = new Map<string, Array<{ index: number; groupId: string }>>();
  const addEntry = (
    target: Map<string, Array<{ index: number; groupId: string }>>,
    segmentId: string,
    index: number,
    groupId: string,
  ): void => {
    const rows = target.get(segmentId);
    if (rows) rows.push({ index, groupId });
    else target.set(segmentId, [{ index, groupId }]);
  };

  model.take_groups.forEach((take, index) => {
    const groupId = take.group_id;
    const mappedIds = new Set(take.effective_mapping.script_segment_ids);
    const candidateIds = candidateSegmentIds(take);
    const candidateIdSet = new Set(candidateIds);
    for (const segmentId of mappedIds) addEntry(mapped, segmentId, index, groupId);
    for (const segmentId of candidateIds) {
      if (!mappedIds.has(segmentId)) addEntry(candidates, segmentId, index, groupId);
    }
    for (const segmentId of take.context.script_segment_ids) {
      if (!mappedIds.has(segmentId) && !candidateIdSet.has(segmentId)) {
        addEntry(contextOnly, segmentId, index, groupId);
      }
    }
  });

  const toIdMap = (source: Map<string, Array<{ index: number; groupId: string }>>): Map<string, string[]> => {
    const result = new Map<string, string[]>();
    for (const [segmentId, rows] of source) {
      result.set(segmentId, rows.map((row) => row.groupId));
    }
    return result;
  };

  const mappedTakeIds = toIdMap(mapped);
  const candidateTakeIds = toIdMap(candidates);
  const contextTakeIds = toIdMap(contextOnly);
  const relatedTakeIds = new Map<string, string[]>();
  const relatedKeys = new Set<string>([...mappedTakeIds.keys(), ...candidateTakeIds.keys(), ...contextTakeIds.keys()]);
  for (const segmentId of relatedKeys) {
    relatedTakeIds.set(segmentId, [
      ...(mappedTakeIds.get(segmentId) ?? []),
      ...(candidateTakeIds.get(segmentId) ?? []),
      ...(contextTakeIds.get(segmentId) ?? []),
    ]);
  }
  return { mappedTakeIds, candidateTakeIds, relatedTakeIds };
}

const scriptTakeProjectionCache = new WeakMap<ReviewModelPayload, ScriptTakeProjection>();

function projectionOf(model: ReviewModelPayload): ScriptTakeProjection {
  let projection = scriptTakeProjectionCache.get(model);
  if (!projection) {
    projection = buildScriptTakeProjection(model);
    scriptTakeProjectionCache.set(model, projection);
  }
  return projection;
}

export function mappedTakeIds(model: ReviewModelPayload, segmentId: string): string[] {
  return projectionOf(model).mappedTakeIds.get(segmentId) ?? [];
}

export function candidateTakeIds(model: ReviewModelPayload, segmentId: string): string[] {
  return projectionOf(model).candidateTakeIds.get(segmentId) ?? [];
}

export function relatedTakeIds(model: ReviewModelPayload, segmentId: string): string[] {
  return projectionOf(model).relatedTakeIds.get(segmentId) ?? [];
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
