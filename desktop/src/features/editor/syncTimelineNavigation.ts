import type { FrameRate } from "../../api/timeline";
import type { MulticamSyncClip, MulticamSyncGap, MulticamSyncTimeline } from "../../api/syncTimeline";

export { clamp, boundedWindow, zoomWindow, pointerFrame, type FrameWindow } from "./timelineViewport";
export function confirmedSyncRate(timeline: MulticamSyncTimeline): FrameRate | null {
  const value = timeline.timebase;
  return value?.status === "confirmed" && Number.isSafeInteger(value.numerator) && Number(value.numerator) > 0
    && Number.isSafeInteger(value.denominator) && Number(value.denominator) > 0
    ? { numerator: value.numerator!, denominator: value.denominator! } : null;
}
// All interaction state is integral frames. Floating seconds exist only at media/API boundaries.
export const toFrame = (seconds: number, rate: FrameRate): number => Math.round(seconds * rate.numerator / rate.denominator);
export const toSeconds = (frame: number, rate: FrameRate): number => frame * rate.denominator / rate.numerator;
export function firstClipFrame(seconds: number, rate: FrameRate): number {
  const nearest = toFrame(seconds, rate);
  return toSeconds(nearest, rate) < seconds ? nearest + 1 : nearest;
}

interface IndexedReviewGap {
  masterStart: number;
  reviewStart: number;
  removedFrames: number;
}

export function indexReviewGaps(gaps: MulticamSyncGap[]): IndexedReviewGap[] {
  let removedFrames = 0;
  return gaps.map(({ start_frame, end_frame }) => {
    const reviewStart = start_frame - removedFrames;
    removedFrames += end_frame - start_frame;
    return { masterStart: start_frame, reviewStart, removedFrames };
  });
}

function lastGapAt(gaps: IndexedReviewGap[], frame: number, key: "masterStart" | "reviewStart"): IndexedReviewGap | undefined {
  let low = 0;
  let high = gaps.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (gaps[middle][key] <= frame) low = middle + 1;
    else high = middle;
  }
  return gaps[low - 1];
}

export function toReviewFrame(frame: number, gaps: IndexedReviewGap[]): number {
  const gap = lastGapAt(gaps, frame, "masterStart");
  return gap ? Math.max(gap.reviewStart, frame - gap.removedFrames) : frame;
}

export function toMasterFrame(frame: number, gaps: IndexedReviewGap[]): number {
  return frame + (lastGapAt(gaps, frame, "reviewStart")?.removedFrames ?? 0);
}

export function compactSyncTimeline(timeline: MulticamSyncTimeline, rate: FrameRate, gaps: IndexedReviewGap[]): MulticamSyncTimeline {
  return {
    ...timeline,
    duration_seconds: timeline.duration_seconds - toSeconds(gaps.at(-1)?.removedFrames ?? 0, rate),
    tracks: timeline.tracks.map(track => ({
      ...track,
      clips: track.clips.map(clip => {
        const frame = firstClipFrame(clip.timeline_start, rate);
        const phase = toSeconds(frame, rate) - clip.timeline_start;
        return { ...clip, timeline_start: toSeconds(toReviewFrame(frame, gaps), rate) - phase };
      }),
    })),
  };
}

export { timecode, parseTimecode } from "./timelineTimecode";
export function cameraColor(camera: string): string {
  const colors: Record<string, string> = {
    A: "#38b2ac",
    B: "#dd8b42",
    C: "#937ce6",
    D: "#4e94e6",
    E: "#d96b9e",
    F: "#8db84e",
  };
  const name = camera.trim().toUpperCase();
  return colors[name] || (/^[A-Z]$/.test(name) ? `hsl(${Math.round((name.charCodeAt(0) - 65) * 137.508) % 360} 55% 58%)` : "#81909d");
}
export interface ClipIndex { clips: MulticamSyncClip[]; maxEnds: number[] }
export function indexClips(clips: MulticamSyncClip[]): ClipIndex {
  let end = 0;
  return { clips, maxEnds: clips.map(clip => (end = Math.max(end, clip.timeline_start + clip.duration))) };
}
export function visibleClips(index: ClipIndex, start: number, end: number): MulticamSyncClip[] {
  let lo = 0, hi = index.clips.length;
  while (lo < hi) { const middle = (lo + hi) >>> 1; if (index.maxEnds[middle] <= start) lo = middle + 1; else hi = middle; }
  const result: MulticamSyncClip[] = [];
  for (let i = lo; i < index.clips.length && index.clips[i].timeline_start < end; i++) {
    const clip = index.clips[i];
    if (clip.timeline_start + clip.duration > start) result.push(clip);
  }
  return result;
}
export function activeClip(index: ClipIndex | undefined, seconds: number): MulticamSyncClip | undefined {
  return index ? visibleClips(index, seconds, seconds + 0.000001).find(clip => clip.timeline_start <= seconds) : undefined;
}
