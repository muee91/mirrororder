from __future__ import annotations

import io
import json
from pathlib import Path

import script_organizer.identity_worker as identity_worker
from script_organizer.config import ProjectConfig
from script_organizer.device_runtime_settings import (
    load_project_intelligence_settings,
    load_runtime_settings,
    save_project_intelligence_settings,
    save_runtime_settings,
)
from script_organizer.identity_index import IdentityIndexer
from script_organizer.identity_library import IdentityLibrary
from script_organizer.identity_runtime import FACE_DETECTOR, FACE_RECOGNIZER, SPEAKER_EMBEDDER
from script_organizer.workspace_db import WorkspaceDatabase


def test_identity_worker_reports_initialization_before_inference(monkeypatch, capsys, tmp_path: Path) -> None:
    class FakeIndexer:
        def __init__(self, *_args, **_kwargs):
            pass

        def _index(self) -> dict:
            return {}

        def run(self, _kind: str, **kwargs) -> dict:
            kwargs["progress"](1, 1, "G1")
            return {"processed": 1}

    config_path = tmp_path / "project.toml"
    config_path.write_text("[project]\nname='demo'\n", encoding="utf-8")
    monkeypatch.setattr(identity_worker, "IdentityIndexer", FakeIndexer)
    monkeypatch.setattr(identity_worker.sys, "stdin", io.StringIO(""))

    assert identity_worker.main([
        "--workspace-id", "ws_demo",
        "--project-id", "project",
        "--config", str(config_path),
        "--kind", "speaker",
    ]) == 0

    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert events[0] == {"type": "status", "message": "正在读取角色声纹识别缓存"}
    assert events[1] == {"type": "status", "message": "正在加载角色声纹识别模型"}
    assert events[2]["type"] == "progress"
    assert events[3] == {"type": "result", "result": {"processed": 1}}


def _config(tmp_path: Path, groups: int = 2) -> tuple[ProjectConfig, dict]:
    project = tmp_path / "project"
    output = project / "output"
    transcripts = project / "cache" / "transcripts"
    inputs = project / "inputs"
    output.mkdir(parents=True)
    transcripts.mkdir(parents=True)
    inputs.mkdir(parents=True)
    script = inputs / "script.md"
    script.write_text("# 第1集\n\n1-1 室内\n\n角色A：你好\n", encoding="utf-8")
    config_path = project / "project.toml"
    config_path.write_text("[project]\nname='demo'\n", encoding="utf-8")
    rows = []
    for index in range(1, groups + 1):
        rows.append(
            {
                "group_id": f"G{index}",
                "start": float(index * 10),
                "end": float(index * 10 + 4),
                "duration": 4.0,
                "cameras": ["B"],
                "members": [
                    {
                        "clip_id": f"C{index}",
                        "camera": "B",
                        "name": f"clip-{index}",
                        "source_start": 0.0,
                        "source_end": 4.0,
                        "duration": 4.0,
                    }
                ],
                "kind": "multicam",
                "parent_group_id": "",
                "take_index": index,
                "split_reason": "",
            }
        )
    material = {"stats": {"groups": groups, "clips": groups}, "groups": rows, "clips": []}
    (output / "material_index.json").write_text(json.dumps(material), encoding="utf-8")
    config = ProjectConfig(
        config_path=config_path,
        name="demo",
        fcpxml=None,
        script=script,
        output_dir=output,
        transcript_dir=transcripts,
        input_kind="media-directory",
        media_root=None,
    )
    return config, material


def _frames(database: WorkspaceDatabase, tmp_path: Path, project_id: str, material: dict) -> None:
    database.sync_take_index(
        project_id,
        name="demo",
        input_kind="media-directory",
        config_path="project/project.toml",
        index=material,
    )
    for group in material["groups"]:
        rows = []
        for index in range(3):
            path = tmp_path / f"{group['group_id']}-{index}.jpg"
            path.write_bytes(b"fake-jpeg")
            rows.append(
                {
                    "frame_id": f"{group['group_id']}-F{index}",
                    "clip_id": group["members"][0]["clip_id"],
                    "camera": "B",
                    "source_time": float(index + 1),
                    "reason": "test",
                    "path": str(path),
                }
            )
        database.replace_frames(project_id, group["group_id"], rows)


