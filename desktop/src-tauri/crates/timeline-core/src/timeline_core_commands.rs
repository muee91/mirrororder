fn sequence_mut<'a>(project: &'a mut TimelineProject, sequence_id: &str) -> Result<&'a mut Sequence, String> {
    project
        .sequences
        .iter_mut()
        .find(|sequence| sequence.sequence_id == sequence_id)
        .ok_or_else(|| format!("Sequence 不存在：{sequence_id}"))
}

fn track_mut<'a>(sequence: &'a mut Sequence, track_id: &str) -> Result<&'a mut Track, String> {
    sequence
        .tracks
        .iter_mut()
        .find(|track| track.track_id == track_id)
        .ok_or_else(|| format!("Track 不存在：{track_id}"))
}

fn clip_location(sequence: &Sequence, clip_id: &str) -> Option<(usize, usize)> {
    sequence.tracks.iter().enumerate().find_map(|(track_index, track)| {
        track
            .clips
            .iter()
            .position(|clip| clip.clip_id == clip_id)
            .map(|clip_index| (track_index, clip_index))
    })
}

fn ensure_nonempty(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(format!("{label} 不能为空"))
    } else {
        Ok(())
    }
}

fn ensure_clip_shape(clip: &TimelineClip) -> Result<(), String> {
    ensure_nonempty(&clip.clip_id, "clip_id")?;
    ensure_nonempty(&clip.source_id, "source_id")?;
    if clip.timeline_start < 0 || clip.source_in < 0 {
        return Err("Timeline clip 的 timeline_start/source_in 不能为负数".to_string());
    }
    if clip.duration <= 0 {
        return Err("Timeline clip duration 必须大于 0 frame".to_string());
    }
    Ok(())
}

fn point_cuts_clip(track: &Track, position: i64) -> bool {
    track
        .clips
        .iter()
        .any(|clip| clip.timeline_start < position && position < clip.timeline_end())
}

