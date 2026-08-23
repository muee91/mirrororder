from __future__ import annotations

from fractions import Fraction
from pathlib import Path

from script_organizer.media_identity import DeviceMediaStore, media_id_for_path, provisional_media_id
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


def test_legacy_project_can_relink_unique_filename_before_reanalysis(tmp_path: Path) -> None:
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
    assert summary["resolved"] == 1
    assert store.resolve("ws_beef", "beef", index["clips"][0]) == str(local)


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
