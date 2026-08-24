use crate::persistence::{
    journal_entry, JournalOperation, PersistenceStatus, TimelineStorage,
};
use mirrororder_timeline_core::{
    validate_project, Command, TimelineEngine, TimelineProject, TimelineSnapshot, ValidationIssue,
};
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Clone)]
struct ManagedTimeline {
    engine: TimelineEngine,
    storage: TimelineStorage,
    next_sequence: u64,
    recovered_operations: usize,
    used_backup: bool,
    ignored_partial_tail: bool,
}

#[derive(Debug, Default)]
pub struct TimelineManager {
    current: Mutex<Option<ManagedTimeline>>,
}

#[derive(Debug, Serialize)]
pub struct TimelineBridgeError {
    message: String,
    issues: Vec<ValidationIssue>,
}

#[derive(Debug, Serialize)]
pub struct TimelineRuntimeStatus {
    project_id: String,
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

fn lock_manager(
    manager: &State<'_, TimelineManager>,
) -> Result<std::sync::MutexGuard<'_, Option<ManagedTimeline>>, TimelineBridgeError> {
    manager
        .current
        .lock()
        .map_err(|_| TimelineBridgeError::message("Timeline Core 状态锁已损坏"))
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
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    let project_id = engine.project().project_id.clone();
    let storage = TimelineStorage::for_project(&project_id).map_err(TimelineBridgeError::message)?;
    storage
        .write_checkpoint(engine.project())
        .map_err(TimelineBridgeError::message)?;
    let snapshot = engine.snapshot();
    *lock_manager(manager)? = Some(ManagedTimeline {
        engine,
        storage,
        next_sequence: 1,
        recovered_operations: 0,
        used_backup: false,
        ignored_partial_tail: false,
    });
    Ok(snapshot)
}

fn commit_operation(
    managed: &mut ManagedTimeline,
    operation: JournalOperation,
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    // Validate on a clone first. Only a journaled operation is allowed to
    // become the new in-memory authority.
    let mut candidate = managed.engine.clone();
    let snapshot = apply_operation(&mut candidate, &operation)?;
    let sequence = managed.next_sequence;
    managed
        .storage
        .append(&journal_entry(sequence, operation))
        .map_err(TimelineBridgeError::message)?;
    managed.engine = candidate;
    managed.next_sequence = sequence.saturating_add(1);
    Ok(snapshot)
}

fn recover_managed(project_id: &str) -> Result<ManagedTimeline, TimelineBridgeError> {
    let storage = TimelineStorage::for_project(project_id).map_err(TimelineBridgeError::message)?;
    if !storage.exists() {
        return Err(TimelineBridgeError::message(format!(
            "项目 {project_id} 还没有持久化 Timeline"
        )));
    }
    let (project, used_backup) = storage
        .load_checkpoint()
        .map_err(TimelineBridgeError::message)?;
    let mut engine = TimelineEngine::new(project)
        .map_err(|issues| TimelineBridgeError::validation("持久化 Timeline checkpoint 未通过校验", issues))?;
    let journal = storage.read_journal().map_err(TimelineBridgeError::message)?;
    let mut previous_sequence = 0u64;
    for entry in &journal.entries {
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
    }
    Ok(ManagedTimeline {
        engine,
        storage,
        next_sequence: previous_sequence.saturating_add(1).max(1),
        recovered_operations: journal.entries.len(),
        used_backup,
        ignored_partial_tail: journal.ignored_partial_tail,
    })
}

#[tauri::command]
pub fn timeline_new(
    project_id: String,
    sequence_id: String,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineSnapshot, TimelineBridgeError> {
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
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    let engine = TimelineEngine::new(project)
        .map_err(|issues| TimelineBridgeError::validation("Timeline project 未通过校验", issues))?;
    replace_with_checkpoint(&manager, engine)
}

#[tauri::command]
pub fn timeline_open_persisted(
    project_id: String,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    let project_id = project_id.trim();
    if project_id.is_empty() {
        return Err(TimelineBridgeError::message("恢复 Timeline 需要 project_id"));
    }
    let managed = recover_managed(project_id)?;
    let snapshot = managed.engine.snapshot();
    *lock_manager(&manager)? = Some(managed);
    Ok(snapshot)
}

#[tauri::command]
pub fn timeline_load_with_commands(
    project: TimelineProject,
    commands: Vec<Command>,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    let mut next_engine = TimelineEngine::new(project)
        .map_err(|issues| TimelineBridgeError::validation("Timeline proposal base 未通过校验", issues))?;
    apply_commands_transactionally(&mut next_engine, &commands)?;
    // A human-confirmed proposal becomes a fresh checkpoint only after the
    // whole batch validates. Existing persisted state remains intact on error.
    replace_with_checkpoint(&manager, next_engine)
}

#[tauri::command]
pub fn timeline_snapshot(
    manager: State<'_, TimelineManager>,
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    lock_manager(&manager)?
        .as_ref()
        .map(|managed| managed.engine.snapshot())
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))
}

#[tauri::command]
pub fn timeline_apply(
    command: Command,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    let mut guard = lock_manager(&manager)?;
    let managed = guard
        .as_mut()
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))?;
    commit_operation(managed, JournalOperation::Apply { command })
}

#[tauri::command]
pub fn timeline_apply_batch(
    commands: Vec<Command>,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    let mut guard = lock_manager(&manager)?;
    let managed = guard
        .as_mut()
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))?;
    commit_operation(managed, JournalOperation::ApplyBatch { commands })
}

#[tauri::command]
pub fn timeline_undo(
    manager: State<'_, TimelineManager>,
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    let mut guard = lock_manager(&manager)?;
    let managed = guard
        .as_mut()
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))?;
    commit_operation(managed, JournalOperation::Undo)
}

#[tauri::command]
pub fn timeline_redo(
    manager: State<'_, TimelineManager>,
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    let mut guard = lock_manager(&manager)?;
    let managed = guard
        .as_mut()
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))?;
    commit_operation(managed, JournalOperation::Redo)
}

#[tauri::command]
pub fn timeline_checkpoint(
    manager: State<'_, TimelineManager>,
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    let mut guard = lock_manager(&manager)?;
    let managed = guard
        .as_mut()
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))?;
    managed
        .storage
        .write_checkpoint(managed.engine.project())
        .map_err(TimelineBridgeError::message)?;
    managed.next_sequence = 1;
    managed.recovered_operations = 0;
    managed.used_backup = false;
    managed.ignored_partial_tail = false;
    Ok(managed.engine.snapshot())
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
        persistence: managed.storage.status().map_err(TimelineBridgeError::message)?,
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

    #[test]
    fn transactional_batch_rolls_back_the_candidate() {
        let mut project = TimelineProject::empty("p1", "main");
        project.sources = vec![mirrororder_timeline_core::Source {
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
            clip: mirrororder_timeline_core::TimelineClip {
                clip_id: "bad".to_string(),
                source_id: "missing".to_string(),
                timeline_start: 0,
                source_in: 0,
                duration: 10,
                enabled: true,
                multicam_group_id: None,
                selected_angle_source_id: None,
                metadata: Default::default(),
            },
        }];
        assert!(apply_commands_transactionally(&mut engine, &commands).is_err());
        assert!(engine.project().sequences[0].tracks[0].clips.is_empty());
    }
}
