from __future__ import annotations

import json
from pathlib import Path

from script_organizer.automation_store import AutomationStore
from script_organizer.config import ProjectConfig
from script_organizer.identity_library import IdentityLibrary
from script_organizer.workspace_db import WorkspaceDatabase


def test_role_edit_revokes_stale_identity_confirmed_mapping(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device"))
    project = tmp_path / "project"
    output = project / "output"
    inputs = project / "inputs"
    transcripts = project / "cache" / "transcripts"
    output.mkdir(parents=True)
    inputs.mkdir(parents=True)
    transcripts.mkdir(parents=True)
    script_path = inputs / "script.md"
    script_path.write_text("第1集\n1-1 内景\n王强：你好\n", encoding="utf-8")
    config_path = project / "project.toml"
    config_path.write_text(
        "[project]\nname='demo'\n\n[input]\nkind='media-directory'\nscript='./inputs/script.md'\n\n[output]\ndirectory='./output'\n\n[asr]\ntranscript_dir='./cache/transcripts'\n",
        encoding="utf-8",
    )
    config = ProjectConfig.from_file(config_path)
    material = {
        "stats": {"groups": 1, "clips": 0},
        "groups": [{"group_id": "G1", "start": 0.0, "end": 2.0, "duration": 2.0, "cameras": [], "members": []}],
    }
    (output / "material_index.json").write_text(json.dumps(material), encoding="utf-8")
    (output / "script.json").write_text(
        json.dumps({"segments": [{"segment_id": "S1", "episode": 1, "order": 1, "speaker": "王强", "type": "dialogue", "text": "你好"}]}, ensure_ascii=False),
        encoding="utf-8",
    )
    matches_path = output / "matches.json"
    matches_path.write_text(
        json.dumps({"groups": {"G1": {"candidates": [{"candidate_id": "C1", "script_segment_ids": ["S1"], "total_score": 0.58, "dialogue_score": 0.45}]}}}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    matches_before = matches_path.read_bytes()
    AutomationStore(output).save(
        "rev1",
        {"G1": {"status": "needs_review", "mapping_status": "ambiguous", "mapping_source": "deterministic", "confidence": 0.58, "reason": "待确认", "evidence": {}}},
        {},
    )

    database = WorkspaceDatabase("ws")
    database.sync_take_index(
        "project", name="demo", input_kind="media-directory",
        config_path=str(config.config_path), index=material,
    )
    database.upsert_identity("project", identity_id="speaker_1", kind="speaker", label="声音候选 01")
    database.add_identity_observation(
        "project",
        "G1",
        kind="speaker",
        identity_id="speaker_1",
        confidence=1.0,
        embedding=b"private-vector",
        metadata={"cluster_similarity": 0.94},
    )
    library = IdentityLibrary(database, "project")

    library.update("speaker_1", label="演员甲", role_name="王强")
    promoted = AutomationStore(output).load()["groups"]["G1"]
    assert promoted["status"] == "ai_confirmed"
    assert promoted["mapping_source"] == "identity_rescue"
    assert promoted["evidence"]["identity_baseline"]["status"] == "needs_review"

    library.update("speaker_1", label="演员甲", role_name="李四")
    reverted = AutomationStore(output).load()["groups"]["G1"]
    assert reverted["status"] == "needs_review"
    assert reverted["mapping_status"] == "ambiguous"
    assert reverted["mapping_source"] == "deterministic"
    assert matches_path.read_bytes() == matches_before