class FakeFaceProvider:
    def __init__(self, vectors: dict[str, list[float]]):
        self.vectors = vectors
        self.calls: list[str] = []

    def extract(self, frames: list[Path]) -> list[dict]:
        group_id = frames[0].stem.split("-")[0]
        self.calls.append(group_id)
        return [
            {
                "embedding": self.vectors[group_id],
                "confidence": 0.96,
                "start": 0.0,
                "end": 0.0,
                "metadata": {"source": "fake-face"},
            }
        ]


class FakeSpeakerProvider:
    def __init__(self, vectors: dict[str, list[float]]):
        self.vectors = vectors
        self.calls: list[str] = []

    def extract(self, media_path: str, ranges: list[dict]) -> list[dict]:
        group_id = Path(media_path).stem
        self.calls.append(group_id)
        return [
            {
                "embedding": self.vectors[group_id],
                "confidence": 0.91,
                "start": ranges[0]["start"],
                "end": ranges[0]["end"],
                "metadata": {"source": "fake-speaker"},
            }
        ]


class FakeMediaStore:
    def __init__(self, paths: dict[str, Path]):
        self.paths = paths

    def resolve(self, _workspace_id: str, _project_id: str, member: dict) -> str:
        return str(self.paths[str(member["clip_id"])])


def test_face_identity_clusters_similar_takes_and_skips_cached_work(tmp_path: Path) -> None:
    config, material = _config(tmp_path, groups=2)
    database = WorkspaceDatabase("ws", tmp_path / "workspace.sqlite3")
    _frames(database, tmp_path, "project", material)
    provider = FakeFaceProvider({"G1": [1.0, 0.0, 0.0], "G2": [0.999, 0.03, 0.0]})
    indexer = IdentityIndexer(
        "ws", "project", config, database=database, face_provider=provider
    )

    first = indexer.run("face")
    assert first["processed"] == 2
    assert first["observations"] == 2
    assert provider.calls == ["G1", "G2"]

    with database.connection() as connection:
        ids = [
            str(row[0])
            for row in connection.execute(
                "SELECT identity_id FROM identity_observations WHERE project_id='project' ORDER BY group_id"
            ).fetchall()
        ]
    assert len(set(ids)) == 1

    second = indexer.run("face")
    assert second["skipped_cached"] is True
    assert provider.calls == ["G1", "G2"]


def test_manual_actor_and_role_survive_explicit_reindex(tmp_path: Path) -> None:
    config, material = _config(tmp_path, groups=1)
    database = WorkspaceDatabase("ws", tmp_path / "workspace.sqlite3")
    _frames(database, tmp_path, "project", material)
    provider = FakeFaceProvider({"G1": [1.0, 0.0, 0.0]})
    indexer = IdentityIndexer(
        "ws", "project", config, database=database, face_provider=provider
    )
    indexer.run("face")

    library = IdentityLibrary(database, "project")
    identity = library.list("face")[0]
    library.update(identity["identity_id"], label="张三", role_name="王强")

    # Explicit group selection intentionally rebuilds this Take. It may refresh
    # observations but must never revert the human actor/role labels.
    indexer.run("face", group_ids=["G1"])
    refreshed = library.get(identity["identity_id"])
    assert refreshed["label"] == "张三"
    assert refreshed["role_name"] == "王强"
    assert refreshed["confirmed"] is True


