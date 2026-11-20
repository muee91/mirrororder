from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from script_organizer.media_batch_relink import (
    RELINK_CONTRACT,
    classify_audio_asset_role,
    preview_directory_relink,
)
from script_organizer.media_identity import media_id_for_path


@pytest.fixture
def sandbox():
    with tempfile.TemporaryDirectory() as directory:
        yield Path(directory)


def _make_media(path: Path, payload: bytes) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return media_id_for_path(path)


def test_exact_media_id_relink_hit(sandbox: Path) -> None:
    source = sandbox / "source" / "A001.mov"
    media_id = _make_media(source, b"mirrororder-exact-video" * 64)
    index = {
        "clips": [
            {
                "clip_id": "C1",
                "media_id": media_id,
                "file_name": "A001.mov",
                "media_path": "/Volumes/OLD/A001.mov",
                "size_bytes": source.stat().st_size,
            },
            # Same physical media appears in a second clip: must be de-duplicated.
            {"clip_id": "C2", "media_id": media_id, "name": "A001.mov"},
        ]
    }

    scan = sandbox / "new-drive"
    found = scan / "A001.mov"
    _make_media(found, source.read_bytes())

    result = preview_directory_relink(index, scan)

    assert result["contract"] == RELINK_CONTRACT
    assert result["scope"] == "device_local_response"
    assert result["truncated"] is False
    assert result["summary"] == {
        "total_media": 1,
        "exact_count": 1,
        "filename_only_count": 0,
        "missing_count": 0,
    }
    row = result["matched_exact"][0]
    assert row["confidence"] == "exact_media_id"
    assert row["requires_confirmation"] is False
    assert row["candidate_path"] == str(found)
    assert result["matched_filename_only"] == []
    assert result["still_missing"] == []
    assert index["clips"][0]["media_path"] == "/Volumes/OLD/A001.mov"


def test_filename_only_downgrade_with_and_without_expected_size(sandbox: Path) -> None:
    lost_with_size = sandbox / "lost" / "B002.mov"
    id_with_size = _make_media(lost_with_size, b"original-b002" * 40)
    lost_no_size = sandbox / "lost" / "B003.mov"
    id_no_size = _make_media(lost_no_size, b"original-b003" * 40)

    scan = sandbox / "drive"
    # Same size, different bytes: size prefilter passes but fingerprint fails.
    _make_media(scan / "B002.mov", b"X" * lost_with_size.stat().st_size)
    # No expected size in the index at all: filename-only fallback.
    _make_media(scan / "B003.mov", b"totally-different-b003" * 40)

    index = {
        "clips": [
            {
                "media_id": id_with_size,
                "file_name": "B002.mov",
                "size_bytes": lost_with_size.stat().st_size,
            },
            {"media_id": id_no_size, "name": "B003.mov"},
        ]
    }

    result = preview_directory_relink(index, scan)

    assert result["summary"] == {
        "total_media": 2,
        "exact_count": 0,
        "filename_only_count": 2,
        "missing_count": 0,
    }
    rows = {row["media_id"]: row for row in result["matched_filename_only"]}
    assert rows[id_with_size]["confidence"] == "filename_only"
    assert rows[id_with_size]["requires_confirmation"] is True
    assert rows[id_no_size]["requires_confirmation"] is True
    assert result["matched_exact"] == []


def test_still_missing_and_hidden_directories_skipped(sandbox: Path) -> None:
    missing_id = _make_media(sandbox / "lost" / "C003.mov", b"missing-c003" * 50)
    scan = sandbox / "drive"
    # Identical bytes in hidden directories must NOT be treated as a relink hit.
    _make_media(scan / ".git" / "C003.mov", b"missing-c003" * 50)
    _make_media(scan / ".Trashes" / "C003.mov", b"missing-c003" * 50)

    result = preview_directory_relink(
        {"clips": [{"media_id": missing_id, "file_name": "C003.mov"}]}, scan
    )

    assert result["summary"] == {
        "total_media": 1,
        "exact_count": 0,
        "filename_only_count": 0,
        "missing_count": 1,
    }
    assert result["still_missing"][0]["media_id"] == missing_id
    assert result["matched_exact"] == []


def test_symlink_outside_scan_root_is_not_followed(sandbox: Path) -> None:
    outside = sandbox / "outside"
    leak_id = _make_media(outside / "LEAK.mov", b"leaked-media" * 60)
    scan = sandbox / "drive"
    scan.mkdir()

    try:
        (scan / "mount").symlink_to(outside, target_is_directory=True)
        (scan / "LEAK2.mov").symlink_to(outside / "LEAK.mov")
    except OSError:  # pragma: no cover - symlink-restricted platforms
        pytest.skip("symlinks are not available on this platform")

    # A symlink whose target stays inside scan_root is still usable.
    internal = scan / "real" / "KEEP.mov"
    keep_id = _make_media(internal, b"kept-media" * 60)
    (scan / "KEEP_link.mov").symlink_to(internal)

    index = {
        "clips": [
            {"media_id": leak_id, "file_name": "LEAK.mov"},
            {"media_id": leak_id + "_FILE", "file_name": "LEAK2.mov"},
            {"media_id": keep_id, "file_name": "KEEP_link.mov"},
        ]
    }

    result = preview_directory_relink(index, scan)

    assert result["symlinks_skipped"] >= 2
    assert {row["media_id"] for row in result["still_missing"]} == {
        leak_id,
        leak_id + "_FILE",
    }
    assert [row["media_id"] for row in result["matched_exact"]] == [keep_id]
    for group in ("matched_exact", "matched_filename_only"):
        for row in result[group]:
            assert "outside" not in row["candidate_path"]


