import type { MediaInventoryItem } from "../../api/mediaRoles";
import type { ReviewTakeGroup } from "../../api/host";

export const SLATE_TAKE_MIME = "application/x-mirrororder-slate-take";

export interface SlateTakeDragPayload {
  version: 1;
  kind: "take";
  groupId: string;
  sourceKind: "take";
  sourceClipId?: string;
}

export interface SlatePools {
  pending: ReviewTakeGroup[];
  placed: ReviewTakeGroup[];
  excluded: ReviewTakeGroup[];
  orphan: MediaInventoryItem[];
}

export function createSlateTakeDragPayload(take: ReviewTakeGroup): SlateTakeDragPayload {
  const sourceClipId = take.angles[0]?.clip_id?.trim();
  return {
    version: 1,
    kind: "take",
    groupId: take.group_id,
    sourceKind: "take",
    ...(sourceClipId ? { sourceClipId } : {}),
  };
}

export function decodeSlateTakeDragPayload(raw: string): SlateTakeDragPayload | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || record.kind !== "take" || record.sourceKind !== "take") return null;
    if (typeof record.groupId !== "string" || !record.groupId.trim()) return null;
    if (record.sourceClipId !== undefined && (typeof record.sourceClipId !== "string" || !record.sourceClipId.trim())) return null;
    return {
      version: 1,
      kind: "take",
      groupId: record.groupId.trim(),
      sourceKind: "take",
      ...(typeof record.sourceClipId === "string" && record.sourceClipId.trim()
        ? { sourceClipId: record.sourceClipId.trim() }
        : {}),
    };
  } catch {
    return null;
  }
}

export function hasHumanPlacement(take: ReviewTakeGroup): boolean {
  const placement = take.editorial_state.legacy_manual?.placement;
  return Boolean(
    placement &&
      ((placement.episode_ids?.length ?? 0) > 0 || (placement.script_segment_ids?.length ?? 0) > 0),
  );
}

export function isReviewExcluded(take: ReviewTakeGroup): boolean {
  return take.editorial_state.legacy_manual?.effective_state === "reject";
}

export function buildSlatePools(takes: ReviewTakeGroup[], mediaItems: MediaInventoryItem[]): SlatePools {
  const pending: ReviewTakeGroup[] = [];
  const placed: ReviewTakeGroup[] = [];
  const excluded: ReviewTakeGroup[] = [];
  for (const take of takes) {
    if (isReviewExcluded(take)) excluded.push(take);
    else if (hasHumanPlacement(take)) placed.push(take);
    else pending.push(take);
  }

  const linkedMediaIds = new Set(
    takes.flatMap((take) => take.angles.map((angle) => angle.media_id).filter(Boolean)),
  );
  const orphan = mediaItems.filter((item) => !linkedMediaIds.has(item.media_id));
  return { pending, placed, excluded, orphan };
}
