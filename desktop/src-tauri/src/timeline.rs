use crate::persistence::{
    journal_entry, new_generation, JournalOperation, PersistenceStatus, TimelineStorage,
};
use mirrororder_timeline_core::{
    validate_project, Command, TimelineEngine, TimelineProject, TimelineSnapshot, ValidationIssue,
};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Clone)]
struct ManagedTimeline {
    engine: TimelineEngine,
    storage: TimelineStorage,
    generation: String,
    next_sequence: u64,
    checkpoint_sequence: u64,
    recovered_operations: usize,
    used_backup: bool,
    ignored_partial_tail: bool,
}

#[derive(Debug, Default)]
pub struct TimelineManager {
    current: Mutex<Option<ManagedTimeline>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimelineAuthority {
    generation: String,
    revision: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TimelineBridgeSnapshot {
    #[serde(flatten)]
    snapshot: TimelineSnapshot,
    authority: TimelineAuthority,
}

#[derive(Debug, Serialize)]
pub struct TimelineBridgeError {
    message: String,
    issues: Vec<ValidationIssue>,
}

#[derive(Debug, Serialize)]
pub struct TimelineRuntimeStatus {
    project_id: String,
    authority: TimelineAuthority,
    persistence: PersistenceStatus,
    recovered_operations: usize,
    used_backup: bool,
    ignored_partial_tail: bool,
}

impl TimelineBridgeError {
    fn message(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            issues: Vec::new(),
        }
    }

    fn validation(message: impl Into<String>, issues: Vec<ValidationIssue>) -> Self {
        Self {
            message: message.into(),
            issues,
        }
    }
}

fn lock_manager<'a>(
    manager: &'a State<'a, TimelineManager>,
) -> Result<std::sync::MutexGuard<'a, Option<ManagedTimeline>>, TimelineBridgeError> {
    manager
        .current
        .lock()
        .map_err(|_| TimelineBridgeError::message("Timeline Core 状态锁已损坏"))
}

fn clean_engine(project: TimelineProject) -> Result<TimelineEngine, TimelineBridgeError> {
    TimelineEngine::new(project)
        .map_err(|issues| TimelineBridgeError::validation("Timeline checkpoint 未通过校验", issues))
}

fn authority(managed: &ManagedTimeline) -> TimelineAuthority {
    TimelineAuthority {
        generation: managed.generation.clone(),
        revision: managed.next_sequence.saturating_sub(1),
    }
}

fn bridge_snapshot(managed: &ManagedTimeline) -> TimelineBridgeSnapshot {
    TimelineBridgeSnapshot {
        snapshot: managed.engine.snapshot(),
        authority: authority(managed),
    }
}

fn require_authority(
    managed: &ManagedTimeline,
    expected: &TimelineAuthority,
) -> Result<(), TimelineBridgeError> {
    let current = authority(managed);
    if &current == expected {
        return Ok(());
    }
    Err(TimelineBridgeError::validation(
        "Timeline authority 已变化；拒绝应用过期编辑，请刷新后重试",
        vec![ValidationIssue {
            code: "stale_timeline_authority".to_string(),
            path: "authority".to_string(),
            message: format!(
                "expected {}@{}，current {}@{}",
                expected.generation, expected.revision, current.generation, current.revision
            ),
        }],
    ))
}

fn apply_commands_transactionally(
    engine: &mut TimelineEngine,
    commands: &[Command],
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    if commands.is_empty() {
        return Ok(engine.snapshot());
    }
    let checkpoint = engine.clone();
    for command in commands {
        if let Err(issues) = engine.apply(command.clone()) {
            *engine = checkpoint;
            return Err(TimelineBridgeError::validation(
                "Timeline command batch 被拒绝；已完整回滚",
                issues,
            ));
        }
    }
    Ok(engine.snapshot())
}

