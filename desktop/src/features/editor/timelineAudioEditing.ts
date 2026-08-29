import type { TimelineCommand, TimelineSequence, TimelineSnapshot } from "../../api/timeline";
import { validateManualSourceRange, type TimelineSourceOption } from "./timelineSourceEditing";

export type ManualAudioEditMode = "insert" | "overwrite";

export function audioTrackId(sequence: TimelineSequence): string | null {
  return sequence.tracks.find((track) => track.kind === "audio")?.track_id ?? null;
}

export function audioInsertCutsExistingClip(sequence: TimelineSequence, playhead: number): boolean {
  const trackId = audioTrackId(sequence);
  if (!trackId) return false;
  const frame = Math.max(0, Math.round(playhead));
  const track = sequence.tracks.find((item) => item.track_id === trackId);
  return Boolean(track?.clips.some((clip) => clip.timeline_start < frame && frame < clip.timeline_start + clip.duration));
}

function manualAudioClipId(
  mode: ManualAudioEditMode,
  snapshot: TimelineSnapshot,
  sourceId: string,
  playhead: number,
): string {
  return [
    "manual",
    "audio",
    mode,
    snapshot.authority.generation,
    String(snapshot.authority.revision + 1),
    String(playhead),
    encodeURIComponent(sourceId),
  ].join(":");
}

export function buildManualAudioCommand(
  mode: ManualAudioEditMode,
  snapshot: TimelineSnapshot,
  sequence: TimelineSequence,
  option: TimelineSourceOption,
  sourceIn: number,
  duration: number,
  playhead: number,
): TimelineCommand {
  const validation = validateManualSourceRange(option, sourceIn, duration);
  if (validation) throw new Error(validation);
  const trackId = audioTrackId(sequence);
  if (!trackId) throw new Error("当前 Timeline 没有独立音频轨");
  const timelineStart = Math.max(0, Math.round(playhead));
  const metadata: Record<string, string> = {
    edit_source: "human_source_monitor",
    edit_mode: mode,
    media_component: "audio",
    source_clip_id: option.source.clip_id,
    source_pool: "review_playable_media",
  };
  if (option.groupId) metadata.group_id = option.groupId;
  if (option.camera) metadata.camera = option.camera;

  return {
    type: mode,
    sequence_id: sequence.sequence_id,
    track_id: trackId,
    clip: {
      clip_id: manualAudioClipId(mode, snapshot, option.source.source_id, timelineStart),
      source_id: option.source.source_id,
      timeline_start: timelineStart,
      source_in: sourceIn,
      duration,
      enabled: true,
      // Independent audio has one explicit source. Multicam switching remains a
      // video-clip operation; carrying those fields onto A-tracks would create a
      // second, ambiguous source-time authority.
      multicam_group_id: null,
      selected_angle_source_id: null,
      metadata,
    },
  };
}
