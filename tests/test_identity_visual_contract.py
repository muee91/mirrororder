from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_PATH = ROOT / "src/script_organizer/identity_api_runtime.py"
UI_PATH = ROOT / "desktop/src/features/identity/IdentityWorkbench.tsx"
CSS_PATH = ROOT / "desktop/src/features/identity/identity-workbench.css"


def _load_runtime():
    package = types.ModuleType("script_organizer")
    package.__path__ = []
    sys.modules.setdefault("script_organizer", package)

    identity_library = types.ModuleType("script_organizer.identity_library")
    identity_library.IdentityLibrary = object
    sys.modules[identity_library.__name__] = identity_library

    inference = types.ModuleType("script_organizer.identity_role_inference")
    inference.install_identity_role_inference = lambda: None
    sys.modules[inference.__name__] = inference

    workspace_db = types.ModuleType("script_organizer.workspace_db")
    workspace_db.WorkspaceDatabase = object
    sys.modules[workspace_db.__name__] = workspace_db

    spec = importlib.util.spec_from_file_location("script_organizer.identity_api_runtime", RUNTIME_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class _Cursor:
    def __init__(self, row):
        self.row = row

    def execute(self, sql: str, params: tuple[object, ...]):
        return self

    def fetchone(self):
        return self.row

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class _Database:
    def __init__(self, row):
        self.row = row

    def connection(self):
        return _Cursor(self.row)


class _Library:
    project_id = "project_1"

    def __init__(self, row):
        self.database = _Database(row)


def _db_row(kind: str, metadata: dict[str, object] | None):
    import json
    return {
        "kind": kind,
        "metadata_json": json.dumps(metadata or {}),
    }


def test_portrait_asset_serves_only_face_crop(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    runtime = _load_runtime()
    crop = tmp_path / "face-a.jpg"
    crop.write_bytes(b"not-a-real-jpeg-but-a-file")
    row = _db_row("face", {
        "face_crop_path": str(crop),
        "source_frame_path": str(tmp_path / "full-frame.jpg"),
    })
    monkeypatch.setattr(runtime, "_library", lambda project: _Library(row))

    path, content_type = runtime._portrait_asset(object(), "face_1")

    assert path == crop
    assert content_type == "image/jpeg"


def test_portrait_asset_never_falls_back_to_full_frame(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    runtime = _load_runtime()
    full = tmp_path / "frame.jpg"
    full.write_bytes(b"frame")
    row = _db_row("face", {"source_frame_path": str(full)})
    monkeypatch.setattr(runtime, "_library", lambda project: _Library(row))

    with pytest.raises(LookupError, match="人脸裁切图"):
        runtime._portrait_asset(object(), "face_1")


def test_portrait_asset_rejects_speaker_and_symlink(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    runtime = _load_runtime()
    crop = tmp_path / "face.jpg"
    crop.write_bytes(b"face")
    speaker = _db_row("speaker", {"face_crop_path": str(crop)})
    monkeypatch.setattr(runtime, "_library", lambda project: _Library(speaker))
    with pytest.raises(LookupError, match="没有人脸图"):
        runtime._portrait_asset(object(), "speaker_1")

    link = tmp_path / "linked.jpg"
    try:
        link.symlink_to(crop)
    except (OSError, NotImplementedError):
        pytest.skip("symlink unavailable on this platform")
    face = _db_row("face", {"face_crop_path": str(link)})
    monkeypatch.setattr(runtime, "_library", lambda project: _Library(face))
    with pytest.raises(LookupError, match="不存在"):
        runtime._portrait_asset(object(), "face_2")


def test_portrait_asset_rejects_unknown_identity(monkeypatch: pytest.MonkeyPatch):
    runtime = _load_runtime()
    monkeypatch.setattr(runtime, "_library", lambda project: _Library(None))
    with pytest.raises(LookupError, match="identity 不存在"):
        runtime._portrait_asset(object(), "missing")


def test_decorated_identity_rows_keep_paths_server_side():
    runtime = _load_runtime()
    rows = [{
        "identity_id": "face_1",
        "kind": "face",
        "example": {
            "face_crop_path": "/private/device/face.jpg",
            "source_frame_path": "/private/device/frame.jpg",
            "camera": "A",
        },
        "occurrences": [{"clip_id": "clip_1"}],
    }]
    project = types.SimpleNamespace(clips={"clip_1": {
        "media_id": "M_123",
        "name": "A001C001.mov",
        "shot_type": "CU",
        "duration": 12.5,
        "media_path": "/Volumes/secret/A001C001.mov",
    }})

    payload = runtime._decorate_rows(project, rows)

    example = payload[0]["example"]
    assert example["portrait_available"] is True
    assert "face_crop_path" not in example
    assert "source_frame_path" not in example
    occurrence = payload[0]["occurrences"][0]
    assert occurrence == {
        "clip_id": "clip_1",
        "media_id": "M_123",
        "name": "A001C001.mov",
        "shot_type": "CU",
        "duration": 12.5,
    }
    assert "/Volumes/secret" not in repr(payload)


def test_identity_ui_uses_face_portraits_and_existing_camera_cards():
    ui = UI_PATH.read_text(encoding="utf-8")
    css = CSS_PATH.read_text(encoding="utf-8")
    runtime = RUNTIME_PATH.read_text(encoding="utf-8")

    assert "MirrorOrderMediaCard" in ui
    assert "identity-evidence-cards" in ui
    assert 'className="occurrence-row"' not in ui
    assert "portrait_available" in ui
    assert "/portrait" in ui
    assert "identity-portrait" in css
    assert "@container" in css
    assert '"full_frame_portrait_fallback": False' in runtime
    assert 'portable_example.pop("source_frame_path", None)' in runtime