def test_max_files_truncation(sandbox: Path) -> None:
    scan = sandbox / "drive"
    for index in range(5):
        _make_media(scan / f"clip_{index}.mov", bytes([index + 1]) * 128)

    limited = preview_directory_relink({"clips": []}, scan, max_files=3)
    assert limited["truncated"] is True
    assert limited["files_scanned"] == 3

    exact = preview_directory_relink({"clips": []}, scan, max_files=5)
    assert exact["truncated"] is False
    assert exact["files_scanned"] == 5


def test_preview_is_read_only_for_shared_index(sandbox: Path) -> None:
    project = sandbox / "project"
    project.mkdir()
    index_path = project / "material_index.json"
    payload = {
        "clips": [
            {
                "media_id": "M_DOES_NOT_EXIST",
                "name": "ghost.mov",
                "media_path": "/Volumes/OLD/ghost.mov",
            }
        ]
    }
    index_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    before = index_path.read_bytes()

    scan = sandbox / "drive"
    scan.mkdir()
    result = preview_directory_relink(json.loads(before), scan)

    assert result["summary"]["missing_count"] == 1
    assert index_path.read_bytes() == before
    assert [item.name for item in project.iterdir()] == ["material_index.json"]


def test_classify_audio_music_pool() -> None:
    for value in (
        "audio/BGM_01.wav",
        "project/music/theme.mp3",
        "配乐/片头.aac",
        "ost/main.m4a",
    ):
        result = classify_audio_asset_role(value)
        assert result["role"] == "music"
        assert result["sync_eligible"] is False

    assert classify_audio_asset_role("audio/BGM_01.wav")["confidence"] == "high"
    compressed = classify_audio_asset_role("takes/random_take.mp3")
    assert compressed["confidence"] == "low"
    assert "requires confirmation" in compressed["reason"]


def test_classify_audio_sfx_pool() -> None:
    for value in ("sfx/whoosh.wav", "音效/转场_01.wav", "foley/footsteps.aiff"):
        result = classify_audio_asset_role(value)
        assert result["role"] == "sfx"
        assert result["confidence"] == "high"
        assert result["sync_eligible"] is False


def test_classify_audio_sync_recording_pool() -> None:
    for value in ("T01_Zoom.wav", "SoundDevices/boom_同期.wav", "take/lav_ch1.wav"):
        result = classify_audio_asset_role(value)
        assert result["role"] == "sync_recording"
        assert result["confidence"] == "high"
        assert result["sync_eligible"] is True

    multichannel = classify_audio_asset_role("Ambient.wav", channels=2)
    assert multichannel["role"] == "sync_recording"
    assert multichannel["confidence"] == "medium"
    assert multichannel["sync_eligible"] is True


def test_classify_audio_ambiguous_wav_and_result_shape() -> None:
    plain = classify_audio_asset_role(Path("misc/clip.wav"))
    assert plain["role"] == "sync_recording"
    assert plain["confidence"] == "low"
    assert plain["sync_eligible"] is True

    short = classify_audio_asset_role(Path("misc/clip.wav"), duration_seconds=0.4)
    assert short["role"] == "sfx"
    assert short["confidence"] == "low"
    assert short["sync_eligible"] is False

    assert set(plain) == {"role", "confidence", "reason", "sync_eligible"}
    assert plain["confidence"] in {"high", "medium", "low"}
    assert isinstance(plain["sync_eligible"], bool)


def test_audio_classifier_avoids_substring_false_positives() -> None:
    # "ost" inside "post" or "lost" must NOT hijack on-set sync recordings as music.
    post_boom = classify_audio_asset_role("/Volumes/SSD/post_production/sync/Boom_01.wav")
    assert post_boom["role"] == "sync_recording"
    assert post_boom["sync_eligible"] is True

    lost_take = classify_audio_asset_role("/Volumes/SSD/lost_footage/T02_MixPre.wav")
    assert lost_take["role"] == "sync_recording"
    assert lost_take["sync_eligible"] is True

    # Real OST token still classifies as music.
    real_ost = classify_audio_asset_role("/Volumes/SSD/audio/OST_01_Theme.wav")
    assert real_ost["role"] == "music"
    assert real_ost["sync_eligible"] is False


def test_relink_rejects_missing_scan_root_and_ignores_sidecar_stem_collisions(sandbox: Path) -> None:
    with pytest.raises(ValueError, match="扫描目录不存在"):
        preview_directory_relink({"clips": []}, sandbox / "does-not-exist")

    scan = sandbox / "drive"
    _make_media(scan / "A001.xml", b"<sidecar/>")
    _make_media(scan / "A001.jpg", b"\xff\xd8\xff\xe0thumb")
    _make_media(scan / "A001.wav", b"RIFF0000WAVEfmt ")

    result = preview_directory_relink(
        {"clips": [{"media_id": "M_MISSING_VIDEO", "file_name": "A001.mov"}]},
        scan,
    )
    assert result["matched_exact"] == []
    assert result["matched_filename_only"] == []
    assert len(result["still_missing"]) == 1
