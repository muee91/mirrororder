import type { ReviewSourceTiming } from "../../api/desktop";
import type { ReviewAngle } from "../../api/host";
import type { MulticamSyncClip, MulticamSyncTimeline } from "../../api/syncTimeline";
import type { FrameRate } from "../../api/timeline";
import { confirmedSyncRate, toFrame, toSeconds } from "../editor/syncTimelineNavigation";
import { parseTimecode, timecode } from "../editor/timelineTimecode";

function elapsed(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1000));
  const whole = Math.floor(milliseconds / 1000);
  return [
    Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60,
  ].map((part) => String(part).padStart(2, "0")).join(":")
    + `.${String(milliseconds % 1000).padStart(3, "0")}`;
}

function sourceTimecode(origin: string, sourceFrame: number, rate: FrameRate): string | null {
  const nominal = Math.round(rate.numerator / rate.denominator);
  const start = parseTimecode(origin.replace(";", ":"), rate);
  if (start === null || start >= nominal * 86400) return null;
  if (!origin.includes(";")) return timecode((start + sourceFrame) % (nominal * 86400), rate);
  if (rate.denominator !== 1001 || ![30000, 60000].includes(rate.numerator)) return null;
  const dropped = nominal / 15;
  const minute = Math.floor(start / (nominal * 60));
  if (minute % 10 !== 0 && start % (nominal * 60) < dropped) return null;
  const perMinute = nominal * 60 - dropped;
  const perTenMinutes = nominal * 600 - 9 * dropped;
  const frame = (start - dropped * (minute - Math.floor(minute / 10)) + sourceFrame) % (perTenMinutes * 144);
  const labelFrame = frame + dropped * (9 * Math.floor(frame / perTenMinutes)
    + Math.max(0, Math.floor((frame % perTenMinutes - dropped) / perMinute)));
  return timecode(labelFrame, rate).replace(/:(\d+)$/, ";$1");
}

function syncPlacement(angle: ReviewAngle, timeline?: MulticamSyncTimeline): MulticamSyncClip | undefined {
  if (!timeline?.ready) return undefined;
  const placements = timeline.tracks.flatMap((track) => track.clips.filter((clip) => clip.media_clip_id === angle.clip_id));
  return placements.length === 1 ? placements[0] : undefined;
}

export function reviewMasterOffset(angle: ReviewAngle, timeline?: MulticamSyncTimeline): number {
  const rate = timeline ? confirmedSyncRate(timeline) : null;
  const offset = syncPlacement(angle, timeline)?.manual_offset_frames ?? 0;
  return rate ? toSeconds(offset, rate) : 0;
}

export function reviewLocationText(
  angle: ReviewAngle, seconds: number, camera: string,
  timeline?: MulticamSyncTimeline, timing?: ReviewSourceTiming,
): string {
  const placement = syncPlacement(angle, timeline);
  const source = timing?.clip_id === angle.clip_id && timing.media_id === angle.media_id ? timing : undefined;
  const proposedRate = source?.frame_rate;
  const rate = proposedRate && Number.isSafeInteger(proposedRate.numerator) && proposedRate.numerator > 0
    && Number.isSafeInteger(proposedRate.denominator) && proposedRate.denominator > 0 ? proposedRate : undefined;
  const sourceOut = angle.playback.source_end ?? angle.source_end ?? Infinity;
  const sourceIn = angle.playback.source_start ?? angle.source_start;
  const sourcePosition = Math.max(sourceIn, Math.min(sourceOut, seconds));
  const positionInFrames = rate ? Math.max(0, Math.min(Math.ceil(sourceOut * rate.numerator / rate.denominator) - 1,
    Math.floor(sourcePosition * rate.numerator / rate.denominator + 1e-7))) : undefined;
  const sourceCode = rate && positionInFrames !== undefined
    ? sourceTimecode(source?.start_timecode || placement?.timecode || "", positionInFrames, rate) : null;
  const masterRate = timeline?.ready ? confirmedSyncRate(timeline) : null;
  const frameSeconds = rate && positionInFrames !== undefined
    ? positionInFrames * rate.denominator / rate.numerator : sourcePosition;
  const masterSeconds = angle.timeline_start + Math.max(0, frameSeconds - sourceIn);
  const masterFrame = masterRate && placement
    ? toFrame(masterSeconds, masterRate) + (placement.manual_offset_frames ?? 0) : null;
  return [
    `${camera} · ${source?.filename || placement?.name || angle.name}`,
    sourceCode ? `原片时码 ${sourceCode}` : `原片位置 ${elapsed(sourcePosition)}`,
    masterRate && masterFrame !== null ? `同步母版时码 ${timecode(masterFrame, masterRate)}` : `项目内位置 ${elapsed(masterSeconds)}`,
  ].join("\n");
}

export function reviewSourceClock(seconds: number): string {
  const tenths = Math.floor(Math.max(0, seconds) * 10 + 1e-6);
  return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, "0")}.${tenths % 10}`;
}
