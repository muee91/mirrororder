from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from script_organizer.audit_engine import AuditEngine
from script_organizer.audit_provider import TakeAuditProvider
from script_organizer.audit_store import AuditStore
from script_organizer.automation_store import AutomationStore
from script_organizer.config import ProjectConfig
from script_organizer.identity_library import IdentityLibrary
from script_organizer.learning_dataset import write_learning_dataset
from script_organizer.workspace_db import WorkspaceDatabase


def _config(tmp_path: Path) -> ProjectConfig:
    project = tmp_path / "project"
    output = project / "output"
    cache = project / "cache" / "transcripts"
    inputs = project / "inputs"
    output.mkdir(parents=True)
    cache.mkdir(parents=True)
    inputs.mkdir(parents=True)
    script = inputs / "script.md"
    script.write_text("第1集\n1-1 室内\n王总：你好我是王总\n", encoding="utf-8")
    config_path = project / "project.toml"
    config_path.write_text("[project]\nname='demo'\n", encoding="utf-8")
    return ProjectConfig(
        config_path=config_path,
        name="demo",
        fcpxml=None,
        script=script,
        output_dir=output,
        transcript_dir=cache,
        input_kind="media-directory",
        media_root=None,
    )


def _material() -> dict:
    return {
        "stats": {"groups": 1, "clips": 2},
        "groups": [
            {
                "group_id": "G1",
                "start": 0.0,
                "end": 3.0,
                "duration": 3.0,
                "cameras": ["A", "B"],
                "members": [
                    {
                        "clip_id": "CA",
                        "camera": "A",
                        "name": "A001.mov",
                        "media_path": "/Volumes/SECRET/A001.mov",
                        "duration": 3.0,
                        "source_start": 0.0,
                        "source_end": 3.0,
                    },
                    {
                        "clip_id": "CB",
                        "camera": "B",
                        "name": "B001.mov",
                        "media_path": "/Volumes/SECRET/B001.mov",
                        "duration": 3.0,
                        "source_start": 0.0,
                        "source_end": 3.0,
                    },
                ],
                "kind": "multicam",
                "parent_group_id": "",
                "take_index": 1,
                "split_reason": "",
            }
        ],
        "clips": [],
    }


def test_audit_store_is_rebuildable_revisioned_evidence(tmp_path: Path) -> None:
    store = AuditStore(tmp_path)
    initial = store.load()
    assert initial["contract"] == "audit.v1"
    assert initial["revision"] == 0

    first = store.save({"analysis_revision": "rev-a", "groups": {"G1": {"judge": {"verdict": "agree"}}}})
    second = store.save({"analysis_revision": "rev-a", "groups": {"G1": {"judge": {"verdict": "disagree"}}}})
    assert first["revision"] == 1
    assert second["revision"] == 2
    assert store.load()["groups"]["G1"]["judge"]["verdict"] == "disagree"


def test_script_dialogue_can_suggest_unconfirmed_speaker_role_but_not_face(tmp_path: Path) -> None:
    config = _config(tmp_path)
    material = _material()
    database = WorkspaceDatabase("ws", tmp_path / "workspace.sqlite3")
    database.sync_take_index(
        "project",
        name="demo",
        input_kind="media-directory",
        config_path=str(config.config_path),
        index=material,
    )
    database.upsert_identity(
        "project",
        identity_id="speaker_1",
        kind="speaker",
        label="声音候选 01",
        metadata={"auto_cluster": True},
    )
    database.add_identity_observation(
        "project",
        "G1",
        kind="speaker",
        identity_id="speaker_1",
        confidence=0.94,
        metadata={"text": "你好我是王总"},
    )
    # A face observation with the same convenient text metadata must not be used
    # for script-role inference. Multicam may be showing a listener/reaction.
    database.upsert_identity(
        "project",
        identity_id="face_1",
        kind="face",
        label="人物候选 01",
        metadata={"auto_cluster": True},
    )
    database.add_identity_observation(
        "project",
        "G1",
        kind="face",
        identity_id="face_1",
        confidence=0.98,
        metadata={"text": "你好我是王总"},
    )

    engine = AuditEngine("ws", "project", config, database=database)
    segments = {
        "S1": {
            "segment_id": "S1",
            "episode": 1,
            "scene_id": "SC1",
            "order": 1,
            "speaker": "王总",
            "text": "你好我是王总",
        }
    }
    suggestions = engine._role_suggestions(
        "G1",
        {"source": "human", "confidence": 1.0, "script_segment_ids": ["S1"]},
        segments,
    )
    assert len(suggestions) == 1
    assert suggestions[0]["identity_id"] == "speaker_1"
    assert suggestions[0]["kind"] == "speaker"
    assert suggestions[0]["role_name"] == "王总"
    assert suggestions[0]["requires_confirmation"] is True
    assert all(item["identity_id"] != "face_1" for item in suggestions)

    IdentityLibrary(database, "project").update("speaker_1", label="演员甲", role_name="王总")
    assert engine._role_suggestions(
        "G1",
        {"source": "human", "confidence": 1.0, "script_segment_ids": ["S1"]},
        segments,
    ) == []


