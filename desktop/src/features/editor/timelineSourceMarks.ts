import type { TimelineSourceOption } from "./timelineSourceEditing";

export function sourceOptionEnd(option: TimelineSourceOption): number {
  return option.availableIn + option.availableDuration;
}

export function clampSourceCursor(option: TimelineSourceOption, frame: number): number {
  const rounded = Number.isFinite(frame) ? Math.round(frame) : option.availableIn;
  return Math.max(option.availableIn, Math.min(sourceOptionEnd(option), rounded));
}
