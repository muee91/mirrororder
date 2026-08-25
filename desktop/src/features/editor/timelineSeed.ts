import type { ReviewAngle, ReviewModelPayload, ReviewTakeGroup } from "../../api/host";
import type { RoughCutCandidate, RoughCutPlan, RoughCutSegmentPlan } from "../../api/production";
import type { TimelineCommand, TimelineMulticamGroup, TimelineProject, TimelineSource } from "../../api/timeline";

export interface TimelineSeedProposal {
  baseProject: TimelineProject;
  commands: TimelineCommand[];
  included: Array<{ segmentId: string; groupId: string; clipId: string; durationFrames: number; trimBasis: string }>;
  skipped: Array<{ segmentId: string; status: string; reason: string }>;
  warnings: string[];
}

function secondsToFrames(seconds: number, fps: number): number {
  return Math.max(0, Math.round(seconds * fps));
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

function preferredAngle(take: ReviewTakeGroup, candidate: RoughCutCandidate | null): ReviewAngle | null {
  const supervisor = candidate?.script_supervisor ?? {};
  const preferredClipId = typeof supervisor.preferred_clip_id === "string" ? supervisor.preferred_clip_id : "";
  if (preferredClipId) {
    const preferred = take.angles.find((angle) => angle.clip_id === preferredClipId);
    if (preferred) return preferred;
  }
  return take.angles.find((angle) => angle.playback.available !== false) ?? take.angles[0] ?? null;
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

function ensureSources(
  take: ReviewTakeGroup,
  fps: number,
  sources: Map<string, TimelineSource>,
  multicam: Map<string, TimelineMulticamGroup>,
): void {
  const angleSourceIds: string[] = [];
  for (const angle of take.angles) {
    const id = sourceId(angle.clip_id);
    angleSourceIds.push(id);
    if (!sources.has(id)) {
      sources.set(id, {
        source_id: id,
        clip_id: angle.clip_id,
        media_id: angle.media_id,
        name: angle.name,
        duration_frames: angle.source_end !== null
          ? secondsToFrames(Math.max(angle.source_end, angle.source_start + Math.max(angle.duration, 0)), fps)
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
  fps = 24,
): TimelineSeedProposal {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("Timeline proposal fps 必须大于 0");
  const roundedFps = Math.max(1, Math.round(fps));
  const sources = new Map<string, TimelineSource>();
  const multicam = new Map<string, TimelineMulticamGroup>();
  const commands: TimelineCommand[] = [];
  const included: TimelineSeedProposal["included"] = [];
  const skipped: TimelineSeedProposal["skipped"] = [];
  const warnings: string[] = [];
  let cursor = 0;

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
      const angle = preferredAngle(take, candidate);
      if (!angle) {
        skipped.push({ segmentId, status: segment.selection_status, reason: "显式 Best 没有可用 angle" });
        continue;
      }

      ensureSources(take, roundedFps, sources, multicam);
      const range = usableRange(candidate, take);
      const sourceOffset = range?.start ?? 0;
      const durationSeconds = range
        ? range.end - range.start
        : Math.max(0, angle.source_end !== null ? angle.source_end - angle.source_start : take.duration || angle.duration);
      const durationFrames = Math.max(1, secondsToFrames(durationSeconds, roundedFps));
      const sourceInFrames = secondsToFrames(angle.source_start + sourceOffset, roundedFps);
      const clipId = `rough:${segmentId}:${take.group_id}`;
      const trimBasis = range ? "script_supervisor_usable_range" : "full_take_range";

      commands.push({
        type: "insert",
        sequence_id: "main",
        track_id: "V1",
        clip: {
          clip_id: clipId,
          source_id: sourceId(angle.clip_id),
          timeline_start: cursor,
          source_in: sourceInFrames,
          duration: durationFrames,
          enabled: true,
          multicam_group_id: take.angles.length > 1 ? take.group_id : null,
          selected_angle_source_id: take.angles.length > 1 ? sourceId(angle.clip_id) : null,
          metadata: {
            proposal_source: plan.contract,
            proposal_revision: plan.revision,
            segment_id: segmentId,
            group_id: take.group_id,
            source_clip_id: angle.clip_id,
            decision_source: candidate?.decision_source ?? "explicit_best",
            trim_basis: trimBasis,
          },
        },
      });
      included.push({ segmentId, groupId: take.group_id, clipId, durationFrames, trimBasis });
      cursor += durationFrames;
    }
  }

  if (included.some((item) => item.trimBasis === "full_take_range")) {
    warnings.push("没有场记精确可用范围的段落按完整 Take 范围提议；确认后仍可用 Trim 命令精修。 ");
  }
  if (skipped.length) {
    warnings.push(`${skipped.length} 个剧本段因缺少单一显式 Best / 存在冲突而未进入 Timeline proposal。`);
  }
  warnings.push(`Phase 4 proposal 当前使用 ${roundedFps}/1 fps 整数 frame 时间基；后续平台媒体适配器可替换为项目原生 timebase。`);

  const baseProject: TimelineProject = {
    version: 1,
    project_id: review.project.project_id,
    sources: [...sources.values()],
    multicam_groups: [...multicam.values()],
    sequences: [
      {
        sequence_id: "main",
        name: "MirrorOrder Rough Cut",
        frame_rate: { numerator: roundedFps, denominator: 1 },
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