fn apply_operation(
    engine: &mut TimelineEngine,
    operation: &JournalOperation,
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    match operation {
        JournalOperation::Apply { command } => engine
            .apply(command.clone())
            .map_err(|issues| TimelineBridgeError::validation("Timeline Command 被拒绝", issues)),
        JournalOperation::ApplyBatch { commands } => apply_commands_transactionally(engine, commands),
        JournalOperation::Undo => engine.undo().map_err(TimelineBridgeError::message),
        JournalOperation::Redo => engine.redo().map_err(TimelineBridgeError::message),
    }
}

fn replace_with_checkpoint(
    manager: &State<'_, TimelineManager>,
    engine: TimelineEngine,
) -> Result<TimelineBridgeSnapshot, TimelineBridgeError> {
    let project = engine.project().clone();
    let project_id = project.project_id.clone();
    let storage = TimelineStorage::for_project(&project_id).map_err(TimelineBridgeError::message)?;
    let generation = new_generation(&project_id);
    storage
        .write_checkpoint(&project, &generation, 0)
        .map_err(TimelineBridgeError::message)?;

    // A checkpoint is a durable history boundary. Resetting the snapshot-based
    // undo stack here guarantees that every later Undo/Redo can be reconstructed
    // solely from journal rows after this checkpoint.
    let managed = ManagedTimeline {
        engine: clean_engine(project)?,
        storage,
        generation,
        next_sequence: 1,
        checkpoint_sequence: 0,
        recovered_operations: 0,
        used_backup: false,
        ignored_partial_tail: false,
    };
    let snapshot = bridge_snapshot(&managed);
    *lock_manager(manager)? = Some(managed);
    Ok(snapshot)
}

fn commit_operation(
    managed: &mut ManagedTimeline,
    expected_authority: &TimelineAuthority,
    operation: JournalOperation,
) -> Result<TimelineBridgeSnapshot, TimelineBridgeError> {
    require_authority(managed, expected_authority)?;
    // Validate on a clone first. Only an fsync'd journal operation is allowed to
    // become the new in-memory authority.
    let mut candidate = managed.engine.clone();
    apply_operation(&mut candidate, &operation)?;
    let sequence = managed.next_sequence;
    managed
        .storage
        .append(&journal_entry(&managed.generation, sequence, operation))
        .map_err(TimelineBridgeError::message)?;
    managed.engine = candidate;
    managed.next_sequence = sequence.saturating_add(1);
    Ok(bridge_snapshot(managed))
}

fn checkpoint_managed(
    managed: &mut ManagedTimeline,
    expected_authority: &TimelineAuthority,
) -> Result<TimelineBridgeSnapshot, TimelineBridgeError> {
    require_authority(managed, expected_authority)?;
    let project = managed.engine.project().clone();
    // A manual checkpoint starts a fresh authority generation. This makes every
    // stale UI/editor token from the pre-checkpoint undo history fail closed.
    let generation = new_generation(&project.project_id);
    managed
        .storage
        .write_checkpoint(&project, &generation, 0)
        .map_err(TimelineBridgeError::message)?;
    managed.engine = clean_engine(project)?;
    managed.generation = generation;
    managed.next_sequence = 1;
    managed.checkpoint_sequence = 0;
    managed.recovered_operations = 0;
    managed.used_backup = false;
    managed.ignored_partial_tail = false;
    Ok(bridge_snapshot(managed))
}

