from __future__ import annotations

import json

from script_organizer.config import ProjectConfig
from script_organizer.fcpxml_exporter import build_selection_manifest


def test_manual_script_placement_removes_stale_automatic_line(tmp_path):
    config = ProjectConfig(
        tmp_path / "project.toml",
        "placement-test",
        tmp_path / "source.fcpxml",
        tmp_path / "script.docx",
        tmp_path / "out",
        tmp_path / "cache",
    )
    config.output_dir.mkdir()
    (config.output_dir / "material_index.json").write_text(
        json.dumps({"groups": [{"group_id": "g1", "members": []}]}),
        encoding="utf-8",
    )
    (config.output_dir / "script.json").write_text(
        json.dumps({
            "segments": [
                {"segment_id": "old", "episode": 1, "scene_id": "1-1", "text": "旧自动位置"},
                {"segment_id": "new", "episode": 1, "scene_id": "1-1", "text": "人工新位置"},
            ]
        }),
        encoding="utf-8",
    )
    (config.output_dir / "matches.json").write_text(
        json.dumps({
            "by_segment": {
                "old": [{"group_id": "g1", "confidence": "exact_dialogue"}],
                "new": [],
            }
        }),
        encoding="utf-8",
    )
    (config.output_dir / "review.json").write_text(
        json.dumps({
            "version": 2,
            "revision": 1,
            "assignments": {"old": {"g1": {"state": "best"}}},
            "groups": {},
            "clips": {},
            "placements": {
                "g1": {
                    "episode_ids": [1],
                    "script_segment_ids": ["new"],
                    "method": "manual",
                }
            },
        }),
        encoding="utf-8",
    )

    manifest = build_selection_manifest(config)
    rows = {row["script_segment"]: row["groups"] for row in manifest["segments"]}

    assert rows["old"] == []
    assert len(rows["new"]) == 1
    assert rows["new"][0]["group_id"] == "g1"
    assert rows["new"][0]["state"] == "keep"
    assert rows["new"][0]["automatic_state"] == "keep"
    assert rows["new"][0]["decision_source"] == "automatic_mapping_fallback"


def test_episode_only_placement_does_not_claim_manual_script_line(tmp_path):
    config = ProjectConfig(
        tmp_path / "project.toml",
        "episode-only-test",
        tmp_path / "source.fcpxml",
        tmp_path / "script.docx",
        tmp_path / "out",
        tmp_path / "cache",
    )
    config.output_dir.mkdir()
    (config.output_dir / "material_index.json").write_text(
        json.dumps({"groups": [{"group_id": "g1", "members": []}]}),
        encoding="utf-8",
    )
    (config.output_dir / "script.json").write_text(
        json.dumps({"segments": [{"segment_id": "s1", "episode": 1, "scene_id": "1-1", "text": "自动位置"}]}),
        encoding="utf-8",
    )
    (config.output_dir / "matches.json").write_text(
        json.dumps({"by_segment": {"s1": [{"group_id": "g1", "confidence": "possible_dialogue"}]}}),
        encoding="utf-8",
    )
    (config.output_dir / "review.json").write_text(
        json.dumps({
            "version": 2,
            "revision": 1,
            "assignments": {},
            "groups": {},
            "clips": {},
            "placements": {
                "g1": {
                    "episode_ids": [1],
                    "script_segment_ids": [],
                    "method": "manual",
                }
            },
        }),
        encoding="utf-8",
    )

    manifest = build_selection_manifest(config)
    groups = manifest["segments"][0]["groups"]

    assert len(groups) == 1
    assert groups[0]["group_id"] == "g1"
    assert groups[0]["state"] == "keep"
    assert groups[0]["automatic_state"] == "keep"
    assert groups[0]["decision_source"] == "automatic_mapping_fallback"
