from __future__ import annotations

import json
from pathlib import Path

from script_organizer.identity_index import IdentityIndexer
from script_organizer.workspace_db import WorkspaceDatabase


def test_fully_human_confirmed_identity_group_stays_cached(tmp_path: Path) -> None:
    database = WorkspaceDatabase("ws", tmp_path / "workspace.sqlite3")
    database.sync_take_index(
        "project",
        name="demo",
        input_kind="media-directory",
        config_path=str(tmp_path / "project.toml"),
        index={
            "stats": {"groups": 1},
            "groups": [
                {
                    "group_id": "G1",
                    "start": 0.0,
                    "end": 2.0,
                    "duration": 2.0,
                    "cameras": ["A"],
                    "members": [],
                }
            ],
        },
    )
    database.upsert_identity(
        "project",
        identity_id="face_known",
        kind="face",
        label="演员甲",
        role_name="王总",
        metadata={"human_confirmed": True},
    )
    database.add_identity_observation(
        "project",
        "G1",
        kind="face",
        identity_id="face_known",
        confidence=0.96,
        metadata={"camera": "A"},
    )

    indexer = object.__new__(IdentityIndexer)
    indexer.database = database
    indexer.project_id = "project"
    assert indexer._fully_human_labeled("face", "G1") is True
    assert indexer._already_indexed("face", "G1") is True


def test_partially_confirmed_group_is_not_marked_fully_human_labeled(tmp_path: Path) -> None:
    database = WorkspaceDatabase("ws", tmp_path / "workspace.sqlite3")
    database.sync_take_index(
        "project",
        name="demo",
        input_kind="media-directory",
        config_path=str(tmp_path / "project.toml"),
        index={
            "stats": {"groups": 1},
            "groups": [
                {
                    "group_id": "G1",
                    "start": 0.0,
                    "end": 2.0,
                    "duration": 2.0,
                    "cameras": ["A", "B"],
                    "members": [],
                }
            ],
        },
    )
    database.upsert_identity(
        "project",
        identity_id="face_known",
        kind="face",
        label="演员甲",
        metadata={"human_confirmed": True},
    )
    database.upsert_identity(
        "project",
        identity_id="face_unknown",
        kind="face",
        label="人物候选 02",
        metadata={"auto_cluster": True},
    )
    database.add_identity_observation(
        "project", "G1", kind="face", identity_id="face_known", confidence=0.96
    )
    database.add_identity_observation(
        "project", "G1", kind="face", identity_id="face_unknown", confidence=0.91
    )
    indexer = object.__new__(IdentityIndexer)
    indexer.database = database
    indexer.project_id = "project"
    assert indexer._fully_human_labeled("face", "G1") is False


def test_material_cards_expose_per_clip_shot_scale_without_ai_branding() -> None:
    root = Path(__file__).resolve().parents[1]
    ui = (root / "web" / "intelligence_ui.js").read_text(encoding="utf-8")
    css = (root / "web" / "intelligence.css").read_text(encoding="utf-8")
    html = (root / "web" / "index.html").read_text(encoding="utf-8")
    review_model = (root / "web" / "review_model.js").read_text(encoding="utf-8")

    assert "data-member-clip" in ui
    assert "wide: '全景'" in ui
    assert "closeup: '近景'" in ui
    assert "extreme_closeup: '特写'" in ui
    assert "角色候选" in ui
    assert "shot-chip" in css
    assert "/intelligence.css" in html
    assert "/intelligence_ui.js" in html
    assert "auditChanged" in review_model
    assert "audit_revision" in review_model
    assert "AI" not in css


def test_audit_runtime_is_host_only_and_not_review_authority() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "src" / "script_organizer" / "audit_runtime.py").read_text(encoding="utf-8")
    engine = (root / "src" / "script_organizer" / "audit_engine.py").read_text(encoding="utf-8")
    invariants = (root / "docs" / "engineering" / "INVARIANTS.md").read_text(encoding="utf-8")

    assert 'tasks_module.TASK_TYPES.add("audit")' in runtime
    assert "self._local_only()" in runtime
    assert '"audit_is_review_authority": False' in runtime
    assert "review.json" not in engine.split("class AuditEngine", 1)[1].split("def _inputs", 1)[0]
    assert "evidence → proposal → human confirmation → authority" in invariants
    assert "AI proposal、Audit、semantic score 或 Team Web opinion" in invariants
    assert "Final Editorial Decision、Review placement 或 Rust Timeline authority" in invariants