fn recover_with_storage(
    project_id: &str,
    storage: TimelineStorage,
) -> Result<ManagedTimeline, TimelineBridgeError> {
    if !storage.exists() {
        return Err(TimelineBridgeError::message(format!(
            "项目 {project_id} 还没有持久化 Timeline"
        )));
    }

    let loaded = storage
        .load_checkpoint()
        .map_err(TimelineBridgeError::message)?;
    if loaded.project.project_id != project_id {
        return Err(TimelineBridgeError::message("Timeline checkpoint project_id 不匹配"));
    }
    let mut engine = clean_engine(loaded.project)?;
    let journal = storage.read_journal().map_err(TimelineBridgeError::message)?;
    let mut previous_sequence = loaded.journal_sequence;
    let mut recovered_operations = 0usize;

    for entry in &journal.entries {
        if entry.generation != loaded.generation || entry.sequence <= loaded.journal_sequence {
            continue;
        }
        if entry.sequence <= previous_sequence {
            return Err(TimelineBridgeError::message(format!(
                "Timeline journal sequence 非递增：{} ≤ {}",
                entry.sequence, previous_sequence
            )));
        }
        apply_operation(&mut engine, &entry.operation).map_err(|error| TimelineBridgeError {
            message: format!("恢复 Timeline journal #{} 失败：{}", entry.sequence, error.message),
            issues: error.issues,
        })?;
        previous_sequence = entry.sequence;
        recovered_operations += 1;
    }

    Ok(ManagedTimeline {
        engine,
        storage,
        generation: loaded.generation,
        next_sequence: previous_sequence.saturating_add(1).max(1),
        checkpoint_sequence: loaded.journal_sequence,
        recovered_operations,
        used_backup: loaded.used_backup,
        ignored_partial_tail: journal.ignored_partial_tail,
    })
}

fn recover_managed(project_id: &str) -> Result<ManagedTimeline, TimelineBridgeError> {
    let storage = TimelineStorage::for_project(project_id).map_err(TimelineBridgeError::message)?;
    recover_with_storage(project_id, storage)
}

#[tauri::command]
pub fn timeline_new(
    project_id: String,
    sequence_id: String,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineBridgeSnapshot, TimelineBridgeError> {
    let project_id = project_id.trim();
    let sequence_id = sequence_id.trim();
    if project_id.is_empty() || sequence_id.is_empty() {
        return Err(TimelineBridgeError::message(
            "创建 Timeline 需要 project_id 与 sequence_id",
        ));
    }
    let engine = TimelineEngine::new(TimelineProject::empty(project_id, sequence_id)).map_err(|issues| {
        TimelineBridgeError::validation("新建 Timeline 未通过校验", issues)
    })?;
    replace_with_checkpoint(&manager, engine)
}

#[tauri::command]
pub fn timeline_load(
    project: TimelineProject,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineBridgeSnapshot, TimelineBridgeError> {
    let engine = TimelineEngine::new(project)
        .map_err(|issues| TimelineBridgeError::validation("Timeline project 未通过校验", issues))?;
    replace_with_checkpoint(&manager, engine)
}

#[tauri::command]
pub fn timeline_open_persisted(
    project_id: String,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineBridgeSnapshot, TimelineBridgeError> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err(TimelineBridgeError::message("恢复 Timeline 需要 project_id"));
    }
    let managed = recover_managed(project_id)?;
    let snapshot = bridge_snapshot(&managed);
    *lock_manager(&manager)? = Some(managed);
    Ok(snapshot)
}

#[tauri::command]
pub fn timeline_load_with_commands(
    project: TimelineProject,
    commands: Vec<Command>,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineBridgeSnapshot, TimelineBridgeError> {
    let mut next_engine = TimelineEngine::new(project)
        .map_err(|issues| TimelineBridgeError::validation("Timeline proposal base 未通过校验", issues))?;
    apply_commands_transactionally(&mut next_engine, &commands)?;
    // A human-confirmed proposal becomes a fresh durable history boundary only
    // after the entire command batch validates.
    replace_with_checkpoint(&manager, next_engine)
}

#[tauri::command]
pub fn timeline_snapshot(
    manager: State<'_, TimelineManager>,
) -> Result<TimelineBridgeSnapshot, TimelineBridgeError> {
    lock_manager(&manager)?
        .as_ref()
        .map(bridge_snapshot)
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))
}

#[tauri::command]
pub fn timeline_apply(
    command: Command,
    expected_authority: TimelineAuthority,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineBridgeSnapshot, TimelineBridgeError> {
    let mut guard = lock_manager(&manager)?;
    let managed = guard
        .as_mut()
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))?;
    commit_operation(managed, &expected_authority, JournalOperation::Apply { command })
}

