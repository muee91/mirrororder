import type { TimelineClip, TimelineMulticamGroup, TimelineProject } from "../../api/timeline";

// Read-only compatibility for Timeline v1 checkpoints. New v2 edits persist
// synchronization as typed MulticamGroup.angles fields instead of clip metadata.
export const MULTICAM_SYNC_METADATA_KEY = "multicam_sync_v1";

export interface TimelineSyncRange {
  source_id: string;
  start_frame: number;
  end_frame: number;
}

interface TimelineSyncEnvelope {
  version: 1;
  sources: TimelineSyncRange[];
}

function validFrame(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function normalizeRange(value: TimelineSyncRange): TimelineSyncRange | null {
  const sourceId = String(value.source_id || "").trim();
  if (!sourceId || !validFrame(value.start_frame) || !validFrame(value.end_frame) || value.end_frame <= value.start_frame) {
    return null;
  }
  return { source_id: sourceId, start_frame: value.start_frame, end_frame: value.end_frame };
}

/** @deprecated v1 compatibility writer for fixtures/migrations only. */
export function encodeMulticamSyncRanges(ranges: TimelineSyncRange[]): string | null {
  const normalized = ranges.map(normalizeRange);
  if (normalized.some((value) => value === null)) return null;
  const sources = normalized as TimelineSyncRange[];
  const unique = new Map(sources.map((value) => [value.source_id, value]));
  if (unique.size !== sources.length || unique.size < 2) return null;
  const envelope: TimelineSyncEnvelope = {
    version: 1,
    sources: [...unique.values()].sort((left, right) => left.source_id.localeCompare(right.source_id)),
  };
  return JSON.stringify(envelope);
}

export function decodeMulticamSyncRanges(raw: string | undefined): Map<string, TimelineSyncRange> | null {
  if (!raw) return null;
  try {
    const envelope = JSON.parse(raw) as Partial<TimelineSyncEnvelope>;
    if (envelope.version !== 1 || !Array.isArray(envelope.sources)) return null;
    const normalized = envelope.sources.map((value) => normalizeRange(value));
    if (normalized.some((value) => value === null)) return null;
    const sources = normalized as TimelineSyncRange[];
    const result = new Map(sources.map((value) => [value.source_id, value]));
    return result.size === sources.length && result.size >= 2 ? result : null;
  } catch {
    return null;
  }
}

export function multicamSourceIds(group: TimelineMulticamGroup): string[] {
  const typed = (group.angles ?? []).map((angle) => angle.source_id).filter(Boolean);
  return typed.length ? typed : group.angle_source_ids;
}

function typedSyncRanges(group: TimelineMulticamGroup | null): Map<string, TimelineSyncRange> | null {
  if (!group?.angles?.length) return null;
  const ranges: TimelineSyncRange[] = [];
  for (const angle of group.angles) {
    if (angle.sync_start_frame === null || angle.sync_start_frame === undefined
      || angle.sync_end_frame === null || angle.sync_end_frame === undefined) return null;
    const normalized = normalizeRange({
      source_id: angle.source_id,
      start_frame: angle.sync_start_frame,
      end_frame: angle.sync_end_frame,
    });
    if (!normalized) return null;
    ranges.push(normalized);
  }
  const result = new Map(ranges.map((value) => [value.source_id, value]));
  return result.size === ranges.length && result.size >= 2 ? result : null;
}

export function rebaseMulticamSourceFrame(
  project: TimelineProject,
  clip: TimelineClip,
  baseSourceFrame: number,
): number | null {
  if (!Number.isSafeInteger(baseSourceFrame) || baseSourceFrame < 0) return null;
  const selectedSourceId = clip.selected_angle_source_id || clip.source_id;
  if (selectedSourceId === clip.source_id) return baseSourceFrame;
  if (!clip.multicam_group_id) return null;

  const group = project.multicam_groups.find((value) => value.group_id === clip.multicam_group_id) ?? null;
  const ranges = typedSyncRanges(group)
    ?? decodeMulticamSyncRanges(clip.metadata[MULTICAM_SYNC_METADATA_KEY]);
  const base = ranges?.get(clip.source_id) ?? null;
  const selected = ranges?.get(selectedSourceId) ?? null;
  if (!base || !selected) return null;
  if (baseSourceFrame < base.start_frame || baseSourceFrame >= base.end_frame) return null;
  const relative = baseSourceFrame - base.start_frame;
  const selectedFrame = selected.start_frame + relative;
  if (selectedFrame < selected.start_frame || selectedFrame >= selected.end_frame) return null;
  return selectedFrame;
}
