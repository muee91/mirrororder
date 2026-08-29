import type { TimelineClip } from "../../api/timeline";

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

export function rebaseMulticamSourceFrame(clip: TimelineClip, baseSourceFrame: number): number | null {
  if (!Number.isSafeInteger(baseSourceFrame) || baseSourceFrame < 0) return null;
  const selectedSourceId = clip.selected_angle_source_id || clip.source_id;
  if (selectedSourceId === clip.source_id) return baseSourceFrame;
  const ranges = decodeMulticamSyncRanges(clip.metadata[MULTICAM_SYNC_METADATA_KEY]);
  const base = ranges?.get(clip.source_id) ?? null;
  const selected = ranges?.get(selectedSourceId) ?? null;
  if (!base || !selected) return null;
  if (baseSourceFrame < base.start_frame || baseSourceFrame >= base.end_frame) return null;
  const relative = baseSourceFrame - base.start_frame;
  const selectedFrame = selected.start_frame + relative;
  if (selectedFrame < selected.start_frame || selectedFrame >= selected.end_frame) return null;
  return selectedFrame;
}