#[tauri::command]
pub fn timeline_apply_batch(
    commands: Vec<Command>,
    expected_authority: TimelineAuthority,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineBridgeSnapshot, TimelineBridgeError> {
    let mut guard = lock_manager(&manager)?;
    let managed = guard
        .as_mut()
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))?;
    commit_operation(
        managed,
        &expected_authority,
        JournalOperation::ApplyBatch { commands },
    )
}

#[tauri::command]
pub fn timeline_undo(
    expected_authority: TimelineAuthority,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineBridgeSnapshot, TimelineBridgeError> {
    let mut guard = lock_manager(&manager)?;
    let managed = guard
        .as_mut()
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))?;
    commit_operation(managed, &expected_authority, JournalOperation::Undo)
}

#[tauri::command]
pub fn timeline_redo(
    expected_authority: TimelineAuthority,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineBridgeSnapshot, TimelineBridgeError> {
    let mut guard = lock_manager(&manager)?;
    let managed = guard
        .as_mut()
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))?;
    commit_operation(managed, &expected_authority, JournalOperation::Redo)
}

#[tauri::command]
pub fn timeline_checkpoint(
    expected_authority: TimelineAuthority,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineBridgeSnapshot, TimelineBridgeError> {
    let mut guard = lock_manager(&manager)?;
    let managed = guard
        .as_mut()
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))?;
    checkpoint_managed(managed, &expected_authority)
}

#[tauri::command]
pub fn timeline_persistence_status(
    manager: State<'_, TimelineManager>,
) -> Result<TimelineRuntimeStatus, TimelineBridgeError> {
    let guard = lock_manager(&manager)?;
    let managed = guard
        .as_ref()
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))?;
    Ok(TimelineRuntimeStatus {
        project_id: managed.engine.project().project_id.clone(),
        authority: authority(managed),
        persistence: managed
            .storage
            .status(&managed.generation, managed.checkpoint_sequence)
            .map_err(TimelineBridgeError::message)?,
        recovered_operations: managed.recovered_operations,
        used_backup: managed.used_backup,
        ignored_partial_tail: managed.ignored_partial_tail,
    })
}

