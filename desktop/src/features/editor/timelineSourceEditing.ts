import type { ReviewModelPayload } from "../../api/host";
import type {
  TimelineClip,
  TimelineCommand,
  TimelineProject,
  TimelineSequence,
  TimelineSource,
} from "../../api/timeline";
import { sequenceFps } from "./editorPlayback";
import { multicamSourceIds } from "./timelineSync";

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
    // not remain manually editable after current Review marks it unavailable.
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
    const multicam = project.multicam_groups.find((group) => multicamSourceIds(group).includes(source.source_id)) ?? null;
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

export function validateReplaceTakeRange(
  option: TimelineSourceOption | null,
  clip: TimelineClip | null,
  sourceIn: number,
): string | null {
  if (!clip) return "请选择 Timeline 片段";
  if (!option) return "请选择 replacement Source";
  if (!option.groupId) return "replacement Source 缺少 Take group 身份";
  return validateManualSourceRange(option, sourceIn, clip.duration);
}

export function buildReplaceTakeCommand(
  sequence: TimelineSequence,
  clip: TimelineClip,
  option: TimelineSourceOption,
  sourceIn: number,
): TimelineCommand {
  const validation = validateReplaceTakeRange(option, clip, sourceIn);
  if (validation) throw new Error(validation);
  return {
    type: "replace_take",
    sequence_id: sequence.sequence_id,
    clip_id: clip.clip_id,
    group_id: option.groupId,
    source_id: option.source.source_id,
    source_in: sourceIn,
  };
}
