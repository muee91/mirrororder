from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from script_organizer.timeline_audio_delivery import export_timeline_snapshot_with_audio
from script_organizer.timeline_delivery import UnsafeTimelineDelivery
from test_timeline_delivery import _config, _request, _tag


def _audio_clip(*, clip_id: str = "audio-1", source_id: str = "source:a", start: int = 24, source_in: int = 0, duration: int = 48) -> dict:
    return {
        "clip_id": clip_id,
        "source_id": source_id,
        "timeline_start": start,
        "source_in": source_in,
        "duration": duration,
        "enabled": True,
        "multicam_group_id": None,
        "selected_angle_source_id": None,
        "metadata": {"audio_role": "dialogue"},
    }


def _audio_track(request: dict) -> dict:
    return request["timeline"]["sequences"][0]["tracks"][1]


def test_exports_independent_audio_as_connected_audio_only_asset_clip(tmp_path: Path) -> None:
    config = _config(tmp_path)
    request = _request()
    _audio_track(request)["clips"] = [_audio_clip()]

    report = export_timeline_snapshot_with_audio(config, request, expected_project_id="p1")
    assert report["audio_track_count"] == 1
    assert report["audio_clip_count"] == 1
    assert report["semantics"]["embedded_asset_audio_preserved"] is True
    assert report["semantics"]["independent_audio_tracks_supported"] is True
    assert report["semantics"]["independent_audio_exported_as_connected_audio_only_assets"] is True

    root = ET.parse(config.output_dir / "timeline_organized.fcpxml").getroot()
    sequence = next(item for item in root.iter() if _tag(item) == "sequence")
    spine = next(item for item in sequence if _tag(item) == "spine")
    first_video = next(item for item in spine if _tag(item) == "asset-clip")
    audio = next(item for item in first_video if _tag(item) == "asset-clip")
    assert audio.attrib == {
        "name": "A.mov",
        "ref": "a1",
        "lane": "-1",
        # Primary clip starts at source time 2s. Audio begins 1s later in the
        # project, so the anchored item's base-element offset is 3s.
        "offset": "3s",
        "start": "0s",
        "duration": "2s",
        "srcEnable": "audio",
        "audioRole": "dialogue",
    }


def test_audio_after_video_tail_extends_sequence_and_anchors_to_trailing_gap(tmp_path: Path) -> None:
    config = _config(tmp_path)
    request = _request()
    _audio_track(request)["clips"] = [_audio_clip(start=150, duration=24)]

    export_timeline_snapshot_with_audio(config, request, expected_project_id="p1")
    root = ET.parse(config.output_dir / "timeline_organized.fcpxml").getroot()
    sequence = next(item for item in root.iter() if _tag(item) == "sequence")
    assert sequence.get("duration") == "29/4s"
    spine = next(item for item in sequence if _tag(item) == "spine")
    trailing = list(spine)[-1]
    assert _tag(trailing) == "gap"
    assert trailing.get("offset") == "6s"
    assert trailing.get("duration") == "5/4s"
    audio = next(item for item in trailing if _tag(item) == "asset-clip")
    assert audio.get("lane") == "-1"
    assert audio.get("offset") == "1/4s"
    assert audio.get("srcEnable") == "audio"


def test_multiple_audio_tracks_get_deterministic_negative_lanes(tmp_path: Path) -> None:
    config = _config(tmp_path)
    request = _request()
    sequence = request["timeline"]["sequences"][0]
    _audio_track(request)["clips"] = [_audio_clip(clip_id="a1", start=24, duration=24)]
    sequence["tracks"].append({"track_id": "A2", "kind": "audio", "clips": [_audio_clip(clip_id="a2", source_id="source:b", start=24, duration=24)]})

    report = export_timeline_snapshot_with_audio(config, request, expected_project_id="p1")
    assert report["audio_track_count"] == 2
    assert report["audio_clip_count"] == 2
    root = ET.parse(config.output_dir / "timeline_organized.fcpxml").getroot()
    lanes = sorted(
        int(item.get("lane"))
        for item in root.iter()
        if _tag(item) == "asset-clip" and item.get("srcEnable") == "audio"
    )
    assert lanes == [-2, -1]


def test_rejects_multicam_switch_semantics_on_independent_audio_clip(tmp_path: Path) -> None:
    request = _request()
    clip = _audio_clip()
    clip["multicam_group_id"] = "g1"
    clip["selected_angle_source_id"] = "source:b"
    _audio_track(request)["clips"] = [clip]
    with pytest.raises(UnsafeTimelineDelivery, match="one explicit source"):
        export_timeline_snapshot_with_audio(_config(tmp_path), request, expected_project_id="p1")


def test_rejects_overlapping_audio_clips_on_same_track(tmp_path: Path) -> None:
    request = _request()
    _audio_track(request)["clips"] = [
        _audio_clip(clip_id="a1", start=24, duration=48),
        _audio_clip(clip_id="a2", start=48, duration=48),
    ]
    with pytest.raises(UnsafeTimelineDelivery, match="audio clips overlap"):
        export_timeline_snapshot_with_audio(_config(tmp_path), request, expected_project_id="p1")


def test_rejects_asset_that_explicitly_declares_no_audio(tmp_path: Path) -> None:
    config = _config(tmp_path)
    tree = ET.parse(config.fcpxml)
    asset = next(item for item in tree.getroot().iter() if _tag(item) == "asset" and item.get("id") == "a1")
    asset.set("hasAudio", "0")
    tree.write(config.fcpxml, encoding="utf-8", xml_declaration=True)
    request = _request()
    _audio_track(request)["clips"] = [_audio_clip()]
    with pytest.raises(UnsafeTimelineDelivery, match="declares no audio"):
        export_timeline_snapshot_with_audio(config, request, expected_project_id="p1")