#[tauri::command]
pub fn timeline_validate(
    manager: State<'_, TimelineManager>,
) -> Result<Vec<ValidationIssue>, TimelineBridgeError> {
    let guard = lock_manager(&manager)?;
    let managed = guard
        .as_ref()
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))?;
    Ok(validate_project(managed.engine.project()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mirrororder_timeline_core::{FrameRate, MulticamGroup, Source, TimelineClip};
    use std::collections::BTreeMap;
    use std::env;

    fn clip(
        clip_id: &str,
        source_id: &str,
        timeline_start: i64,
        source_in: i64,
        duration: i64,
    ) -> TimelineClip {
        TimelineClip {
            clip_id: clip_id.to_string(),
            source_id: source_id.to_string(),
            timeline_start,
            source_in,
            duration,
            enabled: true,
            multicam_group_id: None,
            selected_angle_source_id: None,
            metadata: BTreeMap::new(),
        }
    }

    fn golden_project() -> TimelineProject {
        let mut project = TimelineProject::empty("golden-timeline", "main");
        project.sources = vec![
            Source {
                source_id: "src-a".to_string(),
                clip_id: "take-a".to_string(),
                media_id: "M_A".to_string(),
                name: "take-a.mov".to_string(),
                duration_frames: Some(240),
            },
            Source {
                source_id: "src-b".to_string(),
                clip_id: "take-b".to_string(),
                media_id: "M_B".to_string(),
                name: "take-b.mov".to_string(),
                duration_frames: Some(240),
            },
            Source {
                source_id: "src-insert".to_string(),
                clip_id: "insert".to_string(),
                media_id: "M_INSERT".to_string(),
                name: "insert.mov".to_string(),
                duration_frames: Some(120),
            },
        ];
        project.multicam_groups = vec![MulticamGroup {
            group_id: "mc-scene-1".to_string(),
            angle_source_ids: vec!["src-a".to_string(), "src-b".to_string()],
        }];
        project.sequences[0].frame_rate = FrameRate {
            numerator: 24_000,
            denominator: 1_001,
        };
        let mut scene = clip("scene-1", "src-a", 0, 0, 96);
        scene.multicam_group_id = Some("mc-scene-1".to_string());
        scene.selected_angle_source_id = Some("src-a".to_string());
        scene.metadata.insert("segment_id".to_string(), "E1_SC1_S1".to_string());
        let mut next = clip("scene-2", "src-a", 96, 96, 48);
        next.multicam_group_id = Some("mc-scene-1".to_string());
        next.selected_angle_source_id = Some("src-a".to_string());
        next.metadata.insert("segment_id".to_string(), "E1_SC2_S1".to_string());
        project.sequences[0].tracks[0].clips = vec![scene, next];
        project
    }

    fn temp_storage(project_id: &str) -> TimelineStorage {
        let root = env::temp_dir().join(format!(
            "mirrororder-timeline-golden-{}-{}",
            std::process::id(),
            new_generation(project_id)
        ));
        TimelineStorage::with_root(project_id, root).unwrap()
    }

    fn managed(project: TimelineProject) -> ManagedTimeline {
        let project_id = project.project_id.clone();
        let engine = TimelineEngine::new(project.clone()).unwrap();
        let storage = temp_storage(&project_id);
        let generation = new_generation(&project_id);
        storage.write_checkpoint(&project, &generation, 0).unwrap();
        ManagedTimeline {
            engine,
            storage,
            generation,
            next_sequence: 1,
            checkpoint_sequence: 0,
            recovered_operations: 0,
            used_backup: false,
            ignored_partial_tail: false,
        }
    }

    #[test]
    fn transactional_batch_rolls_back_the_candidate() {
        let mut project = TimelineProject::empty("p1", "main");
        project.sources = vec![Source {
            source_id: "s1".to_string(),
            clip_id: "c1".to_string(),
            media_id: String::new(),
            name: "c1".to_string(),
            duration_frames: Some(100),
        }];
        let mut engine = TimelineEngine::new(project).unwrap();
        let commands = vec![Command::Insert {
            sequence_id: "main".to_string(),
            track_id: "V1".to_string(),
            clip: clip("bad", "missing", 0, 0, 10),
        }];
        assert!(apply_commands_transactionally(&mut engine, &commands).is_err());
        assert!(engine.project().sequences[0].tracks[0].clips.is_empty());
    }

    #[test]
    fn a_checkpoint_is_an_explicit_history_boundary() {
        let project = TimelineProject::empty("p1", "main");
        let engine = clean_engine(project).unwrap();
        assert_eq!(engine.snapshot().undo_depth, 0);
        assert_eq!(engine.snapshot().redo_depth, 0);
    }

    #[test]
    fn stale_authority_is_rejected_before_journal_write() {
        let mut managed = managed(golden_project());
        let stale = authority(&managed);
        commit_operation(
            &mut managed,
            &stale,
            JournalOperation::Apply {
                command: Command::Trim {
                    sequence_id: "main".to_string(),
                    clip_id: "scene-1".to_string(),
                    timeline_start: 0,
                    source_in: 24,
                    duration: 72,
                },
            },
        )
        .unwrap();
        let current = authority(&managed);
        assert_eq!(current.revision, 1);
        let error = commit_operation(
            &mut managed,
            &stale,
            JournalOperation::Apply {
                command: Command::SetMarker {
                    sequence_id: "main".to_string(),
                    marker: mirrororder_timeline_core::Marker {
                        marker_id: "stale".to_string(),
                        position: 1,
                        label: "stale".to_string(),
                    },
                },
            },
        )
        .unwrap_err();
        assert_eq!(error.issues[0].code, "stale_timeline_authority");
        assert_eq!(authority(&managed), current);
        assert_eq!(managed.storage.read_journal().unwrap().entries.len(), 1);
    }

    #[test]
    fn golden_timeline_lifecycle_replays_undo_redo_and_reopens_deterministically() {
        let mut managed = managed(golden_project());
        let initial_generation = managed.generation.clone();
        assert_eq!(authority(&managed).revision, 0);
        assert_eq!(managed.engine.project().sequences[0].frame_rate.numerator, 24_000);
        assert_eq!(managed.engine.project().sequences[0].frame_rate.denominator, 1_001);

        let mut expected = authority(&managed);
        let operations = vec![
            JournalOperation::Apply {
                command: Command::Trim {
                    sequence_id: "main".to_string(),
                    clip_id: "scene-1".to_string(),
                    timeline_start: 0,
                    source_in: 24,
                    duration: 72,
                },
            },
            JournalOperation::Apply {
                command: Command::Split {
                    sequence_id: "main".to_string(),
                    clip_id: "scene-1".to_string(),
                    position: 36,
                    right_clip_id: "scene-1-right".to_string(),
                },
            },
            JournalOperation::Apply {
                command: Command::MulticamSwitch {
                    sequence_id: "main".to_string(),
                    clip_id: "scene-1-right".to_string(),
                    source_id: "src-b".to_string(),
                },
            },
            JournalOperation::Apply {
                command: Command::Overwrite {
                    sequence_id: "main".to_string(),
                    track_id: "V1".to_string(),
                    clip: clip("insert-closeup", "src-insert", 108, 0, 12),
                },
            },
        ];
        for operation in operations {
            let snapshot = commit_operation(&mut managed, &expected, operation).unwrap();
            expected = snapshot.authority;
        }
        assert_eq!(expected.revision, 4);
        let edited = managed.engine.project().clone();
        let clips = &edited.sequences[0].tracks[0].clips;
        assert_eq!(clips.iter().find(|clip| clip.clip_id == "scene-1").unwrap().duration, 36);
        assert_eq!(
            clips.iter().find(|clip| clip.clip_id == "scene-1-right").unwrap().selected_angle_source_id.as_deref(),
            Some("src-b")
        );
        assert!(clips.iter().any(|clip| clip.clip_id == "insert-closeup"));

        let undone = commit_operation(&mut managed, &expected, JournalOperation::Undo).unwrap();
        expected = undone.authority;
        assert_eq!(expected.revision, 5);
        assert!(!managed
            .engine
            .project()
            .sequences[0]
            .tracks[0]
            .clips
            .iter()
            .any(|clip| clip.clip_id == "insert-closeup"));

        let redone = commit_operation(&mut managed, &expected, JournalOperation::Redo).unwrap();
        expected = redone.authority;
        assert_eq!(expected.revision, 6);
        assert_eq!(managed.engine.project(), &edited);

        let recovered = recover_with_storage("golden-timeline", managed.storage.clone()).unwrap();
        assert_eq!(recovered.engine.project(), &edited);
        assert_eq!(recovered.recovered_operations, 6);
        assert_eq!(authority(&recovered), expected);
        assert_eq!(recovered.generation, initial_generation);

        let before_checkpoint = authority(&managed);
        let checkpointed = checkpoint_managed(&mut managed, &before_checkpoint).unwrap();
        assert_eq!(checkpointed.snapshot.project, edited);
        assert_eq!(checkpointed.snapshot.undo_depth, 0);
        assert_eq!(checkpointed.snapshot.redo_depth, 0);
        assert_eq!(checkpointed.authority.revision, 0);
        assert_ne!(checkpointed.authority.generation, before_checkpoint.generation);

        let reopened = recover_with_storage("golden-timeline", managed.storage.clone()).unwrap();
        assert_eq!(reopened.engine.project(), &edited);
        assert_eq!(reopened.recovered_operations, 0);
        assert_eq!(authority(&reopened), checkpointed.authority);
        assert!(require_authority(&reopened, &before_checkpoint).is_err());
    }
}
