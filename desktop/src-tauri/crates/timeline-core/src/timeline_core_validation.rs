pub fn validate_project(project: &TimelineProject) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();
    if project.version != TIMELINE_PROJECT_VERSION {
        issues.push(ValidationIssue::new(
            "unsupported_version",
            "version",
            format!("Timeline project version {} 不受支持", project.version),
        ));
    }
    if project.project_id.trim().is_empty() {
        issues.push(ValidationIssue::new("missing_project_id", "project_id", "project_id 不能为空"));
    }

    let mut source_ids = HashSet::new();
    let mut sources: HashMap<&str, &Source> = HashMap::new();
    for (index, source) in project.sources.iter().enumerate() {
        let path = format!("sources[{index}]");
        if source.source_id.trim().is_empty() {
            issues.push(ValidationIssue::new("missing_source_id", &path, "source_id 不能为空"));
            continue;
        }
        if !source_ids.insert(source.source_id.as_str()) {
            issues.push(ValidationIssue::new(
                "duplicate_source_id",
                &path,
                format!("重复 source_id：{}", source.source_id),
            ));
        }
        if matches!(source.duration_frames, Some(value) if value <= 0) {
            issues.push(ValidationIssue::new(
                "invalid_source_duration",
                &path,
                "source duration_frames 必须大于 0",
            ));
        }
        sources.insert(source.source_id.as_str(), source);
    }

    let mut multicam_ids = HashSet::new();
    let mut multicams: HashMap<&str, &MulticamGroup> = HashMap::new();
    for (index, group) in project.multicam_groups.iter().enumerate() {
        let path = format!("multicam_groups[{index}]");
        if group.group_id.trim().is_empty() {
            issues.push(ValidationIssue::new("missing_multicam_id", &path, "multicam group_id 不能为空"));
            continue;
        }
        if !multicam_ids.insert(group.group_id.as_str()) {
            issues.push(ValidationIssue::new(
                "duplicate_multicam_id",
                &path,
                format!("重复 multicam group_id：{}", group.group_id),
            ));
        }
        let source_ids_for_group = group.source_ids();
        let mut angle_ids = HashSet::new();
        for source_id in &source_ids_for_group {
            if !sources.contains_key(*source_id) {
                issues.push(ValidationIssue::new(
                    "unknown_multicam_source",
                    &path,
                    format!("Multicam angle source 不存在：{source_id}"),
                ));
            }
            if !angle_ids.insert(*source_id) {
                issues.push(ValidationIssue::new(
                    "duplicate_multicam_angle",
                    &path,
                    format!("Multicam angle 重复：{source_id}"),
                ));
            }
        }
        for (angle_index, angle) in group.angles.iter().enumerate() {
            let angle_path = format!("{path}.angles[{angle_index}]");
            match (angle.sync_start_frame, angle.sync_end_frame) {
                (None, None) => {}
                (Some(start), Some(end)) if start >= 0 && end > start => {
                    if let Some(source) = sources.get(angle.source_id.as_str()) {
                        if let Some(duration_frames) = source.duration_frames {
                            if end > duration_frames {
                                issues.push(ValidationIssue::new(
                                    "multicam_sync_range_exceeded",
                                    &angle_path,
                                    format!("sync range 超出 source {} 长度", angle.source_id),
                                ));
                            }
                        }
                    }
                }
                _ => issues.push(ValidationIssue::new(
                    "invalid_multicam_sync_range",
                    &angle_path,
                    "sync_start_frame/sync_end_frame 必须同时为空，或满足 0 <= start < end",
                )),
            }
        }
        if let Some(reference_source_id) = group.reference_source_id.as_deref() {
            if !group.contains_source(reference_source_id) {
                issues.push(ValidationIssue::new(
                    "invalid_multicam_reference_source",
                    &path,
                    format!("reference source 不属于 multicam group：{reference_source_id}"),
                ));
            }
        }
        if let Some(audio_source_id) = group.audio_source_id.as_deref() {
            if !sources.contains_key(audio_source_id) {
                issues.push(ValidationIssue::new(
                    "unknown_multicam_audio_source",
                    &path,
                    format!("multicam audio source 不存在：{audio_source_id}"),
                ));
            }
        }
        multicams.insert(group.group_id.as_str(), group);
    }

    let mut sequence_ids = HashSet::new();
    let mut global_clip_ids = HashSet::new();
    for (sequence_index, sequence) in project.sequences.iter().enumerate() {
        let sequence_path = format!("sequences[{sequence_index}]");
        if sequence.sequence_id.trim().is_empty() {
            issues.push(ValidationIssue::new("missing_sequence_id", &sequence_path, "sequence_id 不能为空"));
        } else if !sequence_ids.insert(sequence.sequence_id.as_str()) {
            issues.push(ValidationIssue::new(
                "duplicate_sequence_id",
                &sequence_path,
                format!("重复 sequence_id：{}", sequence.sequence_id),
            ));
        }
        if sequence.frame_rate.numerator == 0 || sequence.frame_rate.denominator == 0 {
            issues.push(ValidationIssue::new(
                "invalid_frame_rate",
                format!("{sequence_path}.frame_rate"),
                "frame_rate numerator/denominator 必须大于 0",
            ));
        }

        let mut track_ids = HashSet::new();
        let mut clip_track: HashMap<&str, &str> = HashMap::new();
        for (track_index, track) in sequence.tracks.iter().enumerate() {
            let track_path = format!("{sequence_path}.tracks[{track_index}]");
            if track.track_id.trim().is_empty() {
                issues.push(ValidationIssue::new("missing_track_id", &track_path, "track_id 不能为空"));
            } else if !track_ids.insert(track.track_id.as_str()) {
                issues.push(ValidationIssue::new(
                    "duplicate_track_id",
                    &track_path,
                    format!("重复 track_id：{}", track.track_id),
                ));
            }

            let mut ordered = track.clips.iter().collect::<Vec<_>>();
            ordered.sort_by_key(|clip| (clip.timeline_start, clip.clip_id.as_str()));
            let mut previous_end: Option<i64> = None;
            for clip in ordered {
                let clip_path = format!("{track_path}.clips[{}]", clip.clip_id);
                if clip.clip_id.trim().is_empty() {
                    issues.push(ValidationIssue::new("missing_clip_id", &clip_path, "clip_id 不能为空"));
                } else if !global_clip_ids.insert(clip.clip_id.as_str()) {
                    issues.push(ValidationIssue::new(
                        "duplicate_clip_id",
                        &clip_path,
                        format!("重复 Timeline clip_id：{}", clip.clip_id),
                    ));
                }
                clip_track.insert(clip.clip_id.as_str(), track.track_id.as_str());
                if clip.timeline_start < 0 || clip.source_in < 0 || clip.duration <= 0 {
                    issues.push(ValidationIssue::new(
                        "invalid_clip_range",
                        &clip_path,
                        "clip 必须满足 timeline_start/source_in >= 0 且 duration > 0",
                    ));
                }
                if let Some(end) = previous_end {
                    if clip.timeline_start < end {
                        issues.push(ValidationIssue::new(
                            "track_overlap",
                            &clip_path,
                            format!("Track {} 存在重叠 clip", track.track_id),
                        ));
                    }
                }
                previous_end = Some(previous_end.map_or(clip.timeline_end(), |end| end.max(clip.timeline_end())));

                match sources.get(clip.source_id.as_str()) {
                    None => issues.push(ValidationIssue::new(
                        "unknown_source",
                        &clip_path,
                        format!("clip source 不存在：{}", clip.source_id),
                    )),
                    Some(source) => {
                        if let Some(source_duration) = source.duration_frames {
                            if clip.source_in.saturating_add(clip.duration) > source_duration {
                                issues.push(ValidationIssue::new(
                                    "source_range_exceeded",
                                    &clip_path,
                                    format!("clip 超出 source {} 可用范围", source.source_id),
                                ));
                            }
                        }
                    }
                }

                if let Some(group_id) = clip.multicam_group_id.as_deref() {
                    match multicams.get(group_id) {
                        None => issues.push(ValidationIssue::new(
                            "unknown_multicam_group",
                            &clip_path,
                            format!("multicam group 不存在：{group_id}"),
                        )),
                        Some(group) => {
                            if !group.contains_source(&clip.source_id) {
                                issues.push(ValidationIssue::new(
                                    "base_source_outside_multicam_group",
                                    &clip_path,
                                    format!("base source {} 不属于 multicam group {group_id}", clip.source_id),
                                ));
                            }
                            if let Some(source_id) = clip.selected_angle_source_id.as_deref() {
                                if !group.contains_source(source_id) {
                                    issues.push(ValidationIssue::new(
                                        "invalid_multicam_angle",
                                        &clip_path,
                                        format!("source {source_id} 不属于 multicam group {group_id}"),
                                    ));
                                }
                            }
                        }
                    }
                } else if clip.selected_angle_source_id.is_some() {
                    issues.push(ValidationIssue::new(
                        "multicam_angle_without_group",
                        &clip_path,
                        "selected_angle_source_id 需要 multicam_group_id",
                    ));
                }
            }
        }

        let mut marker_ids = HashSet::new();
        for marker in &sequence.markers {
            if marker.marker_id.trim().is_empty() || marker.position < 0 || marker.duration < 0 {
                issues.push(ValidationIssue::new(
                    "invalid_marker",
                    format!("{sequence_path}.markers"),
                    "marker_id 不能为空且 position/duration 不能为负数",
                ));
            }
            if marker.kind.trim().is_empty() {
                issues.push(ValidationIssue::new(
                    "invalid_marker_kind",
                    format!("{sequence_path}.markers"),
                    "marker kind 不能为空",
                ));
            }
            if !marker_ids.insert(marker.marker_id.as_str()) {
                issues.push(ValidationIssue::new(
                    "duplicate_marker_id",
                    format!("{sequence_path}.markers"),
                    format!("重复 marker_id：{}", marker.marker_id),
                ));
            }
        }

        let mut transition_ids = HashSet::new();
        for transition in &sequence.transitions {
            let path = format!("{sequence_path}.transitions[{}]", transition.transition_id);
            if transition.transition_id.trim().is_empty() || transition.duration <= 0 {
                issues.push(ValidationIssue::new(
                    "invalid_transition",
                    &path,
                    "transition_id 不能为空且 duration 必须大于 0",
                ));
            }
            if !transition_ids.insert(transition.transition_id.as_str()) {
                issues.push(ValidationIssue::new(
                    "duplicate_transition_id",
                    &path,
                    format!("重复 transition_id：{}", transition.transition_id),
                ));
            }
            if !track_ids.contains(transition.track_id.as_str()) {
                issues.push(ValidationIssue::new(
                    "unknown_transition_track",
                    &path,
                    format!("transition track 不存在：{}", transition.track_id),
                ));
            }
            let left_track = clip_track.get(transition.left_clip_id.as_str());
            let right_track = clip_track.get(transition.right_clip_id.as_str());
            if left_track.is_none() || right_track.is_none() {
                issues.push(ValidationIssue::new(
                    "unknown_transition_clip",
                    &path,
                    "transition 引用的 clip 不存在",
                ));
            } else if left_track != right_track || left_track.copied() != Some(transition.track_id.as_str()) {
                issues.push(ValidationIssue::new(
                    "transition_track_mismatch",
                    &path,
                    "transition 两端 clip 必须位于声明的同一 track",
                ));
            }
        }
    }

    if !project.active_sequence_id.trim().is_empty()
        && !sequence_ids.contains(project.active_sequence_id.as_str())
    {
        issues.push(ValidationIssue::new(
            "unknown_active_sequence",
            "active_sequence_id",
            format!("active sequence 不存在：{}", project.active_sequence_id),
        ));
    }
    if project.active_sequence_id.trim().is_empty() && !project.sequences.is_empty() {
        issues.push(ValidationIssue::new(
            "missing_active_sequence",
            "active_sequence_id",
            "存在 sequence 时必须指定 active_sequence_id",
        ));
    }

    issues
}
