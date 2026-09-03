use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const TIMELINE_PROJECT_VERSION: u32 = 2;

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
pub struct MulticamAngle {
    pub source_id: String,
    #[serde(default)]
    pub camera: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub sync_start_frame: Option<i64>,
    #[serde(default)]
    pub sync_end_frame: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MulticamGroup {
    pub group_id: String,
    // v1 compatibility projection. v2 authority lives in `angles`; normalize_project
    // keeps this list synchronized so current Delivery v1 can migrate independently.
    #[serde(default)]
    pub angle_source_ids: Vec<String>,
    #[serde(default)]
    pub angles: Vec<MulticamAngle>,
    #[serde(default)]
    pub reference_source_id: Option<String>,
    #[serde(default)]
    pub audio_source_id: Option<String>,
}

impl MulticamGroup {
    fn source_ids(&self) -> Vec<&str> {
        if self.angles.is_empty() {
            self.angle_source_ids.iter().map(String::as_str).collect()
        } else {
            self.angles.iter().map(|angle| angle.source_id.as_str()).collect()
        }
    }

    fn contains_source(&self, source_id: &str) -> bool {
        self.source_ids().into_iter().any(|value| value == source_id)
    }
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
    pub duration: i64,
    #[serde(default = "default_marker_kind")]
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

fn default_marker_kind() -> String {
    "standard".to_string()
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
    ReplaceTake {
        sequence_id: String,
        clip_id: String,
        group_id: String,
        source_id: String,
        source_in: i64,
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
    // v1 checkpoints are compatible and upgrade in memory. Unknown/future versions
    // must remain unchanged so validation fails closed instead of silently coercing them.
    if project.version == 1 {
        project.version = TIMELINE_PROJECT_VERSION;
    }
    for group in &mut project.multicam_groups {
        if group.angles.is_empty() && !group.angle_source_ids.is_empty() {
            group.angles = group
                .angle_source_ids
                .iter()
                .map(|source_id| MulticamAngle {
                    source_id: source_id.clone(),
                    camera: String::new(),
                    name: String::new(),
                    sync_start_frame: None,
                    sync_end_frame: None,
                })
                .collect();
        }
        if !group.angles.is_empty() {
            group.angle_source_ids = group
                .angles
                .iter()
                .map(|angle| angle.source_id.clone())
                .collect();
        }
        if group.reference_source_id.is_none() {
            group.reference_source_id = group.angle_source_ids.first().cloned();
        }
    }
    for sequence in &mut project.sequences {
        for track in &mut sequence.tracks {
            track.clips.sort_by(|left, right| {
                left.timeline_start
                    .cmp(&right.timeline_start)
                    .then_with(|| left.clip_id.cmp(&right.clip_id))
            });
        }
        for marker in &mut sequence.markers {
            if marker.kind.trim().is_empty() {
                marker.kind = default_marker_kind();
            }
        }
        sequence.markers.sort_by(|left, right| {
            left.position
                .cmp(&right.position)
                .then_with(|| left.marker_id.cmp(&right.marker_id))
        });
    }
}
