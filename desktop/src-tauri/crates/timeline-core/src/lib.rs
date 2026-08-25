use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const TIMELINE_PROJECT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FrameRate {
    pub numerator: u32,
    pub denominator: u32,
}

impl Default for FrameRate {
    fn default() -> Self {
        Self {
            numerator: 24,
            denominator: 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    pub source_id: String,
    #[serde(default)]
    pub clip_id: String,
    #[serde(default)]
    pub media_id: String,
    #[serde(default)]
    pub name: String,
    pub duration_frames: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MulticamGroup {
    pub group_id: String,
    #[serde(default)]
    pub angle_source_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackKind {
    Video,
    Audio,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimelineClip {
    pub clip_id: String,
    pub source_id: String,
    pub timeline_start: i64,
    pub source_in: i64,
    pub duration: i64,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub multicam_group_id: Option<String>,
    pub selected_angle_source_id: Option<String>,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

fn default_true() -> bool {
    true
}

impl TimelineClip {
    pub fn timeline_end(&self) -> i64 {
        self.timeline_start.saturating_add(self.duration)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Track {
    pub track_id: String,
    pub kind: TrackKind,
    #[serde(default)]
    pub clips: Vec<TimelineClip>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Marker {
    pub marker_id: String,
    pub position: i64,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Transition {
    pub transition_id: String,
    pub track_id: String,
    pub left_clip_id: String,
    pub right_clip_id: String,
    pub duration: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sequence {
    pub sequence_id: String,
    pub name: String,
    pub frame_rate: FrameRate,
    #[serde(default)]
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub markers: Vec<Marker>,
    #[serde(default)]
    pub transitions: Vec<Transition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimelineProject {
    #[serde(default = "project_version")]
    pub version: u32,
    pub project_id: String,
    #[serde(default)]
    pub sources: Vec<Source>,
    #[serde(default)]
    pub multicam_groups: Vec<MulticamGroup>,
    #[serde(default)]
    pub sequences: Vec<Sequence>,
    pub active_sequence_id: String,
}

fn project_version() -> u32 {
    TIMELINE_PROJECT_VERSION
}

impl TimelineProject {
    pub fn empty(project_id: impl Into<String>, sequence_id: impl Into<String>) -> Self {
        let sequence_id = sequence_id.into();
        Self {
            version: TIMELINE_PROJECT_VERSION,
            project_id: project_id.into(),
            sources: Vec::new(),
            multicam_groups: Vec::new(),
            sequences: vec![Sequence {
                sequence_id: sequence_id.clone(),
                name: "Sequence 1".to_string(),
                frame_rate: FrameRate::default(),
                tracks: vec![
                    Track {
                        track_id: "V1".to_string(),
                        kind: TrackKind::Video,
                        clips: Vec::new(),
                    },
                    Track {
                        track_id: "A1".to_string(),
                        kind: TrackKind::Audio,
                        clips: Vec::new(),
                    },
                ],
                markers: Vec::new(),
                transitions: Vec::new(),
            }],
            active_sequence_id: sequence_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationIssue {
    pub code: String,
    pub path: String,
    pub message: String,
}

impl ValidationIssue {
    fn new(code: &str, path: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            path: path.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimelineSnapshot {
    pub project: TimelineProject,
    pub undo_depth: usize,
    pub redo_depth: usize,
    pub validation: Vec<ValidationIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    Insert {
        sequence_id: String,
        track_id: String,
        clip: TimelineClip,
    },
    Overwrite {
        sequence_id: String,
        track_id: String,
        clip: TimelineClip,
    },
    Move {
        sequence_id: String,
        clip_id: String,
        target_track_id: String,
        timeline_start: i64,
    },
    Split {
        sequence_id: String,
        clip_id: String,
        position: i64,
        right_clip_id: String,
    },
    Trim {
        sequence_id: String,
        clip_id: String,
        timeline_start: i64,
        source_in: i64,
        duration: i64,
    },
    RippleDelete {
        sequence_id: String,
        clip_id: String,
    },
    Disable {
        sequence_id: String,
        clip_id: String,
        disabled: bool,
    },
    MulticamSwitch {
        sequence_id: String,
        clip_id: String,
        source_id: String,
    },
    SetMarker {
        sequence_id: String,
        marker: Marker,
    },
}

#[derive(Debug, Clone)]
pub struct TimelineEngine {
    project: TimelineProject,
    undo_stack: Vec<TimelineProject>,
    redo_stack: Vec<TimelineProject>,
}

impl TimelineEngine {
    pub fn new(mut project: TimelineProject) -> Result<Self, Vec<ValidationIssue>> {
        normalize_project(&mut project);
        let issues = validate_project(&project);
        if issues.is_empty() {
            Ok(Self {
                project,
                undo_stack: Vec::new(),
                redo_stack: Vec::new(),
            })
        } else {
            Err(issues)
        }
    }

    pub fn project(&self) -> &TimelineProject {
        &self.project
    }

    pub fn snapshot(&self) -> TimelineSnapshot {
        TimelineSnapshot {
            project: self.project.clone(),
            undo_depth: self.undo_stack.len(),
            redo_depth: self.redo_stack.len(),
            validation: validate_project(&self.project),
        }
    }

    pub fn apply(&mut self, command: Command) -> Result<TimelineSnapshot, Vec<ValidationIssue>> {
        let before = self.project.clone();
        if let Err(message) = apply_command(&mut self.project, command) {
            self.project = before;
            return Err(vec![ValidationIssue::new("command_rejected", "command", message)]);
        }
        normalize_project(&mut self.project);
        let issues = validate_project(&self.project);
        if !issues.is_empty() {
            self.project = before;
            return Err(issues);
        }
        self.undo_stack.push(before);
        self.redo_stack.clear();
        Ok(self.snapshot())
    }

    pub fn undo(&mut self) -> Result<TimelineSnapshot, String> {
        let previous = self
            .undo_stack
            .pop()
            .ok_or_else(|| "没有可撤销的 Timeline Command".to_string())?;
        let current = std::mem::replace(&mut self.project, previous);
        self.redo_stack.push(current);
        Ok(self.snapshot())
    }

    pub fn redo(&mut self) -> Result<TimelineSnapshot, String> {
        let next = self
            .redo_stack
            .pop()
            .ok_or_else(|| "没有可重做的 Timeline Command".to_string())?;
        let current = std::mem::replace(&mut self.project, next);
        self.undo_stack.push(current);
        Ok(self.snapshot())
    }
}

fn normalize_project(project: &mut TimelineProject) {
    project.version = TIMELINE_PROJECT_VERSION;
    for sequence in &mut project.sequences {
        for track in &mut sequence.tracks {
            track.clips.sort_by(|left, right| {
                left.timeline_start
                    .cmp(&right.timeline_start)
                    .then_with(|| left.clip_id.cmp(&right.clip_id))
            });
        }
        sequence.markers.sort_by(|left, right| {
            left.position
                .cmp(&right.position)
                .then_with(|| left.marker_id.cmp(&right.marker_id))
        });
    }
}

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
        Command::SetMarker { sequence_id, marker } => {
            ensure_nonempty(&marker.marker_id, "marker_id")?;
            if marker.position < 0 {
                return Err("Marker position 不能为负数".to_string());
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
        let mut angle_ids = HashSet::new();
        for source_id in &group.angle_source_ids {
            if !sources.contains_key(source_id.as_str()) {
                issues.push(ValidationIssue::new(
                    "unknown_multicam_source",
                    &path,
                    format!("Multicam angle source 不存在：{source_id}"),
                ));
            }
            if !angle_ids.insert(source_id.as_str()) {
                issues.push(ValidationIssue::new(
                    "duplicate_multicam_angle",
                    &path,
                    format!("Multicam angle 重复：{source_id}"),
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
                            if let Some(source_id) = clip.selected_angle_source_id.as_deref() {
                                if !group.angle_source_ids.iter().any(|value| value == source_id) {
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
            if marker.marker_id.trim().is_empty() || marker.position < 0 {
                issues.push(ValidationIssue::new(
                    "invalid_marker",
                    format!("{sequence_path}.markers"),
                    "marker_id 不能为空且 position 不能为负数",
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

#[cfg(test)]
mod tests {
    use super::*;

    fn source(id: &str, duration: i64) -> Source {
        Source {
            source_id: id.to_string(),
            clip_id: id.to_string(),
            media_id: String::new(),
            name: id.to_string(),
            duration_frames: Some(duration),
        }
    }

    fn clip(id: &str, source_id: &str, start: i64, source_in: i64, duration: i64) -> TimelineClip {
        TimelineClip {
            clip_id: id.to_string(),
            source_id: source_id.to_string(),
            timeline_start: start,
            source_in,
            duration,
            enabled: true,
            multicam_group_id: None,
            selected_angle_source_id: None,
            metadata: BTreeMap::new(),
        }
    }

    fn project() -> TimelineProject {
        let mut project = TimelineProject::empty("p1", "seq1");
        project.sources = vec![source("s1", 500), source("s2", 500), source("s3", 500)];
        project
    }

    #[test]
    fn project_round_trips_through_json() {
        let project = project();
        let json = serde_json::to_string(&project).unwrap();
        let restored: TimelineProject = serde_json::from_str(&json).unwrap();
        assert_eq!(restored, project);
        assert!(validate_project(&restored).is_empty());
    }

    #[test]
    fn insert_shifts_following_clips_and_undo_redo_is_deterministic() {
        let mut project = project();
        project.sequences[0].tracks[0].clips = vec![clip("c1", "s1", 0, 0, 50), clip("c2", "s2", 50, 0, 50)];
        let mut engine = TimelineEngine::new(project).unwrap();
        engine
            .apply(Command::Insert {
                sequence_id: "seq1".to_string(),
                track_id: "V1".to_string(),
                clip: clip("insert", "s3", 50, 10, 20),
            })
            .unwrap();
        let clips = &engine.project().sequences[0].tracks[0].clips;
        assert_eq!(clips.iter().find(|row| row.clip_id == "c2").unwrap().timeline_start, 70);
        assert_eq!(engine.snapshot().undo_depth, 1);
        engine.undo().unwrap();
        assert_eq!(engine.project().sequences[0].tracks[0].clips[1].timeline_start, 50);
        engine.redo().unwrap();
        assert_eq!(engine.project().sequences[0].tracks[0].clips[2].timeline_start, 70);
    }

    #[test]
    fn insert_rejects_a_position_inside_existing_clip() {
        let mut project = project();
        project.sequences[0].tracks[0].clips = vec![clip("c1", "s1", 0, 0, 50)];
        let mut engine = TimelineEngine::new(project).unwrap();
        let result = engine.apply(Command::Insert {
            sequence_id: "seq1".to_string(),
            track_id: "V1".to_string(),
            clip: clip("insert", "s2", 25, 0, 10),
        });
        assert!(result.is_err());
        assert_eq!(engine.project().sequences[0].tracks[0].clips.len(), 1);
    }

    #[test]
    fn overwrite_splits_a_spanning_clip_with_stable_tail_id() {
        let mut project = project();
        project.sequences[0].tracks[0].clips = vec![clip("base", "s1", 0, 30, 100)];
        let mut engine = TimelineEngine::new(project).unwrap();
        engine
            .apply(Command::Overwrite {
                sequence_id: "seq1".to_string(),
                track_id: "V1".to_string(),
                clip: clip("new", "s2", 30, 0, 20),
            })
            .unwrap();
        let clips = &engine.project().sequences[0].tracks[0].clips;
        assert_eq!(clips.len(), 3);
        assert_eq!(clips[0].duration, 30);
        assert_eq!(clips[1].clip_id, "new");
        assert_eq!(clips[2].clip_id, "base__overwrite_tail__new");
        assert_eq!(clips[2].timeline_start, 50);
        assert_eq!(clips[2].source_in, 80);
        assert_eq!(clips[2].duration, 50);
    }

    #[test]
    fn split_preserves_source_continuity() {
        let mut project = project();
        project.sequences[0].tracks[0].clips = vec![clip("base", "s1", 10, 40, 80)];
        let mut engine = TimelineEngine::new(project).unwrap();
        engine
            .apply(Command::Split {
                sequence_id: "seq1".to_string(),
                clip_id: "base".to_string(),
                position: 40,
                right_clip_id: "base-right".to_string(),
            })
            .unwrap();
        let clips = &engine.project().sequences[0].tracks[0].clips;
        assert_eq!(clips[0].duration, 30);
        assert_eq!(clips[1].timeline_start, 40);
        assert_eq!(clips[1].source_in, 70);
        assert_eq!(clips[1].duration, 50);
    }

    #[test]
    fn move_and_trim_are_rejected_when_the_result_overlaps() {
        let mut project = project();
        project.sequences[0].tracks[0].clips = vec![clip("a", "s1", 0, 0, 40), clip("b", "s2", 50, 0, 40)];
        let mut engine = TimelineEngine::new(project).unwrap();
        assert!(engine
            .apply(Command::Move {
                sequence_id: "seq1".to_string(),
                clip_id: "b".to_string(),
                target_track_id: "V1".to_string(),
                timeline_start: 20,
            })
            .is_err());
        assert_eq!(engine.project().sequences[0].tracks[0].clips[1].timeline_start, 50);
        assert!(engine
            .apply(Command::Trim {
                sequence_id: "seq1".to_string(),
                clip_id: "a".to_string(),
                timeline_start: 0,
                source_in: 0,
                duration: 60,
            })
            .is_err());
    }

    #[test]
    fn ripple_delete_closes_the_removed_duration() {
        let mut project = project();
        project.sequences[0].tracks[0].clips = vec![
            clip("a", "s1", 0, 0, 20),
            clip("b", "s2", 20, 0, 30),
            clip("c", "s3", 70, 0, 10),
        ];
        let mut engine = TimelineEngine::new(project).unwrap();
        engine
            .apply(Command::RippleDelete {
                sequence_id: "seq1".to_string(),
                clip_id: "b".to_string(),
            })
            .unwrap();
        let clips = &engine.project().sequences[0].tracks[0].clips;
        assert_eq!(clips.len(), 2);
        assert_eq!(clips[1].timeline_start, 40);
    }

    #[test]
    fn multicam_switch_requires_an_angle_from_the_group() {
        let mut project = project();
        project.multicam_groups = vec![MulticamGroup {
            group_id: "mc1".to_string(),
            angle_source_ids: vec!["s1".to_string(), "s2".to_string()],
        }];
        let mut base = clip("mc", "s1", 0, 0, 40);
        base.multicam_group_id = Some("mc1".to_string());
        base.selected_angle_source_id = Some("s1".to_string());
        project.sequences[0].tracks[0].clips = vec![base];
        let mut engine = TimelineEngine::new(project).unwrap();
        engine
            .apply(Command::MulticamSwitch {
                sequence_id: "seq1".to_string(),
                clip_id: "mc".to_string(),
                source_id: "s2".to_string(),
            })
            .unwrap();
        assert_eq!(
            engine.project().sequences[0].tracks[0].clips[0]
                .selected_angle_source_id
                .as_deref(),
            Some("s2")
        );
        assert!(engine
            .apply(Command::MulticamSwitch {
                sequence_id: "seq1".to_string(),
                clip_id: "mc".to_string(),
                source_id: "s3".to_string(),
            })
            .is_err());
    }

    #[test]
    fn marker_is_upserted_and_disable_is_undoable() {
        let mut project = project();
        project.sequences[0].tracks[0].clips = vec![clip("a", "s1", 0, 0, 20)];
        let mut engine = TimelineEngine::new(project).unwrap();
        engine
            .apply(Command::SetMarker {
                sequence_id: "seq1".to_string(),
                marker: Marker {
                    marker_id: "m1".to_string(),
                    position: 12,
                    label: "beat".to_string(),
                },
            })
            .unwrap();
        engine
            .apply(Command::Disable {
                sequence_id: "seq1".to_string(),
                clip_id: "a".to_string(),
                disabled: true,
            })
            .unwrap();
        assert!(!engine.project().sequences[0].tracks[0].clips[0].enabled);
        engine.undo().unwrap();
        assert!(engine.project().sequences[0].tracks[0].clips[0].enabled);
        assert_eq!(engine.project().sequences[0].markers[0].label, "beat");
    }

    #[test]
    fn validation_catches_source_range_and_track_overlap() {
        let mut project = project();
        project.sequences[0].tracks[0].clips = vec![clip("a", "s1", 0, 480, 30), clip("b", "s2", 10, 0, 20)];
        let issues = validate_project(&project);
        assert!(issues.iter().any(|issue| issue.code == "source_range_exceeded"));
        assert!(issues.iter().any(|issue| issue.code == "track_overlap"));
    }
}
