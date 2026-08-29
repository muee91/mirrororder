import type { TimelineClip, TimelineProject, TimelineSequence, TimelineSource, TimelineTrack } from "../../api/timeline";
import { rebaseMulticamSourceFrame } from "./timelineSync";

export interface LocatedTimelineClip {
  track: TimelineTrack;
  clip: TimelineClip;
}

export interface ProgramMediaState extends LocatedTimelineClip {
  source: TimelineSource;
  sourceFrame: number;
  sourceSeconds: number;
}

export function sequenceFps(sequence: TimelineSequence): number {
  const numerator = Number(sequence.frame_rate.numerator);
  const denominator = Number(sequence.frame_rate.denominator);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) {
    return 24;
  }
  return numerator / denominator;
}

export function sequenceEnd(sequence: TimelineSequence): number {
  let end = 0;
  for (const track of sequence.tracks) {
    for (const clip of track.clips) {
      end = Math.max(end, clip.timeline_start + clip.duration);
    }
  }
  return end;
}

export function clampPlayhead(sequence: TimelineSequence, frame: number): number {
  const value = Number.isFinite(frame) ? Math.round(frame) : 0;
  return Math.max(0, Math.min(sequenceEnd(sequence), value));
}

export function videoClipAtPlayhead(sequence: TimelineSequence, playhead: number): LocatedTimelineClip | null {
  for (const track of sequence.tracks) {
    if (track.kind !== "video") continue;
    const clip = track.clips.find((item) => item.enabled && item.timeline_start <= playhead && playhead < item.timeline_start + item.duration);
    if (clip) return { track, clip };
  }
  return null;
}

export function activeSourceId(clip: TimelineClip): string {
  return clip.selected_angle_source_id || clip.source_id;
}

export function sourceForClip(project: TimelineProject, clip: TimelineClip): TimelineSource | null {
  const sourceId = activeSourceId(clip);
  return project.sources.find((source) => source.source_id === sourceId) ?? null;
}

export function synchronizedSourceFrame(clip: TimelineClip, baseSourceFrame: number): number | null {
  return rebaseMulticamSourceFrame(clip, baseSourceFrame);
}

export function programMediaAtPlayhead(
  project: TimelineProject,
  sequence: TimelineSequence,
  playhead: number,
): ProgramMediaState | null {
  const located = videoClipAtPlayhead(sequence, playhead);
  if (!located) return null;
  const source = sourceForClip(project, located.clip);
  if (!source) return null;
  const baseSourceFrame = located.clip.source_in + Math.max(0, playhead - located.clip.timeline_start);
  const sourceFrame = synchronizedSourceFrame(located.clip, baseSourceFrame);
  if (sourceFrame === null) return null;
  return {
    ...located,
    source,
    sourceFrame,
    sourceSeconds: sourceFrame / sequenceFps(sequence),
  };
}

export function selectedSourceState(
  project: TimelineProject,
  sequence: TimelineSequence,
  clip: TimelineClip | null,
): { source: TimelineSource; sourceSeconds: number } | null {
  if (!clip) return null;
  const source = sourceForClip(project, clip);
  if (!source) return null;
  const sourceFrame = synchronizedSourceFrame(clip, clip.source_in);
  if (sourceFrame === null) return null;
  return { source, sourceSeconds: sourceFrame / sequenceFps(sequence) };
}

export function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return target.isContentEditable || tag === "input" || tag === "textarea" || tag === "select" || tag === "button";
}
