import type {
  TimelineAuthority,
  TimelineMulticamGroup,
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
  const clips = track.clips
    .slice()
    .sort((a, b) => a.timeline_start - b.timeline_start || a.clip_id.localeCompare(b.clip_id));
  let previousEnd = 0;
  for (const clip of clips) {
    if (clip.timeline_start < previousEnd) {
      return issue("track_overlap", `${track.kind === "video" ? "视频" : "音频"}轨 ${track.track_id} 在 ${clip.clip_id} 附近存在重叠；当前 NLE IR 不会自动修复重叠关系。`);
    }
    previousEnd = clip.timeline_start + clip.duration;
  }
  return null;
}

function multicamSourceIds(group: TimelineMulticamGroup): string[] {
  const typed = group.angles ?? [];
  return typed.length ? typed.map((angle) => angle.source_id) : group.angle_source_ids;
}

function typedSyncIssue(group: TimelineMulticamGroup): DeliveryPreflightIssue | null {
  const typed = group.angles ?? [];
  if (!typed.length) {
    return issue("multicam_typed_sync_missing", `多机位组 ${group.group_id || "<empty>"} 仍只有 legacy angle_source_ids；交付需要 Timeline v2 typed sync。`);
  }
  for (const angle of typed) {
    const start = angle.sync_start_frame;
    const end = angle.sync_end_frame;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || Number(start) < 0 || Number(end) <= Number(start)) {
      return issue("multicam_typed_sync_incomplete", `多机位组 ${group.group_id || "<empty>"} 的 ${angle.camera || angle.source_id} 缺少完整 typed sync range。`);
    }
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

  if (snapshot.project.version !== 2) {
    blockers.push(issue("timeline_version", `当前 Timeline project version=${snapshot.project.version}；NLE 交付要求先由 Timeline Core normalize 到 v2。`));
  }

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
  const allVideoClips = videoTracks.flatMap((track) => track.clips);
  const enabledVideoClips = allVideoClips.filter((clip) => clip.enabled);
  const independentAudioClipCount = audioTracks.reduce((sum, track) => sum + track.clips.length, 0);

  if (videoTracks.length !== 1) {
    blockers.push(issue(
      "video_track_count",
      `当前 NLE adapters 需要且只支持 1 条非空视频轨；当前为 ${videoTracks.length} 条。`,
    ));
  }
  if (sequence.transitions.length > 0) {
    blockers.push(issue(
      "transitions_unsupported",
      `当前有 ${sequence.transitions.length} 个 transition；本轮 FCPXML / Premiere adapters 都明确 fail closed，不会静默丢弃。`,
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
    const sourceIds = multicamSourceIds(group);
    if (group.group_id && !groups.has(group.group_id)) groups.set(group.group_id, sourceIds);
    if (!sourceIds.length) {
      blockers.push(issue("multicam_group_empty", `多机位组 ${group.group_id || "<empty>"} 没有 angle source。`));
      continue;
    }
    const typedProblem = typedSyncIssue(group);
    if (typedProblem) blockers.push(typedProblem);
  }
  for (const groupId of duplicateGroups) {
    blockers.push(issue("multicam_group_duplicate", `多机位 group_id ${groupId} 无法唯一解析。`));
  }

  let pendingMulticamCount = 0;
  let selectedMulticamCount = 0;
  for (const clip of allVideoClips) {
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

  for (const track of audioTracks) {
    for (const clip of track.clips) {
      if (clip.multicam_group_id || clip.selected_angle_source_id) {
        blockers.push(issue(
          "audio_multicam_unsupported",
          `独立音频片段 ${clip.clip_id} 必须引用单一 source；当前 FCPXML / Premiere adapters 不支持在 A-track 上做 multicam switching。`,
        ));
      }
    }
  }

  for (const track of [...videoTracks, ...audioTracks]) {
    const overlap = overlapIssue(track);
    if (overlap) blockers.push(overlap);
  }

  if (independentAudioClipCount > 0) {
    warnings.push(issue(
      "independent_audio_preserved",
      `${independentAudioClipCount} 个独立 A-track 片段将由 NLE IR 保留；FCPXML 输出为 connected audio-only assets，Premiere 输出为独立 audio tracks。`,
    ));
  }
  if (selectedMulticamCount > 0) {
    warnings.push(issue(
      "multicam_preserved",
      `${selectedMulticamCount} 个多机位片段将保留 typed sync：Final Cut 输出 multicam container，Premiere 同时输出 edit sequence 与 multicam source sequence。`,
    ));
  }
  if (sequence.markers.length > 0) {
    warnings.push(issue(
      "premiere_markers_omitted",
      `${sequence.markers.length} 个 Timeline marker 会写入 Final Cut FCPXML；Premiere XMEML adapter 本轮仍不导出 marker。`,
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
