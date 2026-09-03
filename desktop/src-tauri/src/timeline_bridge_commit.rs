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
