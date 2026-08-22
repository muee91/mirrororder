from __future__ import annotations

import json
from pathlib import Path

from script_organizer.auto_resolver import resolve_project
from script_organizer.config import ProjectConfig
from script_organizer.model_provider import ModelProvider, ModelProviderConfig
from script_organizer.review_store import ReviewStore


def config_for(tmp_path: Path) -> ProjectConfig:
    script = tmp_path / "script.txt"
    script.write_text("dummy", encoding="utf-8")
    output = tmp_path / "output"
    output.mkdir()
    return ProjectConfig(
        config_path=tmp_path / "project.toml",
        name="demo",
        fcpxml=tmp_path / "input.fcpxml",
        script=script,
        output_dir=output,
        transcript_dir=tmp_path / "transcripts",
        input_kind="fcpxml",
        high_confidence=0.82,
        possible_confidence=0.65,
        minimum_margin=0.08,
    )


def write_analysis(config: ProjectConfig) -> None:
    segments = [
        {"segment_id": "S1", "episode": 1, "scene_id": "1-1", "order": 1, "type": "dialogue", "raw_text": "王总你怎么来了", "text": "王总你怎么来了"},
        {"segment_id": "S2", "episode": 1, "scene_id": "1-1", "order": 2, "type": "dialogue", "raw_text": "以后别再来了", "text": "以后别再来了"},
    ]
    groups = [
        {"group_id": "G1", "start": 0, "end": 5, "members": []},
        {"group_id": "G2", "start": 6, "end": 10, "members": []},
    ]
    matches = {
        "groups": {
            "G1": {"candidates": [{
                "candidate_id": "K1", "confidence": "exact_dialogue", "total_score": 0.94,
                "dialogue_score": 0.93, "sequence_score": 0.90, "margin": 0.20,
                "script_segment_ids": ["S1"], "transcript_text": "王总你怎么来了",
            }]},
            "G2": {"candidates": [{
                "candidate_id": "K2", "confidence": "possible_dialogue", "total_score": 0.61,
                "dialogue_score": 0.62, "sequence_score": 0.60, "margin": 0.01,
                "script_segment_ids": ["S2"], "transcript_text": "走吧以后别来了",
            }]},
        }
    }
    (config.output_dir / "material_index.json").write_text(json.dumps({"groups": groups, "clips": []}), encoding="utf-8")
    (config.output_dir / "script.json").write_text(json.dumps({"segments": segments}), encoding="utf-8")
    (config.output_dir / "matches.json").write_text(json.dumps(matches), encoding="utf-8")


def test_high_confidence_auto_confirms_and_ambiguous_goes_to_review(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    write_analysis(config)
    provider = ModelProvider(ModelProviderConfig())
    result = resolve_project(config, provider)

    assert result["groups"]["G1"]["status"] == "auto_confirmed"
    assert result["groups"]["G1"]["state"] == "keep"
    assert result["groups"]["G2"]["status"] == "needs_review"
    assert result["groups"]["G2"]["state"] == "unreviewed"
    assert result["summary"]["completed"] == 1


def test_manual_review_overrides_automation_and_auto_never_rejects(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    write_analysis(config)
    ReviewStore(config.output_dir / "review.json").apply_action({
        "action": "set_group", "group_id": "G1", "state": "reject", "actor": "editor",
    })
    result = resolve_project(config, ModelProvider(ModelProviderConfig()))

    assert result["groups"]["G1"]["status"] == "human_override"
    assert result["groups"]["G1"]["state"] == "reject"
    assert all(
        entry["state"] != "reject" or entry["status"] == "human_override"
        for entry in result["groups"].values()
    )


def test_desktop_build_can_bundle_sync_engine() -> None:
    root = Path(__file__).resolve().parents[1]
    build = (root / "macos-app" / "build_app.sh").read_text(encoding="utf-8")
    tasks = (root / "src" / "script_organizer" / "tasks.py").read_text(encoding="utf-8")
    automation = (root / "web" / "automation.js").read_text(encoding="utf-8")

    assert "MIRRORORDER_MULTICAM_SYNC_ROOT" in build
    assert ".agents/skills/multicam-audio-sync" in build
    assert '"prepare_project"' in tasks
    assert '"auto_resolve"' in tasks
    assert "ai_confirmed" in automation
    assert "待处理" in automation