def test_speaker_identity_clusters_similar_voice_embeddings(tmp_path: Path) -> None:
    config, material = _config(tmp_path, groups=2)
    database = WorkspaceDatabase("ws", tmp_path / "workspace.sqlite3")
    media = {}
    for index in range(1, 3):
        path = tmp_path / f"G{index}.mov"
        path.write_bytes(b"media")
        media[f"C{index}"] = path
    provider = FakeSpeakerProvider({"G1": [1.0, 0.0, 0.0], "G2": [0.998, 0.04, 0.0]})
    indexer = IdentityIndexer(
        "ws",
        "project",
        config,
        database=database,
        media_store=FakeMediaStore(media),
        speaker_provider=provider,
    )

    result = indexer.run("speaker")
    assert result["processed"] == 2
    assert result["observations"] == 2
    with database.connection() as connection:
        ids = [
            str(row[0])
            for row in connection.execute(
                "SELECT identity_id FROM identity_observations WHERE project_id='project' AND kind='speaker' ORDER BY group_id"
            ).fetchall()
        ]
    assert len(set(ids)) == 1


def test_identity_library_never_returns_embedding_and_can_merge(tmp_path: Path) -> None:
    config, material = _config(tmp_path, groups=2)
    del config
    database = WorkspaceDatabase("ws", tmp_path / "workspace.sqlite3")
    database.sync_take_index(
        "project", name="demo", input_kind="media-directory", config_path="project.toml", index=material
    )
    for identity_id, group_id in (("face_a", "G1"), ("face_b", "G2")):
        database.upsert_identity("project", identity_id=identity_id, kind="face", label=identity_id)
        database.add_identity_observation(
            "project", group_id, kind="face", identity_id=identity_id,
            confidence=0.9, embedding=b"must-not-leak",
            metadata={
                "face_crop_path": "/tmp/representative-face.jpg",
                "source_frame_path": "/tmp/full-frame.jpg",
                "camera": "B",
                "source_time": 2.5,
            },
        )
    library = IdentityLibrary(database, "project")
    payload = library.list("face")
    assert all("embedding" not in row for row in payload)
    assert payload[0]["example"]["face_crop_path"] == "/tmp/representative-face.jpg"
    assert payload[0]["example"]["source_frame_path"] == "/tmp/full-frame.jpg"
    assert payload[0]["example"]["camera"] == "B"
    assert payload[0]["occurrences"][0]["group_id"] in {"G1", "G2"}
    merged = library.merge("face_a", ["face_b"])
    assert merged["observation_count"] == 2
    assert {row["identity_id"] for row in library.list("face")} == {"face_a"}


def test_identity_library_lists_all_identity_details_in_bulk(monkeypatch, tmp_path: Path) -> None:
    config, material = _config(tmp_path, groups=2)
    del config
    database = WorkspaceDatabase("ws", tmp_path / "workspace.sqlite3")
    database.sync_take_index(
        "project", name="demo", input_kind="media-directory", config_path="project.toml", index=material
    )
    for identity_id, group_id in (("face_a", "G1"), ("face_b", "G2")):
        database.upsert_identity("project", identity_id=identity_id, kind="face", label=identity_id)
        database.add_identity_observation(
            "project",
            group_id,
            kind="face",
            identity_id=identity_id,
            confidence=0.9,
            metadata={"camera": "B", "source_time": 2.5},
        )
    library = IdentityLibrary(database, "project")

    monkeypatch.setattr(
        library,
        "_example",
        lambda _identity_id: (_ for _ in ()).throw(AssertionError("per-row example query")),
    )
    monkeypatch.setattr(
        library,
        "_occurrences",
        lambda _identity_id: (_ for _ in ()).throw(AssertionError("per-row occurrence query")),
    )

    payload = library.list("face")

    assert [row["identity_id"] for row in payload] == ["face_a", "face_b"]
    assert all(row["occurrences"] for row in payload)


def test_identity_library_uses_null_for_an_identity_without_a_sample(tmp_path: Path) -> None:
    config, material = _config(tmp_path, groups=1)
    del config
    database = WorkspaceDatabase("ws", tmp_path / "workspace.sqlite3")
    database.sync_take_index(
        "project", name="demo", input_kind="media-directory", config_path="project.toml", index=material
    )
    database.upsert_identity("project", identity_id="face_orphan", kind="face", label="人物候选")

    payload = IdentityLibrary(database, "project").list("face")

    assert len(payload) == 1
    assert payload[0]["identity_id"] == "face_orphan"
    assert payload[0]["example"] is None
    assert payload[0]["occurrences"] == []


