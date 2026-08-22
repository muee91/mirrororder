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


def test_high_confidence_auto_confirms_mapping_without_editorial_keep(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    write_analysis(config)
    provider = ModelProvider(ModelProviderConfig())
    result = resolve_project(config, provider)

    confirmed = result["groups"]["G1"]
    ambiguous = result["groups"]["G2"]
    assert confirmed["status"] == "auto_confirmed"
    assert confirmed["mapping_status"] == "confirmed"
    assert confirmed["mapping_source"] == "deterministic"
    assert confirmed["editorial_state"] == "unreviewed"
    assert confirmed["script_segment_ids"] == ["S1"]
    assert ambiguous["status"] == "needs_review"
    assert ambiguous["mapping_status"] == "ambiguous"
    assert ambiguous["editorial_state"] == "unreviewed"
    assert result["summary"]["completed"] == 1


def test_editorial_reject_does_not_become_mapping_evidence_and_manual_placement_does(tmp_path: Path) -> None:
    config = config_for(tmp_path)
    write_analysis(config)
    review = ReviewStore(config.output_dir / "review.json")
    review.apply_action({
        "action": "set_group", "group_id": "G1", "state": "reject", "actor": "editor",
    })

    editorial_only = resolve_project(config, ModelProvider(ModelProviderConfig()))
    entry = editorial_only["groups"]["G1"]
    assert entry["status"] == "auto_confirmed"
    assert entry["mapping_status"] == "confirmed"
    assert entry["mapping_source"] == "deterministic"
    assert entry["script_segment_ids"] == ["S1"]
    assert entry["editorial_state"] == "reject"

    review.apply_action({
        "action": "set_group_placement",
        "group_id": "G1",
        "episode_ids": [1],
        "script_segment_ids": ["S2"],
        "actor": "editor",
    })
    manually_mapped = resolve_project(config, ModelProvider(ModelProviderConfig()))
    entry = manually_mapped["groups"]["G1"]
    assert entry["status"] == "human_override"
    assert entry["mapping_status"] == "confirmed"
    assert entry["mapping_source"] == "human"
    assert entry["script_segment_ids"] == ["S2"]
    assert entry["editorial_state"] == "reject"


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


def test_project_creation_defaults_to_raw_media_and_is_host_local() -> None:
    root = Path(__file__).resolve().parents[1]
    automation = (root / "web" / "automation.js").read_text(encoding="utf-8")
    server = (root / "src" / "script_organizer" / "web_server.py").read_text(encoding="utf-8")

    assert "kind.value = 'media-directory'" in automation
    assert "原始多机位素材目录（推荐" in automation
    assert "已有同步 FCPXML（高级入口）" in automation
    assert "项目创建只在 Host 本机或镜序 App 执行" in automation
    assert 'if parts == ["api", "v1", "projects"]:' in server
    assert "self._local_only()" in server
