from __future__ import annotations

import json
from pathlib import Path

from script_organizer.automation_store import AutomationStore
from script_organizer.config import ProjectConfig
from script_organizer.identity_index import IdentityIndexer
from script_organizer.identity_library import IdentityLibrary
from script_organizer.identity_rescue import apply_identity_rescue
from script_organizer.identity_runtime import SPEAKER_EMBEDDER, SPEAKER_SEGMENTER, IdentityRuntime
from script_organizer.workspace_db import WorkspaceDatabase


def _config(tmp_path: Path, material: dict) -> ProjectConfig:
    project = tmp_path / "project"
    output = project / "output"
    cache = project / "cache" / "transcripts"
    inputs = project / "inputs"
    output.mkdir(parents=True)
    cache.mkdir(parents=True)
    inputs.mkdir(parents=True)
    script = inputs / "script.md"
    script.write_text("第1集\n1-1 室内\n王强：你好\n", encoding="utf-8")
    config_path = project / "project.toml"
    config_path.write_text("[project]\nname='demo'\n", encoding="utf-8")
    (output / "material_index.json").write_text(json.dumps(material), encoding="utf-8")
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


class _MediaStore:
    def __init__(self, paths: dict[str, Path]):
        self.paths = paths

    def resolve(self, _workspace: str, _project: str, member: dict) -> str:
        return str(self.paths[str(member["clip_id"])])


class _TrackProvider:
    def __init__(self):
        self.cameras: set[str] = set()

    def extract_with_metadata(self, rows: list[dict]) -> list[dict]:
        self.cameras = {str(row["camera"]) for row in rows}
        return [
            {
                "embedding": [1.0, 0.0, 0.0],
                "confidence": 0.95,
                "clip_id": str(rows[0]["clip_id"]),
                "metadata": {"source": "fake-track", "camera_count": len(self.cameras)},
            }
        ]


class _DiarizationProvider:
    def __init__(self):
        self.called = False

    def extract_diarized(self, media_path: str, start: float, end: float, ranges: list[dict]) -> list[dict]:
        assert Path(media_path).is_file()
        assert end > start
        assert ranges
        self.called = True
        return [
            {"embedding": [1.0, 0.0, 0.0], "confidence": 1.0, "start": start, "end": start + 1.2, "metadata": {"local_speaker": 0}},
            {"embedding": [0.0, 1.0, 0.0], "confidence": 1.0, "start": start + 1.3, "end": min(end, start + 2.7), "metadata": {"local_speaker": 1}},
        ]

    def extract(self, _media_path: str, _ranges: list[dict]) -> list[dict]:
        raise AssertionError("diarization result should be preferred")


def test_face_index_samples_multiple_cameras_without_dense_video_scan(tmp_path: Path) -> None:
    material = {
        "stats": {"groups": 1, "clips": 2},
        "groups": [
            {
                "group_id": "G1", "start": 0.0, "end": 4.0, "duration": 4.0,
                "cameras": ["A", "B"],
                "members": [
                    {"clip_id": "CA", "camera": "A", "source_start": 0.0, "source_end": 4.0, "duration": 4.0},
                    {"clip_id": "CB", "camera": "B", "source_start": 0.0, "source_end": 4.0, "duration": 4.0},
                ],
            }
        ],
        "clips": [],
    }
    config = _config(tmp_path, material)
    media = {}
    for clip_id in ("CA", "CB"):
        path = tmp_path / f"{clip_id}.mov"
        path.write_bytes(b"media")
        media[clip_id] = path

    def extract_frames(_path: str, start: float, end: float | None, count: int, output: Path) -> list[dict]:
        output.mkdir(parents=True, exist_ok=True)
        rows = []
        for index in range(count):
            frame = output / f"{index}.jpg"
            frame.write_bytes(b"jpeg")
            rows.append({"path": str(frame), "source_time": start + (index + 1) * ((end or start + 1) - start) / (count + 1)})
        return rows

    provider = _TrackProvider()
    database = WorkspaceDatabase("ws", tmp_path / "workspace.sqlite3")
    indexer = IdentityIndexer(
        "ws", "project", config,
        database=database,
        media_store=_MediaStore(media),
        face_provider=provider,
        frame_extractor=extract_frames,
    )
    result = indexer.run("face")
    assert result["processed"] == 1
    assert provider.cameras == {"A", "B"}
    assert result["observations"] == 1
    with database.connection() as connection:
        version = connection.execute("SELECT value FROM meta WHERE key='identity:project:face:G1'").fetchone()[0]
    assert str(version).startswith("face-v3|")


