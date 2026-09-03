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

fn authorize_checkpoint_replacement(
    current: Option<&ManagedTimeline>,
    project_id: &str,
    expected: Option<&TimelineAuthority>,
    storage: &TimelineStorage,
) -> Result<(), TimelineBridgeError> {
    if let Some(managed) = current {
        if managed.engine.project().project_id == project_id {
            let expected = expected.ok_or_else(|| {
                TimelineBridgeError::validation(
                    "Timeline 已存在；替换 checkpoint 必须基于最新 Rust snapshot",
                    vec![ValidationIssue {
                        code: "timeline_authority_required".to_string(),
                        path: "authority".to_string(),
                        message: format!("project {project_id} 已加载，缺少 expected authority"),
                    }],
                )
            })?;
            return require_authority(managed, expected);
        }
    }

    if storage.exists() {
        return Err(TimelineBridgeError::validation(
            "Timeline 已持久化；请先恢复最新 snapshot，再明确执行替换",
            vec![ValidationIssue {
                code: "timeline_authority_required".to_string(),
                path: "authority".to_string(),
                message: format!("project {project_id} 已有 persisted Timeline，必须先 openPersisted"),
            }],
        ));
    }
    Ok(())
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
    current: &mut Option<ManagedTimeline>,
    engine: TimelineEngine,
    storage: TimelineStorage,
) -> Result<TimelineBridgeSnapshot, TimelineBridgeError> {
    let project = engine.project().clone();
    let project_id = project.project_id.clone();
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
    *current = Some(managed);
    Ok(snapshot)
}
