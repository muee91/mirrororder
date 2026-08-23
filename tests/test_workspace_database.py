from __future__ import annotations

from pathlib import Path

from script_organizer.workspace_db import WorkspaceDatabase, workspace_database_path


def _index() -> dict:
    return {
        "stats": {"clips": 2, "groups": 1},
        "groups": [
            {
                "group_id": "G_001",
                "start": 1.0,
                "end": 4.0,
                "duration": 3.0,
                "cameras": ["A", "B"],
                "members": [
                    {"clip_id": "C_A", "camera": "A", "source_start": 5.0, "source_end": 8.0},
                    {"clip_id": "C_B", "camera": "B", "source_start": 7.0, "source_end": 10.0},
                ],
                "kind": "multicam",
                "parent_group_id": "",
                "take_index": 1,
                "split_reason": "",
            }
        ],
    }


def test_workspace_database_is_device_local_and_isolated(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device"))

    left = WorkspaceDatabase("ws_left")
    right = WorkspaceDatabase("ws_right")

    assert left.path == workspace_database_path("ws_left")
    assert right.path == workspace_database_path("ws_right")
    assert left.path != right.path
    assert left.path.parent.parent.name == "workspaces"
    assert left.health()["quick_check"] == "ok"
    assert left.health()["schema_version"] == 1


def test_workspace_database_tracks_takes_frames_and_semantics(tmp_path: Path) -> None:
    database = WorkspaceDatabase("ws_demo", tmp_path / "workspace.sqlite3")
    result = database.sync_take_index(
        "project-a",
        name="Project A",
        input_kind="media-directory",
        config_path="projects/project-a/project.toml",
        index=_index(),
    )
    assert result == {"takes": 1, "removed": 0}
    assert database.project_intelligence("project-a")["takes"] == 1
    assert database.pending_groups("project-a") == ["G_001"]

    frame = tmp_path / "frame.jpg"
    frame.write_bytes(b"jpeg")
    database.replace_frames(
        "project-a",
        "G_001",
        [
            {
                "frame_id": "frm_1",
                "clip_id": "C_B",
                "camera": "B",
                "source_time": 8.5,
                "reason": "midpoint",
                "path": str(frame),
            }
        ],
    )
    assert database.pending_groups("project-a") == []
    assert database.project_intelligence("project-a")["framed_takes"] == 1

    database.set_semantic(
        "project-a",
        "G_001",
        {"location": "医院", "summary": "两人对话"},
        "ready",
    )
    semantic = database.semantic("project-a", "G_001")
    assert semantic["status"] == "ready"
    assert semantic["data"]["location"] == "医院"
    assert database.project_intelligence("project-a")["semantic_takes"] == 1


def test_workspace_database_reserves_local_face_and_speaker_identity_records(tmp_path: Path) -> None:
    database = WorkspaceDatabase("ws_demo", tmp_path / "workspace.sqlite3")
    database.sync_take_index(
        "project-a",
        name="Project A",
        input_kind="fcpxml",
        config_path="projects/project-a/project.toml",
        index=_index(),
    )
    database.upsert_identity(
        "project-a",
        identity_id="face_actor_01",
        kind="face",
        label="演员01",
        role_name="角色A",
    )
    database.add_identity_observation(
        "project-a",
        "G_001",
        kind="face",
        identity_id="face_actor_01",
        clip_id="C_B",
        confidence=0.95,
        embedding=b"local-only-vector",
    )
    database.add_identity_observation(
        "project-a",
        "G_001",
        kind="speaker",
        clip_id="C_B",
        start=0.2,
        end=2.1,
        confidence=0.80,
    )
    summary = database.project_intelligence("project-a")
    assert summary["face_observations"] == 1
    assert summary["speaker_observations"] == 1