def test_speaker_index_prefers_true_diarized_turns(tmp_path: Path) -> None:
    material = {
        "stats": {"groups": 1, "clips": 1},
        "groups": [
            {
                "group_id": "G1", "start": 0.0, "end": 5.0, "duration": 5.0,
                "cameras": ["B"],
                "members": [
                    {"clip_id": "CB", "camera": "B", "source_start": 0.0, "source_end": 5.0, "duration": 5.0}
                ],
            }
        ],
        "clips": [],
    }
    config = _config(tmp_path, material)
    media_path = tmp_path / "CB.mov"
    media_path.write_bytes(b"media")
    provider = _DiarizationProvider()
    database = WorkspaceDatabase("ws", tmp_path / "workspace.sqlite3")
    result = IdentityIndexer(
        "ws", "project", config,
        database=database,
        media_store=_MediaStore({"CB": media_path}),
        speaker_provider=provider,
    ).run("speaker")
    assert provider.called is True
    assert result["observations"] == 2
    with database.connection() as connection:
        rows = connection.execute(
            "SELECT DISTINCT identity_id FROM identity_observations WHERE project_id='project' AND kind='speaker'"
        ).fetchall()
    assert len(rows) == 2


def test_speaker_runtime_pins_segmentation_and_embedding_models() -> None:
    artifacts = IdentityRuntime.artifacts("speaker")
    assert artifacts == (SPEAKER_SEGMENTER, SPEAKER_EMBEDDER)
    assert SPEAKER_SEGMENTER.license == "MIT"
    assert SPEAKER_SEGMENTER.size_bytes == 5992913
    assert SPEAKER_SEGMENTER.sha256 == "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079"


def test_confirmed_speaker_role_can_rescue_one_existing_ambiguous_candidate(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device"))
    material = {
        "stats": {"groups": 1, "clips": 1},
        "groups": [{"group_id": "G1", "start": 0.0, "end": 3.0, "duration": 3.0, "cameras": ["B"], "members": []}],
        "clips": [],
    }
    config = _config(tmp_path, material)
    script = {
        "segments": [
            {"segment_id": "S1", "episode": 1, "order": 1, "speaker": "王强", "type": "dialogue", "text": "你好"},
            {"segment_id": "S2", "episode": 1, "order": 2, "speaker": "李四", "type": "dialogue", "text": "你好"},
        ]
    }
    matches = {
        "groups": {
            "G1": {
                "candidates": [
                    {"candidate_id": "C1", "script_segment_ids": ["S1"], "total_score": 0.54, "dialogue_score": 0.44},
                    {"candidate_id": "C2", "script_segment_ids": ["S2"], "total_score": 0.53, "dialogue_score": 0.43},
                ]
            }
        }
    }
    (config.output_dir / "script.json").write_text(json.dumps(script), encoding="utf-8")
    (config.output_dir / "matches.json").write_text(json.dumps(matches), encoding="utf-8")
    AutomationStore(config.output_dir).save(
        "rev1",
        {"G1": {"status": "needs_review", "mapping_status": "ambiguous", "confidence": 0.54, "evidence": {}}},
        {},
    )

    database = WorkspaceDatabase("ws")
    database.sync_take_index(
        "project", name="demo", input_kind="media-directory",
        config_path=str(config.config_path), index=material,
    )
    database.upsert_identity("project", identity_id="speaker_1", kind="speaker", label="声音候选 01")
    database.add_identity_observation(
        "project", "G1", kind="speaker", identity_id="speaker_1",
        confidence=0.94, embedding=b"private-vector",
    )
    IdentityLibrary(database, "project").update("speaker_1", label="演员甲", role_name="王强")

    rescued = apply_identity_rescue(config)
    decision = rescued["groups"]["G1"]
    assert decision["status"] == "ai_confirmed"
    assert decision["mapping_source"] == "identity_rescue"
    assert decision["script_segment_ids"] == ["S1"]
    assert "embedding" not in json.dumps(decision, ensure_ascii=False)


def test_confirmed_visible_role_alone_never_auto_confirms_mapping(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device"))
    material = {
        "stats": {"groups": 1, "clips": 1},
        "groups": [{"group_id": "G1", "start": 0.0, "end": 3.0, "duration": 3.0, "cameras": ["A"], "members": []}],
        "clips": [],
    }
    config = _config(tmp_path, material)
    (config.output_dir / "script.json").write_text(
        json.dumps({"segments": [{"segment_id": "S1", "episode": 1, "speaker": "王强", "type": "dialogue", "text": "你好"}]}),
        encoding="utf-8",
    )
    (config.output_dir / "matches.json").write_text(
        json.dumps({"groups": {"G1": {"candidates": [{"candidate_id": "C1", "script_segment_ids": ["S1"], "total_score": 0.55, "dialogue_score": 0.42}]}}}),
        encoding="utf-8",
    )
    AutomationStore(config.output_dir).save(
        "rev1", {"G1": {"status": "needs_review", "mapping_status": "ambiguous", "confidence": 0.55}}, {}
    )
    database = WorkspaceDatabase("ws")
    database.sync_take_index("project", name="demo", input_kind="media-directory", config_path=str(config.config_path), index=material)
    database.upsert_identity("project", identity_id="face_1", kind="face", label="人物候选 01")
    database.add_identity_observation("project", "G1", kind="face", identity_id="face_1", confidence=0.98, embedding=b"private-vector")
    IdentityLibrary(database, "project").update("face_1", label="演员甲", role_name="王强")
    decision = apply_identity_rescue(config)["groups"]["G1"]
    assert decision["status"] == "needs_review"
    assert decision["evidence"]["identity"]["visible_roles"] == ["王强"]