def test_multicam_shot_type_is_sanitized_per_clip_id() -> None:
    provider = object.__new__(TakeAuditProvider)
    provider.config = SimpleNamespace(provider="fake", model="fake-model")
    result = provider._sanitize(
        {
            "verdict": "agree",
            "confidence": 0.9,
            "angles": [
                {"clip_id": "CA", "camera": "A", "shot_type": "wide", "coverage_role": "master"},
                {"clip_id": "CB", "camera": "B", "shot_type": "closeup", "coverage_role": "reaction"},
                {"clip_id": "NOT_SUPPLIED", "camera": "C", "shot_type": "extreme_closeup"},
            ],
            "rough_cut": {},
        },
        [{"clip_id": "CA"}, {"clip_id": "CB"}],
    )
    angles = {item["clip_id"]: item for item in result["angles"]}
    assert set(angles) == {"CA", "CB"}
    assert angles["CA"]["shot_type"] == "wide"
    assert angles["CB"]["shot_type"] == "closeup"
    assert angles["CA"]["coverage_role"] == "master"
    assert angles["CB"]["coverage_role"] == "reaction"


def test_learning_cases_collect_hard_cases_without_media_paths(tmp_path: Path) -> None:
    config = _config(tmp_path)
    material = _material()
    (config.output_dir / "material_index.json").write_text(json.dumps(material), encoding="utf-8")
    (config.output_dir / "matches.json").write_text(
        json.dumps(
            {
                "groups": {
                    "G1": {
                        "candidates": [
                            {
                                "candidate_id": "K1",
                                "script_segment_ids": ["S1"],
                                "confidence": "possible_dialogue",
                                "total_score": 0.61,
                                "dialogue_score": 0.65,
                                "sequence_score": 0.55,
                                "margin": 0.02,
                                "transcript_text": "你好我是王总",
                            }
                        ]
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    (config.output_dir / "review.json").write_text(
        json.dumps(
            {
                "version": 2,
                "revision": 2,
                "assignments": {},
                "groups": {},
                "clips": {},
                "placements": {"G1": {"script_segment_ids": ["S2"], "episode_ids": [1]}},
            }
        ),
        encoding="utf-8",
    )
    AutomationStore(config.output_dir).save(
        "rev-a",
        {
            "G1": {
                "status": "needs_review",
                "mapping_status": "ambiguous",
                "mapping_source": "deterministic",
                "script_segment_ids": ["S1"],
                "confidence": 0.61,
            }
        },
        {},
    )
    audit = {
        "analysis_revision": "rev-a",
        "groups": {
            "G1": {
                "judge": {"verdict": "disagree", "confidence": 0.91},
                "issues": [{"code": "mapping_conflict"}],
                "algorithm_feedback": {
                    "failure_class": "short_dialogue_global_collision",
                    "suspected_missing_feature": "scene_visual_context",
                },
            }
        },
    }
    result = write_learning_dataset(config, audit)
    assert result["cases"] == 1
    text = (config.output_dir / "learning_cases.jsonl").read_text(encoding="utf-8")
    assert "/Volumes/SECRET" not in text
    row = json.loads(text)
    assert row["contract"] == "learning.v1"
    assert row["group_id"] == "G1"
    assert row["audit"]["verdict"] == "disagree"
    assert row["human_expected"]["script_segment_ids"] == ["S2"]
