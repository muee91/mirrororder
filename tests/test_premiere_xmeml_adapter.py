from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from script_organizer.config import ProjectConfig
from script_organizer.nle_delivery import export_timeline_premiere_delivery
from script_organizer.timeline_delivery import TIMELINE_DELIVERY_CONTRACT, UnsafeTimelineDelivery


def _tag(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def _config(tmp_path: Path) -> ProjectConfig:
    (tmp_path / "A.mov").write_bytes(b"")
    (tmp_path / "B.mov").write_bytes(b"")
    source = tmp_path / "input.fcpxml"
    source.write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.11">
  <resources>
    <format id="r1" name="FFVideoFormat1080p24" frameDuration="1/24s" width="1920" height="1080"/>
    <asset id="a1" name="A.mov" start="0s" duration="20s" format="r1" hasVideo="1" hasAudio="1">
      <media-rep kind="original-media" src="A.mov"/>
    </asset>
    <asset id="a2" name="B.mov" start="0s" duration="30s" format="r1" hasVideo="1" hasAudio="1">
      <media-rep kind="original-media" src="B.mov"/>
    </asset>
  </resources>
  <library><event name="Source"><project name="Source"><sequence format="r1" duration="20s" tcStart="0s" tcFormat="NDF"><spine/></sequence></project></event></library>
</fcpxml>
""",
        encoding="utf-8",
    )
    output = tmp_path / "output"
    output.mkdir()
    (output / "material_index.json").write_text(
        json.dumps(
            {
                "clips": [
                    {"clip_id": "clip-a", "source_asset_id": "a1", "source_start": 0.0, "source_end": 20.0},
                    {"clip_id": "clip-b", "source_asset_id": "a2", "source_start": 4.0, "source_end": 24.0},
                ]
            }
        ),
        encoding="utf-8",
    )
    return ProjectConfig(
        config_path=tmp_path / "project.toml",
        name="Demo",
        fcpxml=source,
        script=tmp_path / "script.docx",
        output_dir=output,
        transcript_dir=tmp_path / "transcripts",
    )


def _request() -> dict:
    return {
        "contract": TIMELINE_DELIVERY_CONTRACT,
        "authority": {"generation": "g-final", "revision": 12},
        "timeline": {
            "version": 2,
            "project_id": "p1",
            "sources": [
                {"source_id": "source:a", "clip_id": "clip-a", "media_id": "ma", "name": "A.mov", "duration_frames": 480},
                {"source_id": "source:b", "clip_id": "clip-b", "media_id": "mb", "name": "B.mov", "duration_frames": 720},
            ],
            "multicam_groups": [
                {
                    "group_id": "g1",
                    "angle_source_ids": ["source:a", "source:b"],
                    "angles": [
                        {"source_id": "source:a", "camera": "A", "name": "A.mov", "sync_start_frame": 0, "sync_end_frame": 480},
                        {"source_id": "source:b", "camera": "B", "name": "B.mov", "sync_start_frame": 96, "sync_end_frame": 576},
                    ],
                    "reference_source_id": "source:a",
                    "audio_source_id": "source:a",
                }
            ],
            "sequences": [
                {
                    "sequence_id": "main",
                    "name": "Main",
                    "frame_rate": {"numerator": 24, "denominator": 1},
                    "tracks": [
                        {
                            "track_id": "V1",
                            "kind": "video",
                            "clips": [
                                {"clip_id": "c1", "source_id": "source:a", "timeline_start": 0, "source_in": 48, "duration": 72, "enabled": True, "multicam_group_id": None, "selected_angle_source_id": None, "metadata": {}},
                                {"clip_id": "c2", "source_id": "source:a", "timeline_start": 96, "source_in": 240, "duration": 48, "enabled": True, "multicam_group_id": "g1", "selected_angle_source_id": "source:b", "metadata": {}},
                            ],
                        },
                        {"track_id": "A1", "kind": "audio", "clips": []},
                    ],
                    "markers": [{"marker_id": "m1", "position": 24, "duration": 0, "kind": "script", "label": "beat", "metadata": {}}],
                    "transitions": [],
                }
            ],
            "active_sequence_id": "main",
        },
    }


def test_exports_edit_and_multicam_source_sequences_without_vendor_runtime(tmp_path: Path) -> None:
    config = _config(tmp_path)
    report = export_timeline_premiere_delivery(config, _request(), expected_project_id="p1")

    assert report["contract"] == "premiere_timeline_delivery_report.v1"
    assert report["timeline_authority"] == {"generation": "g-final", "revision": 12}
    assert report["video_clip_count"] == 2
    assert report["multicam_source_clip_count"] == 2
    assert report["multicam_source_sequence_written"] is True
    assert report["markers_not_exported"] == 1
    assert report["persisted_report_contains_device_paths"] is False
    assert report["interchange_contains_device_media_paths"] is True
    assert report["shared_project_paths_written"] is False
    assert report["semantics"]["vendor_runtime_dependency"] is False

    output = config.output_dir / "timeline_premiere.xml"
    text = output.read_text(encoding="utf-8")
    assert "<!DOCTYPE xmeml>" in text
    assert "file://localhost" in text

    root = ET.parse(output).getroot()
    sequences = [item for item in root.iter() if _tag(item) == "sequence"]
    assert {item.get("id") for item in sequences} == {"mo_edit", "mo_multicam_sources"}

    edit = next(item for item in sequences if item.get("id") == "mo_edit")
    edit_items = [item for item in edit.iter() if _tag(item) == "clipitem"]
    assert len(edit_items) == 2
    assert edit_items[1].findtext("start") == "96"
    assert edit_items[1].findtext("in") == "336"
    assert edit_items[1].findtext("out") == "384"
    assert edit_items[1].findtext("enabled") == "TRUE"

    multicam = next(item for item in sequences if item.get("id") == "mo_multicam_sources")
    video = next(item for item in multicam.find("media") if _tag(item) == "video")
    video_tracks = list(video.findall("track"))
    assert len(video_tracks) == 2
    angle_items = [item for track in video_tracks for item in track.findall("clipitem")]
    assert len(angle_items) == 2
    by_name = {item.findtext("name"): item for item in angle_items}
    assert by_name["A.mov"].findtext("in") == "240"
    assert by_name["A.mov"].findtext("enabled") == "FALSE"
    assert by_name["B.mov"].findtext("in") == "336"
    assert by_name["B.mov"].findtext("enabled") == "TRUE"


def test_rejects_unresolved_multicam_selection(tmp_path: Path) -> None:
    request = _request()
    request["timeline"]["sequences"][0]["tracks"][0]["clips"][1]["selected_angle_source_id"] = None
    with pytest.raises(UnsafeTimelineDelivery, match="explicit selected multicam angle"):
        export_timeline_premiere_delivery(_config(tmp_path), request, expected_project_id="p1")


def test_rejects_multicam_audio_source_without_typed_angle_evidence(tmp_path: Path) -> None:
    request = _request()
    request["timeline"]["multicam_groups"][0]["audio_source_id"] = "source:external"
    request["timeline"]["sources"].append(
        {"source_id": "source:external", "clip_id": "clip-a", "media_id": "mx", "name": "External.wav", "duration_frames": 480}
    )
    with pytest.raises(UnsafeTimelineDelivery, match="audio source lacks typed angle evidence"):
        export_timeline_premiere_delivery(_config(tmp_path), request, expected_project_id="p1")


def test_rejects_transitions_instead_of_silently_dropping_them(tmp_path: Path) -> None:
    request = _request()
    request["timeline"]["sequences"][0]["transitions"] = [
        {"transition_id": "t1", "track_id": "V1", "left_clip_id": "c1", "right_clip_id": "c2", "duration": 4}
    ]
    with pytest.raises(UnsafeTimelineDelivery, match="does not support transitions"):
        export_timeline_premiere_delivery(_config(tmp_path), request, expected_project_id="p1")
