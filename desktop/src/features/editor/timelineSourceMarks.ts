import type { TimelineSourceOption } from "./timelineSourceEditing";

export interface ManualSourceRange {
  sourceIn: number;
  duration: number;
}

export function sourceOptionEnd(option: TimelineSourceOption): number {
  return option.availableIn + option.availableDuration;
}

export function clampSourceCursor(option: TimelineSourceOption, frame: number): number {
  const rounded = Number.isFinite(frame) ? Math.round(frame) : option.availableIn;
  return Math.max(option.availableIn, Math.min(sourceOptionEnd(option), rounded));
}

export function markSourceIn(
  option: TimelineSourceOption,
  current: ManualSourceRange,
  cursor: number,
): ManualSourceRange {
  const nextIn = clampSourceCursor(option, cursor);
  const currentOut = current.sourceIn + current.duration;
  if (nextIn >= currentOut) {
    throw new Error("Mark In 必须早于当前 Mark Out");
  }
  return { sourceIn: nextIn, duration: currentOut - nextIn };
}

export function markSourceOut(
  option: TimelineSourceOption,
  current: ManualSourceRange,
  cursor: number,
): ManualSourceRange {
  const nextOut = clampSourceCursor(option, cursor);
  if (nextOut <= current.sourceIn) {
    throw new Error("Mark Out 必须晚于当前 Mark In");
  }
  return { sourceIn: current.sourceIn, duration: nextOut - current.sourceIn };
}
