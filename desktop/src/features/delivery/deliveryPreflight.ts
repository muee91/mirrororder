import type {
  TimelineAuthority,
  TimelineSequence,
  TimelineSnapshot,
  TimelineTrack,
} from "../../api/timeline";

export interface DeliveryPreflightIssue {
  code: string;
  message: string;
}

export interface TimelineDeliveryPreflight {
  blockers: DeliveryPreflightIssue[];
  warnings: DeliveryPreflightIssue[];
  sequenceId: string | null;
  enabledVideoClipCount: number;
  independentAudioClipCount: number;
  pendingMulticamCount: number;
  selectedMulticamCount: number;
  transitionCount: number;
  markerCount: number;
}

function issue(code: string, message: string): DeliveryPreflightIssue {
  return { code, message };
}

function activeSequence(snapshot: TimelineSnapshot): TimelineSequence | null {
  const sequences = snapshot.project.sequences;
  const active = sequences.find((item) => item.sequence_id === snapshot.project.active_sequence_id);
  if (active) return active;
  return sequences.length === 1 ? sequences[0] : null;
}

function nonEmptyTracks(sequence: TimelineSequence, kind: TimelineTrack["kind"]): TimelineTrack[] {
  return sequence.tracks.filter((track) => track.kind === kind && track.clips.length > 0);
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function overlapIssue(track: TimelineTrack): DeliveryPreflightIssue | null {
  const enabled = track.clips
    .filter((clip) => clip.enabled)
    .slice()
    .sort((a, b) => a.timeline_start - b.timeline_start || a.clip_id.localeCompare(b.clip_id));
  let previousEnd = 0;
  for (const clip of enabled) {
    if (clip.timeline_start < previousEnd) {
      return issue("video_overlap", `视频片段 ${clip.clip_id} 与前一片段重叠；timeline_delivery.v1 不会自动改写重叠关系。`);
    }
    previousEnd = clip.timeline_start + clip.duration;
  }
  return null;
}

export function sameTimelineAuthority(
  current: TimelineAuthority | null | undefined,
  delivered: TimelineAuthority | null | undefined,
): boolean {
  return Boolean(
    current?.generation
      && delivered?.generation
      && current.generation === delivered.generation
      && current.revision === delivered.revision,
  );
}

export function buildTimelineDeliveryPreflight(snapshot: TimelineSnapshot): TimelineDeliveryPreflight {
  const blockers: DeliveryPreflightIssue[] = snapshot.validation.map((validation) => issue(
    "timeline_validation",
    `Timeline Core：${validation.message}${validation.path ? ` · ${validation.path}` : ""}`,
  ));
  const warnings: DeliveryPreflightIssue[] = [];
  const sequence = activeSequence(snapshot);

  if (!sequence) {
    blockers.push(issue(
      "active_sequence_unresolved",
      snapshot.project.sequences.length
        ? "当前 active_sequence_id 无法唯一解析；先回到 Timeline 确认活动序列。"
        : "当前 Timeline 没有 sequence，无法交付。",
    ));
    return {
      blockers,
      warnings,
      sequenceId: null,
      enabledVideoClipCount: 0,
      independentAudioClipCount: 0,
      pendingMulticamCount: 0,
      selectedMulticamCount: 0,
      transitionCount: 0,
      markerCount: 0,
    };
  }

  if (!isPositiveInteger(sequence.frame_rate.numerator) || !isPositiveInteger(sequence.frame_rate.denominator)) {
    blockers.push(issue("invalid_frame_rate", "当前 Timeline 时间基无效；交付需要明确的正整数有理数帧率。"));
  }

  const videoTracks = nonEmptyTracks(sequence, "video");
  const audioTracks = nonEmptyTracks(sequence, "audio");
  const enabledVideoClips = videoTracks.flatMap((track) => track.clips.filter((clip) => clip.enabled));
  const independentAudioClipCount = audioTracks.reduce((sum, track) => sum + track.clips.length, 0);

  if (videoTracks.length !== 1) {
    blockers.push(issue(
      "video_track_count",
      `timeline_delivery.v1 需要且只支持 1 条非空视频轨；当前为 ${videoTracks.length} 条。`,
    ));
  }
  if (independentAudioClipCount > 0) {
    blockers.push(issue(
      "independent_audio_unsupported",
      `当前有 ${independentAudioClipCount} 个独立 A-track 片段；timeline_delivery.v1 目前只安全保留视频 asset 自带音频。`,
    ));
  }
  if (sequence.transitions.length > 0) {
    blockers.push(issue(
      "transitions_unsupported",
      `当前有 ${sequence.transitions.length} 个 transition；timeline_delivery.v1 目前不会静默丢弃 transition。`,
    ));
  }
  if (enabledVideoClips.length === 0) {
    blockers.push(issue("no_enabled_video", "当前 Timeline 没有启用的视频片段，不能生成空的最终剪辑。"));
  }

  const sources = new Map<string, number>();
  for (const source of snapshot.project.sources) {
    sources.set(source.source_id, (sources.get(source.source_id) ?? 0) + 1);
  }
  for (const [sourceId, count] of sources) {
    if (!sourceId || count > 1) {
      blockers.push(issue(
        "source_identity_invalid",
        sourceId ? `Timeline source_id ${sourceId} 重复，交付无法唯一解析素材。` : "Timeline 存在空 source_id，交付无法解析素材。",
      ));
    }
  }

  const groups = new Map<string, string[]>();
  const duplicateGroups = new Set<string>();
  for (const group of snapshot.project.multicam_groups) {
    if (!group.group_id || groups.has(group.group_id)) duplicateGroups.add(group.group_id || "<empty>");
    else groups.set(group.group_id, group.angle_source_ids);
    if (!group.angle_source_ids.length) {
      blockers.push(issue("multicam_group_empty", `多机位组 ${group.group_id || "<empty>"} 没有 angle source。`));
    }
  }
  for (const groupId of duplicateGroups) {
    blockers.push(issue("multicam_group_duplicate", `多机位 group_id ${groupId} 无法唯一解析。`));
  }

  let pendingMulticamCount = 0;
  let selectedMulticamCount = 0;
  for (const clip of enabledVideoClips) {
    if (!sources.has(clip.source_id)) {
      blockers.push(issue("base_source_missing", `视频片段 ${clip.clip_id} 引用了不存在的 base source ${clip.source_id}。`));
    }
    if (clip.multicam_group_id) {
      const angleSourceIds = groups.get(clip.multicam_group_id);
      if (!angleSourceIds) {
        blockers.push(issue("multicam_group_missing", `视频片段 ${clip.clip_id} 引用了不存在的多机位组 ${clip.multicam_group_id}。`));
        continue;
      }
      if (!clip.selected_angle_source_id) {
        pendingMulticamCount += 1;
        blockers.push(issue("multicam_angle_pending", `多机位片段 ${clip.clip_id} 还没有明确选择 A/B/C 机位。`));
        continue;
      }
      selectedMulticamCount += 1;
      if (!angleSourceIds.includes(clip.selected_angle_source_id)) {
        blockers.push(issue("multicam_angle_outside_group", `片段 ${clip.clip_id} 的当前机位不属于多机位组 ${clip.multicam_group_id}。`));
      }
      if (!sources.has(clip.selected_angle_source_id)) {
        blockers.push(issue("active_source_missing", `片段 ${clip.clip_id} 的当前机位 source ${clip.selected_angle_source_id} 不存在。`));
      }
    } else if (clip.selected_angle_source_id) {
      blockers.push(issue("selected_angle_without_group", `片段 ${clip.clip_id} 有机位选择但没有 multicam group。`));
    }
  }

  if (videoTracks.length === 1) {
    const overlap = overlapIssue(videoTracks[0]);
    if (overlap) blockers.push(overlap);
  }

  if (selectedMulticamCount > 0) {
    warnings.push(issue(
      "multicam_flattened",
      `${selectedMulticamCount} 个已选机位的多机位片段会按当前角度 flatten 为普通 asset-clip；不会保留 multicam container。`,
    ));
  }
  if (sequence.markers.length > 0) {
    warnings.push(issue(
      "markers_omitted",
      `${sequence.markers.length} 个 Timeline marker 当前不属于 timeline_delivery.v1 authority，将不会写入最终 FCPXML。`,
    ));
  }

  return {
    blockers,
    warnings,
    sequenceId: sequence.sequence_id,
    enabledVideoClipCount: enabledVideoClips.length,
    independentAudioClipCount,
    pendingMulticamCount,
    selectedMulticamCount,
    transitionCount: sequence.transitions.length,
    markerCount: sequence.markers.length,
  };
}