fn apply_command(project: &mut TimelineProject, command: Command) -> Result<(), String> {
    match command {
        Command::Insert {
            sequence_id,
            track_id,
            clip,
        } => {
            ensure_clip_shape(&clip)?;
            let sequence = sequence_mut(project, &sequence_id)?;
            let track = track_mut(sequence, &track_id)?;
            if point_cuts_clip(track, clip.timeline_start) {
                return Err("Insert 位置位于现有 clip 内部；请先 split 或使用 overwrite".to_string());
            }
            for existing in &mut track.clips {
                if existing.timeline_start >= clip.timeline_start {
                    existing.timeline_start = existing.timeline_start.saturating_add(clip.duration);
                }
            }
            track.clips.push(clip);
        }
        Command::Overwrite {
            sequence_id,
            track_id,
            clip,
        } => {
            ensure_clip_shape(&clip)?;
            let overwrite_start = clip.timeline_start;
            let overwrite_end = clip.timeline_end();
            let sequence = sequence_mut(project, &sequence_id)?;
            let track = track_mut(sequence, &track_id)?;
            let mut next: Vec<TimelineClip> = Vec::new();
            for existing in track.clips.drain(..) {
                let existing_start = existing.timeline_start;
                let existing_end = existing.timeline_end();
                if existing_end <= overwrite_start || existing_start >= overwrite_end {
                    next.push(existing);
                    continue;
                }
                if existing_start < overwrite_start && existing_end > overwrite_end {
                    let mut left = existing.clone();
                    left.duration = overwrite_start - existing_start;
                    next.push(left);

                    let mut right = existing;
                    right.clip_id = format!("{}__overwrite_tail__{}", right.clip_id, clip.clip_id);
                    right.timeline_start = overwrite_end;
                    right.source_in += overwrite_end - existing_start;
                    right.duration = existing_end - overwrite_end;
                    next.push(right);
                    continue;
                }
                if existing_start < overwrite_start && existing_end > overwrite_start {
                    let mut left = existing;
                    left.duration = overwrite_start - existing_start;
                    if left.duration > 0 {
                        next.push(left);
                    }
                    continue;
                }
                if existing_start < overwrite_end && existing_end > overwrite_end {
                    let mut right = existing;
                    let consumed = overwrite_end - existing_start;
                    right.timeline_start = overwrite_end;
                    right.source_in += consumed;
                    right.duration = existing_end - overwrite_end;
                    if right.duration > 0 {
                        next.push(right);
                    }
                }
            }
            next.push(clip);
            track.clips = next;
        }
        Command::Move {
            sequence_id,
            clip_id,
            target_track_id,
            timeline_start,
        } => {
            if timeline_start < 0 {
                return Err("Move timeline_start 不能为负数".to_string());
            }
            let sequence = sequence_mut(project, &sequence_id)?;
            let (source_track_index, clip_index) = clip_location(sequence, &clip_id)
                .ok_or_else(|| format!("Clip 不存在：{clip_id}"))?;
            let mut clip = sequence.tracks[source_track_index].clips.remove(clip_index);
            clip.timeline_start = timeline_start;
            track_mut(sequence, &target_track_id)?.clips.push(clip);
        }
        Command::Split {
            sequence_id,
            clip_id,
            position,
            right_clip_id,
        } => {
            ensure_nonempty(&right_clip_id, "right_clip_id")?;
            let sequence = sequence_mut(project, &sequence_id)?;
            if clip_location(sequence, &right_clip_id).is_some() {
                return Err(format!("Split right_clip_id 已存在：{right_clip_id}"));
            }
            let (track_index, clip_index) = clip_location(sequence, &clip_id)
                .ok_or_else(|| format!("Clip 不存在：{clip_id}"))?;
            let clip = &mut sequence.tracks[track_index].clips[clip_index];
            if position <= clip.timeline_start || position >= clip.timeline_end() {
                return Err("Split position 必须严格位于 clip 内部".to_string());
            }
            let offset = position - clip.timeline_start;
            let mut right = clip.clone();
            right.clip_id = right_clip_id;
            right.timeline_start = position;
            right.source_in += offset;
            right.duration = clip.duration - offset;
            clip.duration = offset;
            sequence.tracks[track_index].clips.push(right);
        }
        Command::Trim {
            sequence_id,
            clip_id,
            timeline_start,
            source_in,
            duration,
        } => {
            if timeline_start < 0 || source_in < 0 || duration <= 0 {
                return Err("Trim 参数必须满足 start/source_in >= 0 且 duration > 0".to_string());
            }
            let sequence = sequence_mut(project, &sequence_id)?;
            let (track_index, clip_index) = clip_location(sequence, &clip_id)
                .ok_or_else(|| format!("Clip 不存在：{clip_id}"))?;
            let clip = &mut sequence.tracks[track_index].clips[clip_index];
            clip.timeline_start = timeline_start;
            clip.source_in = source_in;
            clip.duration = duration;
        }
        Command::RippleDelete {
            sequence_id,
            clip_id,
        } => {
            let sequence = sequence_mut(project, &sequence_id)?;
            let (track_index, clip_index) = clip_location(sequence, &clip_id)
                .ok_or_else(|| format!("Clip 不存在：{clip_id}"))?;
            let removed = sequence.tracks[track_index].clips.remove(clip_index);
            let removed_end = removed.timeline_end();
            for clip in &mut sequence.tracks[track_index].clips {
                if clip.timeline_start >= removed_end {
                    clip.timeline_start -= removed.duration;
                }
            }
        }
        Command::Disable {
            sequence_id,
            clip_id,
            disabled,
        } => {
            let sequence = sequence_mut(project, &sequence_id)?;
            let (track_index, clip_index) = clip_location(sequence, &clip_id)
                .ok_or_else(|| format!("Clip 不存在：{clip_id}"))?;
            sequence.tracks[track_index].clips[clip_index].enabled = !disabled;
        }
        Command::ReplaceTake {
            sequence_id,
            clip_id,
            group_id,
            source_id,
            source_in,
        } => {
            ensure_nonempty(&group_id, "group_id")?;
            ensure_nonempty(&source_id, "source_id")?;
            if source_in < 0 {
                return Err("ReplaceTake source_in 不能为负数".to_string());
            }
            let source = project
                .sources
                .iter()
                .find(|source| source.source_id == source_id)
                .ok_or_else(|| format!("ReplaceTake source 不存在：{source_id}"))?;
            let source_clip_id = source.clip_id.clone();
            let source_duration = source.duration_frames;
            let replacement_multicam = project
                .multicam_groups
                .iter()
                .find(|group| group.group_id == group_id)
                .map(|group| {
                    if group.contains_source(&source_id) {
                        Ok(group.group_id.clone())
                    } else {
                        Err(format!("source {source_id} 不属于 replacement multicam group {group_id}"))
                    }
                })
                .transpose()?;
            let sequence = sequence_mut(project, &sequence_id)?;
            let (track_index, clip_index) = clip_location(sequence, &clip_id)
                .ok_or_else(|| format!("Clip 不存在：{clip_id}"))?;
            let clip = &mut sequence.tracks[track_index].clips[clip_index];
            if let Some(duration_frames) = source_duration {
                if source_in.saturating_add(clip.duration) > duration_frames {
                    return Err(format!(
                        "ReplaceTake 无法保持当前 {}f 时长；replacement source 只到 {}f",
                        clip.duration, duration_frames
                    ));
                }
            }
            clip.source_id = source_id.clone();
            clip.source_in = source_in;
            clip.multicam_group_id = replacement_multicam;
            clip.selected_angle_source_id = clip.multicam_group_id.as_ref().map(|_| source_id);
            clip.metadata.insert("group_id".to_string(), group_id);
            clip.metadata.remove("camera");
            if !source_clip_id.trim().is_empty() {
                clip.metadata
                    .insert("source_clip_id".to_string(), source_clip_id);
            }
            clip.metadata
                .insert("edit_source".to_string(), "replace_take".to_string());
        }
        Command::MulticamSwitch {
            sequence_id,
            clip_id,
            source_id,
        } => {
            ensure_nonempty(&source_id, "source_id")?;
            let sequence = sequence_mut(project, &sequence_id)?;
            let (track_index, clip_index) = clip_location(sequence, &clip_id)
                .ok_or_else(|| format!("Clip 不存在：{clip_id}"))?;
            sequence.tracks[track_index].clips[clip_index].selected_angle_source_id = Some(source_id);
        }
        Command::SetMarker { sequence_id, mut marker } => {
            ensure_nonempty(&marker.marker_id, "marker_id")?;
            if marker.position < 0 || marker.duration < 0 {
                return Err("Marker position/duration 不能为负数".to_string());
            }
            if marker.kind.trim().is_empty() {
                marker.kind = default_marker_kind();
            }
            let sequence = sequence_mut(project, &sequence_id)?;
            if let Some(existing) = sequence
                .markers
                .iter_mut()
                .find(|existing| existing.marker_id == marker.marker_id)
            {
                *existing = marker;
            } else {
                sequence.markers.push(marker);
            }
        }
    }
    Ok(())
}