def test_identity_runtime_and_project_intelligence_settings_are_separate(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path / "app-support"))
    defaults = load_runtime_settings()
    assert defaults["face_identity_enabled"] is False
    assert defaults["speaker_identity_enabled"] is False
    assert defaults["default_perception_sampling_profile"] == "standard"
    assert defaults["default_identity_matching_profile"] == "balanced"

    saved = save_runtime_settings(
        {
            "face_identity_enabled": True,
            "speaker_identity_enabled": True,
        }
    )
    assert saved["face_identity_enabled"] is True
    assert saved["speaker_identity_enabled"] is True
    assert load_project_intelligence_settings("ws-a", "project")["perception_sampling_profile"] == "standard"
    saved_project = save_project_intelligence_settings(
        "ws-a",
        "project",
        {
            "perception_sampling_profile": "adaptive",
            "identity_matching_profile": "conservative",
        },
    )
    assert saved_project["perception_sampling_profile"] == "adaptive"
    assert saved_project["identity_matching_profile"] == "conservative"
    assert load_project_intelligence_settings("ws-b", "project")["perception_sampling_profile"] == "standard"
    assert load_runtime_settings()["face_identity_enabled"] is True


def test_identity_models_are_pinned_and_never_downloaded_by_app_build() -> None:
    for artifact in (FACE_DETECTOR, FACE_RECOGNIZER, SPEAKER_EMBEDDER):
        assert len(artifact.sha256) == 64
        int(artifact.sha256, 16)
        assert artifact.size_bytes > 0
        assert artifact.url.startswith("https://")
    root = Path(__file__).resolve().parents[1]
    build = (root / "macos-app" / "build_app.sh").read_text(encoding="utf-8")
    assert "face_detection_yunet" not in build
    assert "face_recognition_sface" not in build
    assert "wespeaker_zh_cnceleb_resnet34" not in build
    assert "requirements-local-intelligence.txt" not in build


def test_identity_management_keeps_writes_local_and_remote_reads_sanitized() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "src" / "script_organizer" / "automation_runtime.py").read_text(encoding="utf-8")
    tasks = (root / "src" / "script_organizer" / "tasks.py").read_text(encoding="utf-8")
    worker = (root / "src" / "script_organizer" / "identity_worker.py").read_text(encoding="utf-8")
    app = (root / "macos-app" / "LocalRuntimeSettingsView.swift").read_text(encoding="utf-8")
    assert 'parts[4] == "identities"' in runtime
    assert "IdentityLibrary" in runtime
    assert "self._local_only()" in runtime
    assert '"source_identity_ids"' in runtime
    assert '"intelligence-settings"' in runtime
    assert "_remote_identity_payload" in runtime
    assert 'safe_example.pop("face_crop_path", None)' in runtime
    assert 'script_organizer.identity_worker' in tasks
    assert "multiprocessing.get_context" not in tasks
    assert "cancel\\n" in tasks
    assert "IdentityIndexer" in worker
    assert "cancelled.is_set" in worker
    assert "_pending_total" in worker
    assert '"done": 0' in worker
    assert "IdentityIndexActivity" in app
    assert "refreshActivity" in app
    assert "identityProgress" in app


def test_person_labeling_never_uses_a_full_camera_frame() -> None:
    root = Path(__file__).resolve().parents[1]
    indexer = (root / "src" / "script_organizer" / "identity_index_v2.py").read_text(encoding="utf-8")
    library = (root / "src" / "script_organizer" / "identity_library.py").read_text(encoding="utf-8")
    app = (root / "macos-app" / "LocalRuntimeSettingsView.swift").read_text(encoding="utf-8")
    assert '"face_crop_path": face_crop_path' in indexer
    assert '"source_frame_path": str(frame.get("path", "") or "")' in indexer
    assert 'let path = identity.example?.face_crop_path' in app
    assert 'metadata.get("source_frame_path", metadata.get("frame_path", ""))' in library
