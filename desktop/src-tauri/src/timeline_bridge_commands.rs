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
    let storage = TimelineStorage::for_project(project_id).map_err(TimelineBridgeError::message)?;
    let mut guard = lock_manager(&manager)?;
    authorize_checkpoint_replacement(guard.as_ref(), project_id, None, &storage)?;
    replace_with_checkpoint(&mut *guard, engine, storage)
}

#[tauri::command]
pub fn timeline_load(
    project: TimelineProject,
    expected_authority: Option<TimelineAuthority>,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineBridgeSnapshot, TimelineBridgeError> {
    let project_id = project.project_id.clone();
    let engine = TimelineEngine::new(project)
        .map_err(|issues| TimelineBridgeError::validation("Timeline project 未通过校验", issues))?;
    let storage = TimelineStorage::for_project(&project_id).map_err(TimelineBridgeError::message)?;
    let mut guard = lock_manager(&manager)?;
    authorize_checkpoint_replacement(
        guard.as_ref(),
        &project_id,
        expected_authority.as_ref(),
        &storage,
    )?;
    replace_with_checkpoint(&mut *guard, engine, storage)
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
    expected_authority: Option<TimelineAuthority>,
    manager: State<'_, TimelineManager>,
) -> Result<TimelineBridgeSnapshot, TimelineBridgeError> {
    let project_id = project.project_id.clone();
    let mut next_engine = TimelineEngine::new(project)
        .map_err(|issues| TimelineBridgeError::validation("Timeline proposal base 未通过校验", issues))?;
    apply_commands_transactionally(&mut next_engine, &commands)?;
    let storage = TimelineStorage::for_project(&project_id).map_err(TimelineBridgeError::message)?;
    let mut guard = lock_manager(&manager)?;
    authorize_checkpoint_replacement(
        guard.as_ref(),
        &project_id,
        expected_authority.as_ref(),
        &storage,
    )?;
    // A human-confirmed proposal becomes a fresh durable history boundary only
    // after the entire command batch validates and the current authority agrees.
    replace_with_checkpoint(&mut *guard, next_engine, storage)
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
