import type { ReviewModelPayload, ReviewTakeGroup } from "../../api/host";
import type { AssemblyBlock, AssemblyTimeline } from "../../api/production";
import type { FrameRate, TimelineCommand, TimelineMulticamGroup, TimelineProject, TimelineSource } from "../../api/timeline";
import { encodeMulticamSyncRanges, MULTICAM_SYNC_METADATA_KEY, type TimelineSyncRange } from "./timelineSync";

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
  return take.angles.filter((angle) => angle.playback.available !== false);
}

function baseAngleForBlock(take: ReviewTakeGroup, block: AssemblyBlock) {
  const playable = availableAngles(take);
  const authoritativeClipId = block.angle?.clip_id ?? "";
  if (authoritativeClipId) {
    return playable.find((angle) => angle.clip_id === authoritativeClipId) ?? null;
  }
  return playable[0] ?? null;
}

function syncMetadataForTake(take: ReviewTakeGroup, rate: FrameRate): string | null {
  const ranges: TimelineSyncRange[] = [];
  for (const angle of availableAngles(take)) {
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
  const playable = availableAngles(take);
  const angleSourceIds: string[] = [];
  for (const angle of playable) {
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
            : "Assembly Take 没有可播放 angle",
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

      const durationSeconds = range.end - range.start;
      const durationFrames = Math.max(1, secondsToFrames(durationSeconds, rate));
      const sourceInFrames = secondsToFrames(Number(baseAngle.source_start) + range.start, rate);
      const clipId = `timeline:${block.block_id}`;
      const playableAngleCount = availableAngles(take).length;
      const syncMetadata = playableAngleCount > 1 ? syncMetadataForTake(take, rate) : null;
      const metadata: Record<string, string> = {
        proposal_source: assembly.contract,
        proposal_revision: assembly.revision,
        assembly_block_id: block.block_id,
        segment_id: segmentId,
        script_segment_ids: JSON.stringify(block.script_segment_ids),
        group_id: block.group_id,
        source_clip_id: baseAngle.clip_id,
        decision_source: block.decision_source,
        trim_basis: range.trimBasis,
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
          multicam_group_id: playableAngleCount > 1 ? take.group_id : null,
          selected_angle_source_id: null,
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
    warnings.push(`${pendingMulticamAngles} 个多机位 Best 已进入 Timeline，但机位保持待选；请在 Timeline Inspector 明确选择机位后再交付。`);
  }
  if (commands.some((command) => command.type === "insert" && command.clip.multicam_group_id && !command.clip.metadata[MULTICAM_SYNC_METADATA_KEY])) {
    warnings.push("部分多机位 Take 缺少完整同步范围；片段仍可进入 Timeline，但同步证据不足时机位预览/切换会 fail closed。 ");
  }
  warnings.push(`Source pool 已从 Review inventory 注册 ${sources.size} 个可播放 angle；它只提供媒体证据，不参与 Best/范围决策。`);
  warnings.push(`时间基 ${rate.numerator}/${rate.denominator} fps；Assembly 秒级范围会在提交前量化到整数帧。`);

  const baseProject: TimelineProject = {
    version: 1,
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
