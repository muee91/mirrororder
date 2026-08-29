from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from script_organizer.media_identity import DeviceMediaStore, media_id_for_path
from script_organizer.slate_media_runtime import _safe_drop_item


def _project(tmp_path: Path, index: dict | None = None):
    return SimpleNamespace(
        project_id="P1",
        workspace_id="W1",
        index=index or {"clips": [], "groups": []},
        config=SimpleNamespace(output_dir=tmp_path / "output", camera_patterns={}),
    )


def test_explicit_drop_returns_path_free_identity_and_binds_only_device_state(tmp_path: Path) -> None:
    media = tmp_path / "A001.mov"
    media.write_bytes(b"mirrororder-synthetic-media" * 128)
    store = DeviceMediaStore(tmp_path / "device" / "media-bindings.json")

    item = _safe_drop_item(_project(tmp_path), store, str(media))

    assert item["media_id"].startswith("M_")
    assert item["camera"] == "A"
    assert item["display_name"] == "A001.mov"
    assert item["indexed"] is False
    assert all("path" not in key.lower() for key in item)
    assert str(media) not in repr(item)

    resolved = store.resolve("W1", "P1", {"media_id": item["media_id"]})
    assert Path(resolved) == media.resolve()
    assert not (tmp_path / "output" / "script_supervisor.json").exists()


def test_explicit_drop_reuses_indexed_clip_identity_without_exposing_path(tmp_path: Path) -> None:
    media = tmp_path / "camera_b.mov"
    media.write_bytes(b"camera-b" * 512)
    media_id = media_id_for_path(media)
    project = _project(
        tmp_path,
        {
            "clips": [
                {
                    "clip_id": "clip-b",
                    "media_id": media_id,
                    "camera": "B",
                    "name": "indexed-b",
                    "media_path": "/shared/source/camera_b.mov",
                }
            ],
            "groups": [],
        },
    )
    store = DeviceMediaStore(tmp_path / "device" / "media-bindings.json")

    item = _safe_drop_item(project, store, str(media))

    assert item == {
        "media_id": media_id,
        "clip_id": "clip-b",
        "camera": "B",
        "display_name": "camera_b.mov",
        "source_role": "sync_camera",
        "indexed": True,
    }
    assert str(media) not in repr(item)


def test_explicit_drop_rejects_unsupported_or_missing_files(tmp_path: Path) -> None:
    store = DeviceMediaStore(tmp_path / "device" / "media-bindings.json")
    text = tmp_path / "notes.txt"
    text.write_text("not media", encoding="utf-8")

    with pytest.raises(ValueError, match="不支持的素材格式"):
        _safe_drop_item(_project(tmp_path), store, str(text))
    with pytest.raises(ValueError, match="不存在"):
        _safe_drop_item(_project(tmp_path), store, str(tmp_path / "missing.mov"))
