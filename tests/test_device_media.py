from __future__ import annotations

import json
from fractions import Fraction
from pathlib import Path

from script_organizer.media_identity import DeviceMediaStore, media_id_for_path, provisional_media_id
from script_organizer.device_media_runtime import _attach_project_media_runtime, _resolve_project_media_path
from script_organizer.models import Clip
from script_organizer.transcript import TranscriptStore, transcript_fingerprint


def test_same_media_bytes_have_same_media_id_across_paths(tmp_path: Path) -> None:
    left = tmp_path / "disk-a" / "A001.mov"
    right = tmp_path / "disk-b" / "renamed-copy.mov"
    left.parent.mkdir()
    right.parent.mkdir()
    payload = (b"mirrororder-media" * 1000) + b"tail"
    left.write_bytes(payload)
    right.write_bytes(payload)

    assert media_id_for_path(left).startswith("M_")
    assert media_id_for_path(left) == media_id_for_path(right)


def test_device_media_store_binds_verified_copy_without_shared_path_change(tmp_path: Path) -> None:
    source = tmp_path / "source" / "A001.mov"
    local = tmp_path / "local-copy" / "A001.mov"
    source.parent.mkdir()
    local.parent.mkdir()
    source.write_bytes(b"same-video-bytes" * 1000)
    local.write_bytes(source.read_bytes())
    media_id = media_id_for_path(source)

    index = {
        "clips": [
            {
                "clip_id": "C_test",
                "media_id": media_id,
                "name": "A001",
                "media_path": "/Volumes/OTHER/A001.mov",
            }
        ]
    }
    store = DeviceMediaStore(tmp_path / "device" / "media-bindings.json")
    summary = store.scan("ws_demo", "demo", index, [str(local.parent)])

    assert summary["total"] == 1
    assert summary["resolved"] == 1
    assert summary["missing"] == 0
    assert store.resolve("ws_demo", "demo", index["clips"][0]) == str(local)
    assert index["clips"][0]["media_path"] == "/Volumes/OTHER/A001.mov"


def test_legacy_project_unique_filename_requires_confirmation_before_relink(tmp_path: Path) -> None:
    local = tmp_path / "copies" / "A003C012.mov"
    local.parent.mkdir()
    local.write_bytes(b"legacy-copy")
    index = {
        "clips": [
            {
                "clip_id": "C_old",
                "name": "A003C012",
                "media_path": "/Volumes/PSSD/A003C012.mov",
            }
        ]
    }
    store = DeviceMediaStore(tmp_path / "state" / "media-bindings.json")
    summary = store.scan("ws_beef", "beef", index, [str(local.parent)])

    key = provisional_media_id("A003C012.mov")
    assert key.startswith("MP_")
    assert summary["resolved"] == 0
    assert summary["missing"] == 1
    assert summary["scan"]["provisional_name_matches"] == 0
    assert summary["scan"]["provisional_name_candidates"] == 1
    assert summary["items"][0]["candidate_path"] == str(local)
    assert summary["items"][0]["needs_confirmation"] is True
    assert store.resolve("ws_beef", "beef", index["clips"][0]) == ""

    store.confirm_provisional("ws_beef", "beef", key, str(local))
    confirmed = store.summary("ws_beef", "beef", index)
    assert confirmed["resolved"] == 1
    assert confirmed["items"][0]["needs_confirmation"] is False
    assert store.resolve("ws_beef", "beef", index["clips"][0]) == str(local)


