use mirrororder_timeline_core::{
    validate_project, Command, TimelineEngine, TimelineProject, TimelineSnapshot, ValidationIssue,
};
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Default)]
pub struct TimelineManager {
    engine: Mutex<Option<TimelineEngine>>,
}

#[derive(Debug, Serialize)]
pub struct TimelineBridgeError {
    message: String,
    issues: Vec<ValidationIssue>,
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
) -> Result<std::sync::MutexGuard<'_, Option<TimelineEngine>>, TimelineBridgeError> {
    manager
        .engine
        .lock()
        .map_err(|_| TimelineBridgeError::message("Timeline Core 状态锁已损坏"))
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
    let snapshot = engine.snapshot();
    *lock_manager(&manager)? = Some(engine);
    Ok(snapshot)
}

#[tauri::command]
pub fn timeline_load(
    project: TimelineProject,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    let engine = TimelineEngine::new(project)
        .map_err(|issues| TimelineBridgeError::validation("Timeline project 未通过校验", issues))?;
    let snapshot = engine.snapshot();
    *lock_manager(&manager)? = Some(engine);
    Ok(snapshot)
}

#[tauri::command]
pub fn timeline_snapshot(
    manager: State<'_, TimelineManager>,
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    lock_manager(&manager)?
        .as_ref()
        .map(TimelineEngine::snapshot)
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))
}

#[tauri::command]
pub fn timeline_apply(
    command: Command,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    let mut guard = lock_manager(&manager)?;
    let engine = guard
        .as_mut()
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))?;
    engine
        .apply(command)
        .map_err(|issues| TimelineBridgeError::validation("Timeline Command 被拒绝", issues))
}

#[tauri::command]
pub fn timeline_apply_batch(
    commands: Vec<Command>,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    let mut guard = lock_manager(&manager)?;
    let engine = guard
        .as_mut()
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))?;
    if commands.is_empty() {
        return Ok(engine.snapshot());
    }
    let checkpoint = engine.clone();
    for command in commands {
        if let Err(issues) = engine.apply(command) {
            *engine = checkpoint;
            return Err(TimelineBridgeError::validation(
                "Timeline command batch 被拒绝；已完整回滚",
                issues,
            ));
        }
    }
    Ok(engine.snapshot())
}

#[tauri::command]
pub fn timeline_undo(
    manager: State<'_, TimelineManager>,
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    let mut guard = lock_manager(&manager)?;
    let engine = guard
        .as_mut()
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))?;
    engine.undo().map_err(TimelineBridgeError::message)
}

#[tauri::command]
pub fn timeline_redo(
    manager: State<'_, TimelineManager>,
) -> Result<TimelineSnapshot, TimelineBridgeError> {
    let mut guard = lock_manager(&manager)?;
    let engine = guard
        .as_mut()
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))?;
    engine.redo().map_err(TimelineBridgeError::message)
}

#[tauri::command]
pub fn timeline_validate(
    manager: State<'_, TimelineManager>,
) -> Result<Vec<ValidationIssue>, TimelineBridgeError> {
    let guard = lock_manager(&manager)?;
    let engine = guard
        .as_ref()
        .ok_or_else(|| TimelineBridgeError::message("尚未创建或加载 Timeline"))?;
    Ok(validate_project(engine.project()))
}
