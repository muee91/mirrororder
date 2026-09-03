import type { ReviewAngle, ReviewModelPayload, ReviewTakeGroup } from "../../api/host";
import type { RoughCutCandidate, RoughCutPlan, RoughCutSegmentPlan } from "../../api/production";
import type { FrameRate, TimelineCommand, TimelineMulticamGroup, TimelineProject, TimelineSource } from "../../api/timeline";
import { encodeMulticamSyncRanges, MULTICAM_SYNC_METADATA_KEY, type TimelineSyncRange } from "./timelineSync";

export interface TimelineSeedProposal {
  baseProject: TimelineProject;
  commands: TimelineCommand[];
  included: Array<{ segmentId: string; groupId: string; clipId: string; durationFrames: number; trimBasis: string }>;
  skipped: Array<{ segmentId: string; status: string; reason: string }>;
  warnings: string[];
}

export function normalizeFrameRate(rate: FrameRate): FrameRate {
  const numerator = Math.round(Number(rate.numerator));
  const denominator = Math.round(Number(rate.denominator));
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0) {
    throw new Error("Timeline proposal 需要明确、有效的有理数时间基");
  }
  return { numerator, denominator };
}

function framesPerSecond(rate: FrameRate): number {
  return rate.numerator / rate.denominator;
}

function secondsToFrames(seconds: number, rate: FrameRate): number {
  return Math.max(0, Math.round(seconds * framesPerSecond(rate)));
}

function sourceId(clipId: string): string {
  return `source:${clipId}`;
}

function candidateFor(segment: RoughCutSegmentPlan): RoughCutCandidate | null {
  return segment.candidates.find((candidate) => candidate.group_id === segment.primary_group_id) ?? null;
}

function takeFor(review: ReviewModelPayload, groupId: string): ReviewTakeGroup | null {
  return review.take_groups.find((take) => take.group_id === groupId) ?? null;
}

function baseAngleForTake(take: ReviewTakeGroup, candidate: RoughCutCandidate | null): ReviewAngle | null {
  const supervisor = candidate?.script_supervisor ?? {};
  const preferredClipId = typeof supervisor.preferred_clip_id === "string" ? supervisor.preferred_clip_id : "";
  if (preferredClipId) {
    const preferred = take.angles.find(
      (angle) => angle.clip_id === preferredClipId && angle.playback.available !== false,
    );
    if (preferred) return preferred;
  }
  return take.angles.find((angle) => angle.playback.available !== false) ?? null;
}

