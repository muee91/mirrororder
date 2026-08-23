from __future__ import annotations

import json
from pathlib import Path

from script_organizer.config import ProjectConfig
from script_organizer.semantic_index import ProjectSemanticIndexer
from script_organizer.semantic_store import SemanticStore
from script_organizer.workspace_db import WorkspaceDatabase


class _PublicConfig:
    def public(self) -> dict:
        return {"enabled": False, "provider": "none", "model": "", "source": "test", "local": True}


class DisabledEncoder:
    enabled = False
    identity = ""

    def __init__(self) -> None:
        self.config = _PublicConfig()

    def encode(self, _texts):
        raise AssertionError("disabled encoder must not run")


class FixedMediaStore:
    def resolve(self, _workspace_id, _project_id, member) -> str:
        return f"/virtual/{member.get('media_id', 'media')}.mov"


def _project(tmp_path: Path) -> tuple[ProjectConfig, WorkspaceDatabase]:
    root = tmp_path / "project"
    output = root / "output"
    transcripts = root / "cache" / "transcripts"
    output.mkdir(parents=True)
    transcripts.mkdir(parents=True)
    config_path = root / "project.toml"
    script_path = root / "script.txt"
    config_path.write_text("[project]\nname='demo'\n", encoding="utf-8")
    script_path.write_text("demo", encoding="utf-8")
    material = {
        "groups": [
            {
                "group_id": "G1",
                "start": 0.0,
                "end": 8.0,
                "duration": 8.0,
                "cameras": ["A", "B"],
                "members": [
                    {
                        "clip_id": "CA",
                        "media_id": "MA",
                        "camera": "A",
                        "name": "A001.mov",
                        "duration": 8.0,
                        "source_start": 0.0,
                        "source_end": 8.0,
                    },
                    {
                        "clip_id": "CB",
                        "media_id": "MB",
                        "camera": "B",
                        "name": "B001.mov",
                        "duration": 8.0,
                        "source_start": 0.0,
                        "source_end": 8.0,
                    },
                ],
            }
        ],
        "clips": [],
        "stats": {"groups": 1, "clips": 2},
    }
    (output / "material_index.json").write_text(json.dumps(material, ensure_ascii=False), encoding="utf-8")
    # B is the canonical dialogue source when synchronized cameras contain the
    # same sentence at the same moment. A repeats it near 0.5s and once later;
    # only the near duplicate should collapse.
    (transcripts / "MB.json").write_text(
        json.dumps(
            {
                "media_id": "MB",
                "text": "你好。再见。",
                "segments": [
                    {"start": 0.50, "end": 1.70, "text": "你好"},
                    {"start": 4.00, "end": 5.00, "text": "再见"},
                ],
                "backend": "faster-whisper",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (transcripts / "MA.json").write_text(
        json.dumps(
            {
                "media_id": "MA",
                "text": "你好。你好。",
                "segments": [
                    {"start": 0.55, "end": 1.80, "text": "你好"},
                    {"start": 7.00, "end": 7.50, "text": "你好"},
                ],
                "backend": "faster-whisper",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
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
    database = WorkspaceDatabase("semantic-segment-test", path=tmp_path / "workspace.sqlite3")
    database.sync_take_index(
        "demo",
        name="demo",
        input_kind="media-directory",
        config_path=str(config_path),
        index=material,
    )
    return config, database


def test_cached_asr_becomes_take_relative_search_segments(tmp_path: Path) -> None:
    config, database = _project(tmp_path)
    indexer = ProjectSemanticIndexer(
        "semantic-segment-test",
        "demo",
        config,
        database=database,
        media_store=FixedMediaStore(),
        encoder=DisabledEncoder(),
    )
    report = indexer.refresh(sources={"speech"})
    rows = SemanticStore(database).documents("demo", sources=["speech"])

    assert report["semantics"]["new_vlm_inference"] is False
    assert len(rows) == 3
    assert [(row["text"], row["clip_id"], row["start"], row["end"]) for row in rows] == [
        ("你好", "CB", 0.5, 1.7),
        ("再见", "CB", 4.0, 5.0),
        ("你好", "CA", 7.0, 7.5),
    ]
    assert all(row["metadata"]["precision"] == "asr_segment" for row in rows)
    assert all(row["metadata"]["time_basis"] == "take_relative" for row in rows)
    assert rows[0]["metadata"]["camera"] == "B"


def test_semantic_search_ui_seeks_from_member_source_start() -> None:
    root = Path(__file__).resolve().parents[1]
    ui = (root / "web" / "semantic_search_ui.js").read_text(encoding="utf-8")
    assert "data-semantic-result-index" in ui
    assert "member.source_start" in ui
    assert "row?.start" in ui
    assert "absoluteStart" in ui
    assert "定位对白" in ui
