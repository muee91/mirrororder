import type { FrameRate } from "../../api/timeline";

// Nominal-frame, non-drop timecode, matching existing sync display semantics.
// Fractional rates retain their rational timebase; labels do not imply elapsed wall time.
export function timecode(frame: number, rate: FrameRate): string {
  const nominal = Math.round(rate.numerator / rate.denominator);
  const value = Math.max(0, Math.round(frame));
  const seconds = Math.floor(value / nominal);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60, value % nominal]
    .map(part => String(part).padStart(2, "0")).join(":");
}
export function parseTimecode(text: string, rate: FrameRate): number | null {
  const match = /^(\d{1,3}):(\d{2}):(\d{2}):(\d{2,3})$/.exec(text.trim());
  if (!match) return null;
  const [h, m, s, f] = match.slice(1).map(Number);
  const nominal = Math.round(rate.numerator / rate.denominator);
  return m < 60 && s < 60 && f < nominal ? ((h * 60 + m) * 60 + s) * nominal + f : null;
}
