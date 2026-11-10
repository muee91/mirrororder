import type { ReviewModelPayload, ReviewTakeGroup } from "../../api/host";
import type { AssemblyBlock, AssemblyTimeline } from "../../api/production";
import { canPreviewReviewPlayback } from "../media/mediaPlaybackProjection";
import { multicamClipRangeIssue } from "./timelineSync";
import type {
  FrameRate,
  TimelineCommand,
  TimelineMulticamAngle,
  TimelineMulticamGroup,
  TimelineProject,
  TimelineSource,
} from "../../api/timeline";

export interface TimelineSeedProposal {
  baseProject: TimelineProject;
  commands: TimelineCommand[];
  included: Array<{
    blockId: string;
    segmentId: string;
    segmentIds: string[];
    groupId: string;
    clipId: string;
    durationFrames: number;
    trimBasis: string;
  }>;
  skipped: Array<{ blockId: string; segmentId: string; status: string; reason: string }>;
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

function takeFor(review: ReviewModelPayload, groupId: string): ReviewTakeGroup | null {
  return review.take_groups.find((take) => take.group_id === groupId) ?? null;
}

function availableAngles(take: ReviewTakeGroup) {
  return take.angles.filter((angle) => canPreviewReviewPlayback(angle.playback));
}

function baseAngleForBlock(take: ReviewTakeGroup, block: AssemblyBlock) {
  const playable = availableAngles(take);
  const authoritativeClipId = block.angle?.clip_id ?? "";
  if (authoritativeClipId) {
    return playable.find((angle) => angle.clip_id === authoritativeClipId) ?? null;
  }
  if (block.angle?.status === "manual_preferred" || block.angle?.status === "single_angle") return null;
  return playable[0] ?? null;
}

function typedAngleForTake(angle: ReturnType<typeof availableAngles>[number], rate: FrameRate): TimelineMulticamAngle | null {
  const start = Number(angle.source_start);
  const inferredEnd = angle.source_end !== null
    ? Number(angle.source_end)
    : start + Math.max(0, Number(angle.duration) || 0);
  if (!Number.isFinite(start) || !Number.isFinite(inferredEnd) || start < 0 || inferredEnd <= start) return null;
  const startFrame = secondsToFrames(start, rate);
  const endFrame = Math.max(startFrame + 1, secondsToFrames(inferredEnd, rate));
  return {
    source_id: sourceId(angle.clip_id),
    camera: angle.camera,
    name: angle.name,
    sync_start_frame: startFrame,
    sync_end_frame: endFrame,
  };
}

function ensureSources(
  take: ReviewTakeGroup,
  rate: FrameRate,
  sources: Map<string, TimelineSource>,
  multicam: Map<string, TimelineMulticamGroup>,
): void {
  const playable = availableAngles(take);
  const angleSourceIds: string[] = [];
  const typedAngles: TimelineMulticamAngle[] = [];
  // Typed sync currently models a shared Take origin. Do not claim that angles
  // with different (or unknown) timeline origins are aligned by source offset.
  let completeTypedSync = Number.isFinite(take.start)
    && playable.every((angle) => Number.isFinite(angle.timeline_start) && angle.timeline_start === take.start);
  for (const angle of playable) {
    const id = sourceId(angle.clip_id);
    angleSourceIds.push(id);
    const typedAngle = typedAngleForTake(angle, rate);
    if (typedAngle) typedAngles.push(typedAngle);
    else completeTypedSync = false;
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
    multicam.set(take.group_id, {
      group_id: take.group_id,
      // Keep the v1 projection until Timeline Delivery v2 consumes typed angles.
      angle_source_ids: angleSourceIds,
      angles: completeTypedSync && typedAngles.length === angleSourceIds.length ? typedAngles : [],
      reference_source_id: angleSourceIds[0] ?? null,
      audio_source_id: null,
    });
  }
}

function blockRange(block: AssemblyBlock): { start: number; end: number; trimBasis: string } | null {
  if (block.kind !== "source" || block.assembly_status === "blocked") return null;
  const start = Number(block.usable_range?.start);
  const end = Number(block.usable_range?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null;
  const status = block.usable_range?.status ?? "full_take";
  const trimBasis = status === "manual"
    ? "script_supervisor_usable_range"
    : status === "pending"
      ? "script_supervisor_partial_pending"
      : "full_take_range";
  return { start, end, trimBasis };
}

function firstSegmentId(block: AssemblyBlock): string {
  return block.script_segment_ids[0] ?? "";
}

function hasCompleteTypedSync(group: TimelineMulticamGroup): boolean {
  if (!group.angles || group.angles.length < 2) return false;
  return group.angles.every((angle) => Number.isSafeInteger(angle.sync_start_frame)
    && Number.isSafeInteger(angle.sync_end_frame)
    && Number(angle.sync_start_frame) >= 0
    && Number(angle.sync_end_frame) > Number(angle.sync_start_frame));
}

export function buildAssemblyTimelineProposal(
  review: ReviewModelPayload,
  assembly: AssemblyTimeline,
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

  // Review supplies device/playback source inventory only. Editorial inclusion,
  // Take identity, ordering and usable ranges come exclusively from Assembly v2.
  for (const take of review.take_groups) {
    ensureSources(take, rate, sources, multicam);
  }

  for (const scene of assembly.scenes) {
    for (const block of scene.blocks) {
      const segmentId = firstSegmentId(block);
      if (block.kind !== "source" || !block.group_id) {
        skipped.push({
          blockId: block.block_id,
          segmentId,
          status: block.selection_status,
          reason: "Assembly 未解析为单一显式 Best，保持人工待决",
        });
        continue;
      }

      const take = takeFor(review, block.group_id);
      if (!take) {
        skipped.push({
          blockId: block.block_id,
          segmentId,
          status: block.assembly_status,
          reason: `Review source inventory 缺少 Take ${block.group_id}`,
        });
        continue;
      }

      const baseAngle = baseAngleForBlock(take, block);
      if (!baseAngle) {
        skipped.push({
          blockId: block.block_id,
          segmentId,
          status: block.assembly_status,
          reason: block.angle?.clip_id
            ? `Assembly 指定的基础 angle ${block.angle.clip_id} 当前不可播放`
            : block.angle?.status === "manual_preferred" || block.angle?.status === "single_angle"
              ? "Assembly 已确定的机位缺少 source identity，不能自动改选"
              : "Assembly Take 没有可播放 angle",
        });
        continue;
      }

      if (!Number.isFinite(take.start) || !Number.isFinite(baseAngle.timeline_start) || baseAngle.timeline_start !== take.start) {
        skipped.push({ blockId: block.block_id, segmentId, status: block.assembly_status, reason: "Assembly 基础机位与 Take 起点不一致或未知，不能推断源范围" });
        continue;
      }

      const multicamGroup = multicam.get(take.group_id);
      // Local availability must not turn an unresolved editorial choice into a
      // single-source clip that bypasses the multicam playback/delivery gates.
      if (!multicamGroup && block.angle?.status !== "manual_preferred" && block.angle?.status !== "single_angle") {
        skipped.push({
          blockId: block.block_id,
          segmentId,
          status: block.assembly_status,
          reason: "Assembly 机位仍待定；本机仅有一个可播放 angle，不能自动作为单机位采用",
        });
        continue;
      }

      const range = blockRange(block);
      if (!range) {
        skipped.push({
          blockId: block.block_id,
          segmentId,
          status: block.assembly_status,
          reason: "Assembly 可用范围无效或被阻塞",
        });
        continue;
      }

      const sourceInFrames = secondsToFrames(Number(baseAngle.source_start) + range.start, rate);
      const sourceOutFrames = secondsToFrames(Number(baseAngle.source_start) + range.end, rate);
      const durationFrames = sourceOutFrames - sourceInFrames;
      if (!Number.isSafeInteger(sourceInFrames) || !Number.isSafeInteger(durationFrames) || durationFrames <= 0) {
        skipped.push({ blockId: block.block_id, segmentId, status: block.assembly_status, reason: "Assembly 范围无法在当前时间基表示为有效整帧，不能自动扩展范围" });
        continue;
      }
      const clipId = `timeline:${block.block_id}`;
      // This remains a proposal until the user confirms it. Carry only the
      // explicit Assembly preference, never the inventory's first angle or a
      // merely populated clip_id. Incomplete synchronization stays fail closed.
      const selectedAngleSourceId = multicamGroup
        && block.angle?.status === "manual_preferred"
        && hasCompleteTypedSync(multicamGroup)
        && !multicamClipRangeIssue(multicamGroup, { source_id: sourceId(baseAngle.clip_id), source_in: sourceInFrames, duration: durationFrames })
        ? sourceId(baseAngle.clip_id)
        : null;
      const metadata: Record<string, string> = {
        proposal_source: assembly.contract,
        proposal_revision: assembly.revision,
        assembly_block_id: block.block_id,
        segment_id: segmentId,
        script_segment_ids: JSON.stringify(block.script_segment_ids),
        group_id: block.group_id,
        source_clip_id: baseAngle.clip_id,
        decision_source: block.decision_source,
        angle_selection_status: block.angle?.status ?? "unknown",
        trim_basis: range.trimBasis,
        frame_rate: `${rate.numerator}/${rate.denominator}`,
      };

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
          multicam_group_id: multicamGroup?.group_id ?? null,
          selected_angle_source_id: selectedAngleSourceId,
          metadata,
        },
      });
      included.push({
        blockId: block.block_id,
        segmentId,
        segmentIds: [...block.script_segment_ids],
        groupId: take.group_id,
        clipId,
        durationFrames,
        trimBasis: range.trimBasis,
      });
      cursor += durationFrames;
    }
  }

  if (included.some((item) => item.trimBasis === "script_supervisor_partial_pending")) {
    warnings.push("部分 Best 仍缺场记精确可用范围；Assembly 明确保留完整 Take 范围，提交前请人工确认。 ");
  }
  if (included.some((item) => item.trimBasis === "full_take_range")) {
    warnings.push("没有场记精确可用范围的段落按 Assembly 的完整 Take 范围提议；确认后仍可继续精修。 ");
  }
  if (skipped.length) {
    warnings.push(`${skipped.length} 个 Assembly block 因待决、缺媒体或范围阻塞而未进入时间线提议。`);
  }
  const pendingMulticamAngles = commands.filter(
    (command) => command.type === "insert" && Boolean(command.clip.multicam_group_id) && !command.clip.selected_angle_source_id,
  ).length;
  if (pendingMulticamAngles) {
    warnings.push(`${pendingMulticamAngles} 个多机位 Best 的机位保持待选；请核对同步范围，并在 Timeline Inspector 明确选择机位后再交付。`);
  }
  const preferredMulticamAngles = commands.filter(
    (command) => command.type === "insert" && Boolean(command.clip.selected_angle_source_id),
  ).length;
  if (preferredMulticamAngles) {
    warnings.push(`${preferredMulticamAngles} 个多机位片段沿用场记人工首选机位；确认初始顺片后生效。`);
  }
  if ([...multicam.values()].some((group) => !hasCompleteTypedSync(group))) {
    warnings.push("部分多机位 Take 缺少完整同步范围，或机位起点不一致；片段仍可进入 Timeline，但机位预览/切换会 fail closed。 ");
  }
  warnings.push(`Source pool 已从 Review inventory 注册 ${sources.size} 个可播放 angle；它只提供媒体证据，不参与 Best/范围决策。`);
  warnings.push(`时间基 ${rate.numerator}/${rate.denominator} fps；Assembly 秒级范围会在提交前量化到整数帧。`);

  const baseProject: TimelineProject = {
    version: 2,
    project_id: review.project.project_id,
    sources: [...sources.values()],
    multicam_groups: [...multicam.values()],
    sequences: [
      {
        sequence_id: "main",
        name: "MirrorOrder Assembly",
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
