from __future__ import annotations

import json
from pathlib import Path

from script_organizer.automation_store import AutomationStore
from script_organizer.config import ProjectConfig
from script_organizer.identity_library import IdentityLibrary
from script_organizer.identity_rescue import apply_identity_rescue
from script_organizer.workspace_db import WorkspaceDatabase


def _setup(monkeypatch, tmp_path: Path, status: str = "needs_review"):
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device"))
    project = tmp_path / "project"
    output = project / "output"
    transcripts = project / "cache" / "transcripts"
    inputs = project / "inputs"
    output.mkdir(parents=True)
    transcripts.mkdir(parents=True)
    inputs.mkdir(parents=True)
    script_path = inputs / "script.md"
    script_path.write_text("第1集\n1-1 内景\n王强：你好\n", encoding="utf-8")
    config_path = project / "project.toml"
    config_path.write_text("[project]\nname='demo'\n", encoding="utf-8")
    config = ProjectConfig(
        config_path=config_path,
        name="demo",
        fcpxml=None,
        script=script_path,
        output_dir=output,
        transcript_dir=transcripts,
        input_kind="media-directory",
        media_root=None,
    )
    material = {
        "stats": {"groups": 1, "clips": 0},
        "groups": [
            {
                "group_id": "G1",
                "start": 0.0,
                "end": 2.0,
                "duration": 2.0,
                "cameras": [],
                "members": [],
            }
        ],
    }
    (output / "material_index.json").write_text(json.dumps(material), encoding="utf-8")
    (output / "script.json").write_text(
        json.dumps(
            {
                "segments": [
                    {
                        "segment_id": "S1",
                        "episode": 1,
                        "order": 1,
                        "speaker": "王强",
                        "type": "dialogue",
                        "text": "你好",
                    }
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    matches = {
        "groups": {
            "G1": {
                "candidates": [
                    {
                        "candidate_id": "C1",
                        "script_segment_ids": ["S1"],
                        "total_score": 0.56,
                        "dialogue_score": 0.42,
                    }
                ]
            }
        }
    }
    matches_path = output / "matches.json"
    matches_path.write_text(json.dumps(matches, ensure_ascii=False, indent=2), encoding="utf-8")
    decision = {
        "status": status,
        "mapping_status": "confirmed" if status == "human_override" else "ambiguous",
        "mapping_source": "human" if status == "human_override" else "deterministic",
        "script_segment_ids": ["S1"] if status == "human_override" else [],
        "confidence": 1.0 if status == "human_override" else 0.56,
        "reason": "人工确认" if status == "human_override" else "待确认",
        "evidence": {},
    }
    AutomationStore(output).save("rev1", {"G1": decision}, {})

    database = WorkspaceDatabase("ws")
    database.sync_take_index(
        "project",
        name="demo",
        input_kind="media-directory",
        config_path=str(config_path),
        index=material,
    )
    database.upsert_identity(
        "project",
        identity_id="speaker_1",
        kind="speaker",
        label="声音候选 01",
    )
    database.add_identity_observation(
        "project",
        "G1",
        kind="speaker",
        identity_id="speaker_1",
        confidence=0.96,
        embedding=b"local-private-vector",
    )
    IdentityLibrary(database, "project").update(
        "speaker_1", label="演员甲", role_name="王强"
    )
    return config, matches_path, decision


def test_identity_rescue_never_rewrites_matches_json(monkeypatch, tmp_path: Path) -> None:
    config, matches_path, _decision = _setup(monkeypatch, tmp_path)
    before = matches_path.read_bytes()
    result = apply_identity_rescue(config)
    after = matches_path.read_bytes()
    assert before == after
    assert result["groups"]["G1"]["mapping_source"] == "identity_rescue"


def test_identity_rescue_never_overrides_human_mapping(monkeypatch, tmp_path: Path) -> None:
    config, matches_path, original = _setup(monkeypatch, tmp_path, status="human_override")
    before_matches = matches_path.read_bytes()
    result = apply_identity_rescue(config)
    assert result["groups"]["G1"] == original
    assert matches_path.read_bytes() == before_matches