def test_version_two_filename_binding_is_not_trusted_after_upgrade(tmp_path: Path) -> None:
    local = tmp_path / "copies" / "A003C012.mov"
    local.parent.mkdir()
    local.write_bytes(b"wrong-or-unverified-copy")
    state_path = tmp_path / "state" / "media-bindings.json"
    state_path.parent.mkdir()
    key = provisional_media_id("A003C012.mov")
    state_path.write_text(
        json.dumps(
            {
                "version": 2,
                "device_id": "device-old",
                "device_name": "old",
                "workspaces": {
                    "ws_beef": {
                        "projects": {
                            "beef": {
                                "roots": [str(local.parent)],
                                "bindings": {key: str(local)},
                                "updated_at": "",
                            }
                        }
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    index = {
        "clips": [
            {
                "clip_id": "C_old",
                "name": "A003C012",
                "media_path": "/Volumes/PSSD/A003C012.mov",
            }
        ]
    }

    store = DeviceMediaStore(state_path)
    assert store.resolve("ws_beef", "beef", index["clips"][0]) == ""

    summary = store.scan("ws_beef", "beef", index, [str(local.parent)])
    assert summary["resolved"] == 0
    assert summary["items"][0]["needs_confirmation"] is True
    snapshot = store.project_snapshot("ws_beef", "beef")
    assert key not in snapshot["bindings"]


def test_verified_identity_rejects_replaced_file_at_same_path(tmp_path: Path) -> None:
    source = tmp_path / "source" / "A001.mov"
    source.parent.mkdir()
    source.write_bytes(b"original-media" * 1000)
    media_id = media_id_for_path(source)
    index_item = {
        "clip_id": "C_verified",
        "media_id": media_id,
        "name": "A001",
        "media_path": str(source),
    }
    store = DeviceMediaStore(tmp_path / "state" / "media-bindings.json")

    assert store.resolve("ws_demo", "demo", index_item) == str(source)
    source.write_bytes(b"different-media" * 1000)

    assert store.resolve("ws_demo", "demo", index_item) == ""


def test_project_media_runtime_defers_content_hash_until_playback(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source" / "A001.mov"
    source.parent.mkdir()
    source.write_bytes(b"verified-media" * 1000)
    media_id = media_id_for_path(source)
    item = {
        "clip_id": "C_lazy",
        "media_id": media_id,
        "name": "A001",
        "media_path": str(source),
    }
    store = DeviceMediaStore(tmp_path / "state" / "media-bindings.json")
    project = type("Project", (), {"project_id": "demo"})()

    def fail_if_eagerly_hashed(_path):
        raise AssertionError("project construction must not hash all media")

    monkeypatch.setattr("script_organizer.device_media_runtime._apply_project", fail_if_eagerly_hashed)
    _attach_project_media_runtime(store, project, "ws_demo")
    assert _resolve_project_media_path(project, item) == str(source)


def test_replace_roots_discards_stale_project_bindings(tmp_path: Path) -> None:
    source = tmp_path / "source" / "A001.mov"
    stale = tmp_path / "wrong-project" / "A001.mov"
    correct = tmp_path / "correct-project" / "A001.mov"
    source.parent.mkdir()
    stale.parent.mkdir()
    correct.parent.mkdir()
    source.write_bytes(b"correct-media" * 1000)
    stale.write_bytes(b"wrong-media" * 1000)
    correct.write_bytes(source.read_bytes())
    media_id = media_id_for_path(source)
    index = {
        "clips": [
            {
                "clip_id": "C_replace",
                "media_id": media_id,
                "name": "A001",
                "media_path": "/Volumes/SOURCE/A001.mov",
            }
        ]
    }
    store = DeviceMediaStore(tmp_path / "state" / "media-bindings.json")
    store.scan("ws_demo", "demo", index, [str(stale.parent)])
    snapshot = store.replace_roots("ws_demo", "demo", [str(correct.parent)])

    assert snapshot["roots"] == [str(correct.parent.resolve())]
    assert snapshot["bindings"] == {}
    assert snapshot["candidates"] == {}
    assert snapshot["confirmed_provisional"] == {}

    summary = store.scan("ws_demo", "demo", index, [str(correct.parent)])
    assert summary["resolved"] == 1
    assert store.resolve("ws_demo", "demo", index["clips"][0]) == str(correct)


def test_same_project_id_isolated_between_workspaces(tmp_path: Path) -> None:
    source = tmp_path / "source" / "A001.mov"
    left = tmp_path / "left" / "A001.mov"
    right = tmp_path / "right" / "renamed.mov"
    source.parent.mkdir()
    left.parent.mkdir()
    right.parent.mkdir()
    source.write_bytes(b"same-media" * 1000)
    left.write_bytes(source.read_bytes())
    right.write_bytes(source.read_bytes())
    media_id = media_id_for_path(source)
    index = {
        "clips": [
            {
                "clip_id": "shared-clip",
                "media_id": media_id,
                "name": "A001",
                "media_path": "/Volumes/SOURCE/A001.mov",
            }
        ]
    }
    store = DeviceMediaStore(tmp_path / "state" / "media-bindings.json")
    store.scan("ws_left", "shared", index, [str(left.parent)])
    store.scan("ws_right", "shared", index, [str(right.parent)])

    assert store.resolve("ws_left", "shared", index["clips"][0]) == str(left)
    assert store.resolve("ws_right", "shared", index["clips"][0]) == str(right)
    payload = store.load()
    assert set(payload["workspaces"]) == {"ws_left", "ws_right"}
    assert set(payload["workspaces"]["ws_left"]["projects"]) == {"shared"}
    assert set(payload["workspaces"]["ws_right"]["projects"]) == {"shared"}


def test_new_transcript_cache_uses_media_id_not_absolute_path(tmp_path: Path) -> None:
    local = tmp_path / "disk" / "A001.mov"
    local.parent.mkdir()
    local.write_bytes(b"portable-transcript-source" * 1000)
    media_id = media_id_for_path(local)
    clip = Clip(
        clip_id="C_transcript",
        name="A001",
        camera="A",
        media_path=str(local),
        timeline_start=Fraction(0),
        timeline_end=Fraction(1),
        duration=Fraction(1),
        exists=True,
        media_id=media_id,
    )
    store = TranscriptStore(tmp_path / "transcripts")
    target = store.write(clip, "测试对白", [{"start": 0, "end": 1, "text": "测试对白"}])

    assert transcript_fingerprint(clip) == media_id
    assert target.name == f"{media_id}.json"
    loaded = store.load(clip)
    assert loaded is not None
    assert loaded.text == "测试对白"
