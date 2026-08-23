from __future__ import annotations

import json
from pathlib import Path

from script_organizer.config import ProjectConfig
from script_organizer.perception_index import PerceptionIndexer
from script_organizer.workspace_db import WorkspaceDatabase


class FakeSemanticProvider:
    enabled = True

    def describe(self, context, frames):
        assert context["group_id"] == "G_001"
        assert frames
        return {
            "location": "客厅",
            "shot_type": "双人中景",
            "visible_people": ["人物A", "人物B"],
            "actions": ["对话"],
            "props": [],
            "emotion": ["严肃"],
            "continuity_clues": ["沙发"],
            "summary": "两人在客厅对话",
            "provider": "fake",
            "model": "fake-model",
        }


def _config(tmp_path: Path, media: Path) -> ProjectConfig:
    project = tmp_path / "project"
    output = project / "output"
    transcripts = project / "cache" / "transcripts"
    script = project / "script.txt"
    config_path = project / "project.toml"
    project.mkdir()
    output.mkdir()
    transcripts.mkdir(parents=True)
    script.write_text("第一集\n场景：客厅\n人物A：测试", encoding="utf-8")
    config_path.write_text("[project]\nname='demo'\n", encoding="utf-8")
    return ProjectConfig(
        config_path=config_path,
        name="demo",
        fcpxml=None,
        script=script,
        output_dir=output,
        transcript_dir=transcripts,
        input_kind="media-directory",
        media_root=media.parent,
    )


def _write_index(config: ProjectConfig, media: Path) -> None:
    payload = {
        "stats": {"clips": 1, "groups": 1},
        "clips": [
            {
                "clip_id": "C_001",
                "name": media.name,
                "camera": "B",
                "media_path": str(media),
                "source_media_path": str(media),
                "media_id": "M_demo",
                "duration": 3.0,
                "timeline_start": 0.0,
                "timeline_end": 3.0,
                "source_start": 0.0,
                "source_end": 3.0,
                "exists": True,
            }
        ],
        "groups": [
            {
                "group_id": "G_001",
                "start": 0.0,
                "end": 3.0,
                "duration": 3.0,
                "cameras": ["B"],
                "members": [
                    {
                        "clip_id": "C_001",
                        "name": media.name,
                        "camera": "B",
                        "media_path": str(media),
                        "source_media_path": str(media),
                        "media_id": "M_demo",
                        "duration": 3.0,
                        "timeline_start": 0.0,
                        "timeline_end": 3.0,
                        "source_start": 0.0,
                        "source_end": 3.0,
                        "exists": True,
                    }
                ],
                "kind": "single",
                "parent_group_id": "",
                "take_index": 1,
                "split_reason": "",
            }
        ],
    }
    (config.output_dir / "material_index.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )
    (config.output_dir / "matches.json").write_text(
        json.dumps({"groups": {"G_001": {"candidates": []}}}), encoding="utf-8"
    )


def test_tier0_indexes_one_representative_frame_and_reuses_it(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device"))
    media = tmp_path / "media" / "B001.mov"
    media.parent.mkdir()
    media.write_bytes(b"fake-video")
    config = _config(tmp_path, media)
    _write_index(config, media)
    database = WorkspaceDatabase("ws_demo", tmp_path / "workspace.sqlite3")
    calls = []

    def extract(media_path, source_start, source_end, count, output_dir):
        calls.append((media_path, count))
        output_dir.mkdir(parents=True, exist_ok=True)
        target = output_dir / "frame-01.jpg"
        target.write_bytes(b"jpeg")
        return [{"path": str(target), "source_time": 1.5}]

    indexer = PerceptionIndexer(
        "ws_demo",
        "project-a",
        config,
        database=database,
        frame_extractor=extract,
    )
    first = indexer.run(mode="tier0")
    second = indexer.run(mode="tier0")

    assert first["processed"] == 1
    assert first["failed"] == 0
    assert second["processed"] == 0
    assert calls == [(str(media), 1)]
    frames = database.frames("project-a", "G_001")
    assert len(frames) == 1
    assert frames[0]["reason"] == "midpoint"


def test_semantic_index_upgrades_cached_take_with_three_frames(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device"))
    media = tmp_path / "media" / "B001.mov"
    media.parent.mkdir()
    media.write_bytes(b"fake-video")
    config = _config(tmp_path, media)
    _write_index(config, media)
    database = WorkspaceDatabase("ws_demo", tmp_path / "workspace.sqlite3")

    def extract(media_path, source_start, source_end, count, output_dir):
        output_dir.mkdir(parents=True, exist_ok=True)
        rows = []
        for index in range(count):
            target = output_dir / f"frame-{index + 1:02d}.jpg"
            target.write_bytes(b"jpeg")
            rows.append({"path": str(target), "source_time": 0.5 + index})
        return rows

    indexer = PerceptionIndexer(
        "ws_demo",
        "project-a",
        config,
        database=database,
        semantic_provider=FakeSemanticProvider(),
        frame_extractor=extract,
    )
    result = indexer.run(mode="semantic", group_ids=["G_001"])

    assert result["processed"] == 1
    assert len(database.frames("project-a", "G_001")) == 3
    semantic = database.semantic("project-a", "G_001")
    assert semantic["status"] == "ready"
    assert semantic["data"]["location"] == "客厅"
