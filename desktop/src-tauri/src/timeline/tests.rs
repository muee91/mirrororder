
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
            angles: Vec::new(),
            reference_source_id: None,
            audio_source_id: None,
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
    fn checkpoint_replacement_requires_the_current_rust_authority() {
        let managed = managed(golden_project());
        let storage = managed.storage.clone();
        let current = Some(&managed);

        let missing = authorize_checkpoint_replacement(current, "golden-timeline", None, &storage)
            .unwrap_err();
        assert_eq!(missing.issues[0].code, "timeline_authority_required");

        let mut stale = authority(&managed);
        stale.revision = stale.revision.saturating_add(1);
        let stale_error = authorize_checkpoint_replacement(
            current,
            "golden-timeline",
            Some(&stale),
            &storage,
        )
        .unwrap_err();
        assert_eq!(stale_error.issues[0].code, "stale_timeline_authority");

        assert!(authorize_checkpoint_replacement(
            current,
            "golden-timeline",
            Some(&authority(&managed)),
            &storage,
        )
        .is_ok());
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
                        duration: 0,
                        kind: "standard".to_string(),
                        label: "stale".to_string(),
                        metadata: BTreeMap::new(),
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
