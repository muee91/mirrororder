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

    fn angle(id: &str, start: i64, end: i64) -> MulticamAngle {
        MulticamAngle {
            source_id: id.to_string(),
            camera: id.to_uppercase(),
            name: format!("{id}.mov"),
            sync_start_frame: Some(start),
            sync_end_frame: Some(end),
        }
    }

    fn multicam(group_id: &str, angles: Vec<MulticamAngle>) -> MulticamGroup {
        MulticamGroup {
            group_id: group_id.to_string(),
            angle_source_ids: angles.iter().map(|angle| angle.source_id.clone()).collect(),
            reference_source_id: angles.first().map(|angle| angle.source_id.clone()),
            angles,
            audio_source_id: None,
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

    fn marker(id: &str, position: i64) -> Marker {
        Marker {
            marker_id: id.to_string(),
            position,
            duration: 0,
            kind: "standard".to_string(),
            label: String::new(),
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
    fn unknown_project_version_is_not_silently_coerced() {
        let mut project = project();
        project.version = 99;
        let issues = TimelineEngine::new(project).unwrap_err();
        assert!(issues.iter().any(|issue| issue.code == "unsupported_version"));
    }

    #[test]
    fn v1_multicam_membership_normalizes_into_v2_angles() {
        let mut project = project();
        project.version = 1;
        project.multicam_groups = vec![MulticamGroup {
            group_id: "mc1".to_string(),
            angle_source_ids: vec!["s1".to_string(), "s2".to_string()],
            angles: Vec::new(),
            reference_source_id: None,
            audio_source_id: None,
        }];
        let engine = TimelineEngine::new(project).unwrap();
        let group = &engine.project().multicam_groups[0];
        assert_eq!(engine.project().version, TIMELINE_PROJECT_VERSION);
        assert_eq!(group.angles.len(), 2);
        assert_eq!(group.angle_source_ids, vec!["s1".to_string(), "s2".to_string()]);
        assert_eq!(group.reference_source_id.as_deref(), Some("s1"));
    }

    #[test]
    fn typed_multicam_sync_ranges_are_validated() {
        let mut project = project();
        project.multicam_groups = vec![multicam("mc1", vec![angle("s1", 10, 100), angle("s2", 120, 220)])];
        assert!(validate_project(&project).is_empty());
        project.multicam_groups[0].angles[1].sync_end_frame = Some(900);
        assert!(validate_project(&project)
            .iter()
            .any(|issue| issue.code == "multicam_sync_range_exceeded"));
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
    fn replace_take_preserves_edit_geometry_and_updates_take_identity() {
        let mut project = project();
        project.multicam_groups = vec![multicam("g2", vec![angle("s2", 100, 300), angle("s3", 20, 220)])];
        let mut base = clip("take", "s1", 48, 10, 40);
        base.metadata.insert("group_id".to_string(), "g1".to_string());
        base.metadata.insert("segment_id".to_string(), "E1_SC1_S1".to_string());
        project.sequences[0].tracks[0].clips = vec![base];
        let mut engine = TimelineEngine::new(project).unwrap();
        engine
            .apply(Command::ReplaceTake {
                sequence_id: "seq1".to_string(),
                clip_id: "take".to_string(),
                group_id: "g2".to_string(),
                source_id: "s2".to_string(),
                source_in: 120,
            })
            .unwrap();
        let replaced = &engine.project().sequences[0].tracks[0].clips[0];
        assert_eq!(replaced.timeline_start, 48);
        assert_eq!(replaced.duration, 40);
        assert_eq!(replaced.source_id, "s2");
        assert_eq!(replaced.source_in, 120);
        assert_eq!(replaced.multicam_group_id.as_deref(), Some("g2"));
        assert_eq!(replaced.selected_angle_source_id.as_deref(), Some("s2"));
        assert_eq!(replaced.metadata.get("group_id").map(String::as_str), Some("g2"));
        assert_eq!(replaced.metadata.get("segment_id").map(String::as_str), Some("E1_SC1_S1"));
        engine.undo().unwrap();
        assert_eq!(engine.project().sequences[0].tracks[0].clips[0].source_id, "s1");
    }

    #[test]
    fn replace_take_fails_closed_when_replacement_cannot_cover_current_duration() {
        let mut project = project();
        project.sources[1].duration_frames = Some(130);
        project.sequences[0].tracks[0].clips = vec![clip("take", "s1", 0, 0, 40)];
        let mut engine = TimelineEngine::new(project).unwrap();
        assert!(engine
            .apply(Command::ReplaceTake {
                sequence_id: "seq1".to_string(),
                clip_id: "take".to_string(),
                group_id: "g2".to_string(),
                source_id: "s2".to_string(),
                source_in: 100,
            })
            .is_err());
        assert_eq!(engine.project().sequences[0].tracks[0].clips[0].source_id, "s1");
    }

    #[test]
    fn multicam_switch_requires_an_angle_from_the_group() {
        let mut project = project();
        project.multicam_groups = vec![multicam("mc1", vec![angle("s1", 0, 200), angle("s2", 0, 200)])];
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
    fn marker_is_upserted_with_typed_metadata_and_disable_is_undoable() {
        let mut project = project();
        project.sequences[0].tracks[0].clips = vec![clip("a", "s1", 0, 0, 20)];
        let mut engine = TimelineEngine::new(project).unwrap();
        let mut typed = marker("m1", 12);
        typed.duration = 8;
        typed.kind = "script".to_string();
        typed.label = "beat".to_string();
        typed.metadata.insert("script_segment_id".to_string(), "s1".to_string());
        engine
            .apply(Command::SetMarker {
                sequence_id: "seq1".to_string(),
                marker: typed,
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
        let marker = &engine.project().sequences[0].markers[0];
        assert_eq!(marker.label, "beat");
        assert_eq!(marker.duration, 8);
        assert_eq!(marker.kind, "script");
        assert_eq!(marker.metadata.get("script_segment_id").map(String::as_str), Some("s1"));
    }

    #[test]
    fn validation_catches_source_range_and_track_overlap() {
        let mut project = project();
        project.sequences[0].tracks[0].clips = vec![clip("a", "s1", 0, 480, 30), clip("b", "s2", 10, 0, 20)];
        let issues = validate_project(&project);
        assert!(issues.iter().any(|issue| issue.code == "source_range_exceeded"));
        assert!(issues.iter().any(|issue| issue.code == "track_overlap"));
    }