function usableRange(candidate: RoughCutCandidate | null, take: ReviewTakeGroup): { start: number; end: number } | null {
  const raw = candidate?.script_supervisor?.usable_range;
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const start = Number(value.start);
  const end = Number(value.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
  if (take.duration > 0 && end > take.duration + 0.001) return null;
  return { start, end };
}

function syncMetadataForTake(take: ReviewTakeGroup, rate: FrameRate): string | null {
  const ranges: TimelineSyncRange[] = [];
  for (const angle of take.angles.filter((value) => value.playback.available !== false)) {
    const start = Number(angle.source_start);
    const inferredEnd = angle.source_end !== null ? Number(angle.source_end) : start + Math.max(0, Number(angle.duration) || 0);
    if (!Number.isFinite(start) || !Number.isFinite(inferredEnd) || start < 0 || inferredEnd <= start) return null;
    const startFrame = secondsToFrames(start, rate);
    const endFrame = Math.max(startFrame + 1, secondsToFrames(inferredEnd, rate));
    ranges.push({ source_id: sourceId(angle.clip_id), start_frame: startFrame, end_frame: endFrame });
  }
  return encodeMulticamSyncRanges(ranges);
}

function ensureSources(
  take: ReviewTakeGroup,
  rate: FrameRate,
  sources: Map<string, TimelineSource>,
  multicam: Map<string, TimelineMulticamGroup>,
): void {
  const availableAngles = take.angles.filter((angle) => angle.playback.available !== false);
  const angleSourceIds: string[] = [];
  for (const angle of availableAngles) {
    const id = sourceId(angle.clip_id);
    angleSourceIds.push(id);
    if (!sources.has(id)) {
      sources.set(id, {
        source_id: id,
        clip_id: angle.clip_id,
        media_id: angle.media_id,
        name: angle.name,
        duration_frames: angle.source_end !== null
          ? secondsToFrames(Math.max(angle.source_end, angle.source_start + Math.max(angle.duration, 0)), rate)
          : null,
      });
    }
  }
  if (angleSourceIds.length > 1) {
    multicam.set(take.group_id, { group_id: take.group_id, angle_source_ids: angleSourceIds });
  }
}

export function buildRoughCutTimelineProposal(
  review: ReviewModelPayload,
  plan: RoughCutPlan,
  frameRate: FrameRate,
): TimelineSeedProposal {
  const rate = normalizeFrameRate(frameRate);
  const sources = new Map<string, TimelineSource>();
  const multicam = new Map<string, TimelineMulticamGroup>();
  const commands: TimelineCommand[] = [];
  const included: TimelineSeedProposal["included"] = [];
  const skipped: TimelineSeedProposal["skipped"] = [];
  const warnings: string[] = [];
  let cursor = 0;

  // The source pool is evidence/media availability, not an editorial decision.
  // Register every locally playable Review angle so a human editor can later
  // Insert/Overwrite an alternate Take explicitly. Only explicit Best rows below
  // are converted into automatic Timeline commands.
  for (const take of review.take_groups) {
    ensureSources(take, rate, sources, multicam);
  }

  for (const scene of plan.scenes) {
    for (const segment of scene.segments) {
      const segmentId = segment.script.segment_id;
      if (segment.selection_status !== "explicit_best" || !segment.primary_group_id) {
        skipped.push({
          segmentId,
          status: segment.selection_status,
          reason: "没有单一、显式的人工作品 Best，不自动进入 Timeline",
        });
        continue;
      }

      const take = takeFor(review, segment.primary_group_id);
      if (!take) {
        skipped.push({ segmentId, status: segment.selection_status, reason: `review.v1 缺少 Take ${segment.primary_group_id}` });
        continue;
      }
      const candidate = candidateFor(segment);
      // A multicam clip still needs a base source/time coordinate, but choosing
      // that coordinate is not an editorial camera decision. Script Supervisor
      // preference may supply a useful base; the Timeline selected angle remains
      // null until the editor explicitly switches it in Timeline Core.
      const baseAngle = baseAngleForTake(take, candidate);
      if (!baseAngle) {
        skipped.push({ segmentId, status: segment.selection_status, reason: "显式 Best 没有可用 angle" });
        continue;
      }

      const range = usableRange(candidate, take);
      const sourceOffset = range?.start ?? 0;
      const durationSeconds = range
        ? range.end - range.start
        : Math.max(0, baseAngle.source_end !== null ? baseAngle.source_end - baseAngle.source_start : take.duration || baseAngle.duration);
      const durationFrames = Math.max(1, secondsToFrames(durationSeconds, rate));
      const sourceInFrames = secondsToFrames(baseAngle.source_start + sourceOffset, rate);
      const clipId = `rough:${segmentId}:${take.group_id}`;
      const trimBasis = range ? "script_supervisor_usable_range" : "full_take_range";
      const availableAngleCount = take.angles.filter((item) => item.playback.available !== false).length;
      const syncMetadata = availableAngleCount > 1 ? syncMetadataForTake(take, rate) : null;
      const metadata: Record<string, string> = {
        proposal_source: plan.contract,
        proposal_revision: plan.revision,
        segment_id: segmentId,
        group_id: take.group_id,
        source_clip_id: baseAngle.clip_id,
        decision_source: candidate?.decision_source ?? "explicit_best",
        trim_basis: trimBasis,
        frame_rate: `${rate.numerator}/${rate.denominator}`,
      };
      if (syncMetadata) metadata[MULTICAM_SYNC_METADATA_KEY] = syncMetadata;

      commands.push({
        type: "insert",
        sequence_id: "main",
        track_id: "V1",
        clip: {
          clip_id: clipId,
          source_id: sourceId(baseAngle.clip_id),
          timeline_start: cursor,
          source_in: sourceInFrames,
          duration: durationFrames,
          enabled: true,
          multicam_group_id: availableAngleCount > 1 ? take.group_id : null,
          selected_angle_source_id: null,
          metadata,
        },
      });
      included.push({ segmentId, groupId: take.group_id, clipId, durationFrames, trimBasis });
      cursor += durationFrames;
    }
  }

  if (included.some((item) => item.trimBasis === "full_take_range")) {
    warnings.push("没有场记精确可用范围的段落按完整 Take 范围提议；确认后仍可继续精修。 ");
  }
  if (skipped.length) {
    warnings.push(`${skipped.length} 个剧本段因缺少单一显式 Best / 存在冲突而未进入时间线提议。`);
  }
  const pendingMulticamAngles = commands.filter(
    (command) => command.type === "insert" && Boolean(command.clip.multicam_group_id) && !command.clip.selected_angle_source_id,
  ).length;
  if (pendingMulticamAngles) {
    warnings.push(`${pendingMulticamAngles} 个多机位 Best 已进入 Timeline，但机位保持待选；请在 Timeline Inspector 明确选择机位后再交付。`);
  }
  if (commands.some((command) => command.type === "insert" && command.clip.multicam_group_id && !command.clip.metadata[MULTICAM_SYNC_METADATA_KEY])) {
    warnings.push("部分多机位 Take 缺少完整同步范围；片段仍可进入 Timeline，但同步证据不足时机位预览/切换会 fail closed。 ");
  }
  warnings.push(`Source pool 已注册 ${sources.size} 个可播放 angle；非 Best 素材只有人工 Insert/Overwrite 后才进入 Timeline。`);
  warnings.push(`时间基 ${rate.numerator}/${rate.denominator} fps；所有秒级范围会在提交前量化到整数帧。`);

  const baseProject: TimelineProject = {
    version: 1,
    project_id: review.project.project_id,
    sources: [...sources.values()],
    multicam_groups: [...multicam.values()],
    sequences: [
      {
        sequence_id: "main",
        name: "MirrorOrder Rough Cut",
        frame_rate: rate,
        tracks: [
          { track_id: "V1", kind: "video", clips: [] },
          { track_id: "A1", kind: "audio", clips: [] },
        ],
        markers: [],
        transitions: [],
      },
    ],
    active_sequence_id: "main",
  };

  return { baseProject, commands, included, skipped, warnings };
}
