import type { ReviewModelPayload } from "../../api/host";
import type {
  TimelineCommand,
  TimelineProject,
  TimelineSequence,
  TimelineSnapshot,
  TimelineSource,
} from "../../api/timeline";
import { sequenceFps } from "./editorPlayback";

export type ManualSourceEditMode = "insert" | "overwrite";

export interface TimelineSourceOption {
  source: TimelineSource;
  groupId: string;
  camera: string;
  availableIn: number;
  availableDuration: number;
  multicamGroupId: string | null;
  label: string;
}

function secondsToFrames(seconds: number, fps: number): number {
  return Math.max(0, Math.round(seconds * fps));
}

function positiveDuration(value: number | null | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : Math.max(1, fallback);
}

export function buildTimelineSourceOptions(
  review: ReviewModelPayload | null,
  project: TimelineProject,
  sequence: TimelineSequence,
): TimelineSourceOption[] {
  if (!review) return [];
  const fps = sequenceFps(sequence);
  const reviewAngles = new Map<string, { groupId: string; camera: string; sourceStart: number; sourceEnd: number | null; duration: number }>();
  for (const take of review.take_groups) {
    for (const angle of take.angles) {
      if (angle.playback.available === false) continue;
      reviewAngles.set(angle.clip_id, {
        groupId: take.group_id,
        camera: angle.camera,
        sourceStart: angle.source_start,
        sourceEnd: angle.source_end,
        duration: angle.duration,
      });
    }
  }

  return project.sources.flatMap((source) => {
    // TimelineProject is durable edit state; current Review is the media-playback
    // evidence. A source that was playable when the checkpoint was created must
    // not remain manually editable after the current Review marks it unavailable.
    const evidence = reviewAngles.get(source.clip_id);
    if (!evidence) return [];
    const availableIn = secondsToFrames(evidence.sourceStart, fps);
    if (source.duration_frames !== null && availableIn >= source.duration_frames) return [];
    const evidenceDuration = Math.max(1, secondsToFrames(
      evidence.sourceEnd !== null
        ? Math.max(0, evidence.sourceEnd - evidence.sourceStart)
        : Math.max(0, evidence.duration),
      fps,
    ));
    const sourceRemaining = source.duration_frames !== null
      ? Math.max(1, source.duration_frames - availableIn)
      : Math.max(1, Math.round(fps * 5));
    const availableDuration = source.duration_frames !== null
      ? Math.min(evidenceDuration, sourceRemaining)
      : positiveDuration(evidenceDuration, sourceRemaining);
    const multicam = project.multicam_groups.find((group) => group.angle_source_ids.includes(source.source_id)) ?? null;
    const groupId = evidence.groupId ?? multicam?.group_id ?? "";
    const camera = evidence.camera;
    const suffix = [groupId, camera].filter(Boolean).join(" · ");
    return [{
      source,
      groupId,
      camera,
      availableIn,
      availableDuration,
      multicamGroupId: multicam?.group_id ?? null,
      label: `${source.name || source.clip_id}${suffix ? ` · ${suffix}` : ""}`,
    }];
  });
}

export function validateManualSourceRange(
  option: TimelineSourceOption | null,
  sourceIn: number,
  duration: number,
): string | null {
  if (!option) return "请选择 Source";
  if (!Number.isSafeInteger(sourceIn) || sourceIn < 0) return "Source In 必须是非负整数帧";
  if (!Number.isSafeInteger(duration) || duration <= 0) return "Duration 必须是正整数帧";
  const availableEnd = option.availableIn + option.availableDuration;
  if (sourceIn < option.availableIn || sourceIn + duration > availableEnd) {
    return `范围必须位于可用 Source ${option.availableIn}f–${availableEnd}f 内`;
  }
  if (option.source.duration_frames !== null && sourceIn + duration > option.source.duration_frames) {
    return `范围超出媒体总长度 ${option.source.duration_frames}f`;
  }
  return null;
}

function targetVideoTrackId(sequence: TimelineSequence): string {
  return sequence.tracks.find((track) => track.kind === "video")?.track_id ?? "V1";
}

function manualClipId(
  mode: ManualSourceEditMode,
  snapshot: TimelineSnapshot,
  sourceId: string,
  playhead: number,
): string {
  return [
    "manual",
    mode,
    snapshot.authority.generation,
    String(snapshot.authority.revision + 1),
    String(playhead),
    encodeURIComponent(sourceId),
  ].join(":");
}

export function buildManualSourceCommand(
  mode: ManualSourceEditMode,
  snapshot: TimelineSnapshot,
  sequence: TimelineSequence,
  option: TimelineSourceOption,
  sourceIn: number,
  duration: number,
  playhead: number,
): TimelineCommand {
  const validation = validateManualSourceRange(option, sourceIn, duration);
  if (validation) throw new Error(validation);
  const timelineStart = Math.max(0, Math.round(playhead));
  const metadata: Record<string, string> = {
    edit_source: "human_source_monitor",
    edit_mode: mode,
    source_clip_id: option.source.clip_id,
    source_pool: "review_playable_media",
  };
  if (option.groupId) metadata.group_id = option.groupId;
  if (option.camera) metadata.camera = option.camera;

  return {
    type: mode,
    sequence_id: sequence.sequence_id,
    track_id: targetVideoTrackId(sequence),
    clip: {
      clip_id: manualClipId(mode, snapshot, option.source.source_id, timelineStart),
      source_id: option.source.source_id,
      timeline_start: timelineStart,
      source_in: sourceIn,
      duration,
      enabled: true,
      multicam_group_id: option.multicamGroupId,
      selected_angle_source_id: option.multicamGroupId ? option.source.source_id : null,
      metadata,
    },
  };
}

export function insertCutsExistingClip(sequence: TimelineSequence, playhead: number): boolean {
  const frame = Math.max(0, Math.round(playhead));
  return sequence.tracks
    .filter((track) => track.kind === "video")
    .some((track) => track.clips.some((clip) => clip.timeline_start < frame && frame < clip.timeline_start + clip.duration));
}
