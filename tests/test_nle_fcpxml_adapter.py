from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from script_organizer.config import ProjectConfig
from script_organizer.nle_delivery import export_timeline_delivery
from script_organizer.nle_delivery import TIMELINE_DELIVERY_CONTRACT, UnsafeTimelineDelivery


def _tag(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def _config(tmp_path: Path) -> ProjectConfig:
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
  <library>
    <event name="Source">
      <project name="Source Project">
        <sequence format="r1" duration="20s" tcStart="3600s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine><asset-clip name="A" ref="a1" offset="0s" start="0s" duration="20s"/></spine>
        </sequence>
      </project>
    </event>
  </library>
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
                {
                    "source_id": "source:a",
                    "clip_id": "clip-a",
                    "media_id": "ma",
                    "name": "A.mov",
                    "duration_frames": 480,
                },
                {
                    "source_id": "source:b",
                    "clip_id": "clip-b",
                    "media_id": "mb",
                    "name": "B.mov",
                    "duration_frames": 720,
                },
            ],
            "multicam_groups": [
                {
                    "group_id": "g1",
                    "angle_source_ids": ["source:a", "source:b"],
                    "angles": [
                        {
                            "source_id": "source:a",
                            "camera": "A",
                            "name": "A.mov",
                            "sync_start_frame": 0,
                            "sync_end_frame": 480,
                        },
                        {
                            "source_id": "source:b",
                            "camera": "B",
                            "name": "B.mov",
                            "sync_start_frame": 96,
                            "sync_end_frame": 576,
                        },
                    ],
                    "reference_source_id": "source:a",
                    "audio_source_id": None,
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
                                {
                                    "clip_id": "c1",
                                    "source_id": "source:a",
                                    "timeline_start": 0,
                                    "source_in": 48,
                                    "duration": 72,
                                    "enabled": True,
                                    "multicam_group_id": None,
                                    "selected_angle_source_id": None,
                                    "metadata": {},
                                },
                                {
                                    "clip_id": "c2",
                                    "source_id": "source:a",
                                    "timeline_start": 96,
                                    "source_in": 240,
                                    "duration": 48,
                                    "enabled": False,
                                    "multicam_group_id": "g1",
                                    "selected_angle_source_id": "source:b",
                                    "metadata": {},
                                },
                            ],
                        },
                        {
                            "track_id": "A1",
                            "kind": "audio",
                            "clips": [
                                {
                                    "clip_id": "audio-1",
                                    "source_id": "source:a",
                                    "timeline_start": 24,
                                    "source_in": 0,
                                    "duration": 48,
                                    "enabled": True,
                                    "multicam_group_id": None,
                                    "selected_angle_source_id": None,
                                    "metadata": {"audio_role": "dialogue"},
                                }
                            ],
                        },
                    ],
                    "markers": [
                        {
                            "marker_id": "m1",
                            "position": 24,
                            "duration": 0,
                            "kind": "script",
                            "label": "SC12 · 2B · T4",
                            "metadata": {"scene": "SC12", "shot": "2B", "take": "T4"},
                        }
                    ],
                    "transitions": [],
                }
            ],
            "active_sequence_id": "main",
        },
    }


def test_exports_true_multicam_audio_markers_and_disabled_state(tmp_path: Path) -> None:
    config = _config(tmp_path)
    report = export_timeline_delivery(config, _request(), expected_project_id="p1")

    assert report["version"] == 2
    assert report["contract"] == "timeline_delivery_report.v2"
    assert report["timeline_authority"] == {"generation": "g-final", "revision": 12}
    assert report["video_clip_count"] == 2
    assert report["audio_track_count"] == 1
    assert report["audio_clip_count"] == 1
    assert report["multicam_resource_count"] == 1
    assert report["multicam_clip_count"] == 1
    assert report["multicam_flattened_count"] == 0
    assert report["marker_count"] == 1
    assert report["markers_not_exported"] == 0
    assert report["disabled_clip_count"] == 1
    assert report["semantics"]["multicam_structure_preserved"] is True
    assert report["semantics"]["markers_preserved"] is True
    assert report["semantics"]["independent_audio_tracks_supported"] is True
    assert report["device_paths_exposed"] is False

    root = ET.parse(config.output_dir / "timeline_organized.fcpxml").getroot()
    resources = next(item for item in root if _tag(item) == "resources")
    media = next(item for item in resources if _tag(item) == "media")
    multicam = next(item for item in media if _tag(item) == "multicam")
    angles = [item for item in multicam if _tag(item) == "mc-angle"]
    assert len(angles) == 2
    b_asset = next(item for item in angles[1] if _tag(item) == "asset-clip")
    assert b_asset.get("ref") == "a2"
    assert b_asset.get("offset") == "0s"
    assert b_asset.get("start") == "4s"
    assert b_asset.get("duration") == "20s"

    sequence = next(item for item in root.iter() if _tag(item) == "sequence")
    assert sequence.get("format") == "r1"
    assert sequence.get("duration") == "6s"
    assert sequence.get("tcStart") == "0s"
    spine = next(item for item in sequence if _tag(item) == "spine")
    assert [_tag(item) for item in list(spine)] == ["asset-clip", "gap", "mc-clip"]

    first = list(spine)[0]
    marker = next(item for item in first if _tag(item) == "marker")
    assert marker.get("start") == "3s"
    assert marker.get("duration") == "1/24s"
    marker_note = json.loads(marker.get("note", "{}"))
    assert marker_note == {
        "duration_frames": 0,
        "kind": "script",
        "metadata": {"scene": "SC12", "shot": "2B", "take": "T4"},
        "mirrororder_marker_id": "m1",
    }

    audio = next(item for item in first if _tag(item) == "asset-clip")
    assert audio.get("lane") == "-1"
    assert audio.get("offset") == "3s"
    assert audio.get("start") == "0s"
    assert audio.get("duration") == "2s"
    assert audio.get("srcEnable") == "audio"
    assert audio.get("audioRole") == "dialogue"

    mc_clip = list(spine)[2]
    assert mc_clip.get("start") == "10s"
    assert mc_clip.get("duration") == "2s"
    assert mc_clip.get("enabled") == "0"
    mc_sources = [item for item in mc_clip if _tag(item) == "mc-source"]
    assert len(mc_sources) == 1
    assert mc_sources[0].get("srcEnable") == "all"


def test_multicam_can_select_different_video_and_audio_angles(tmp_path: Path) -> None:
    request = _request()
    request["timeline"]["multicam_groups"][0]["audio_source_id"] = "source:a"
    request["timeline"]["sequences"][0]["tracks"][0]["clips"][1]["enabled"] = True

    config = _config(tmp_path)
    export_timeline_delivery(config, request, expected_project_id="p1")
    root = ET.parse(config.output_dir / "timeline_organized.fcpxml").getroot()
    mc_clip = next(item for item in root.iter() if _tag(item) == "mc-clip")
    mc_sources = [item for item in mc_clip if _tag(item) == "mc-source"]
    assert [item.get("srcEnable") for item in mc_sources] == ["video", "audio"]
    assert mc_sources[0].get("angleID") != mc_sources[1].get("angleID")


def test_rejects_unresolved_multicam_angle(tmp_path: Path) -> None:
    request = _request()
    request["timeline"]["sequences"][0]["tracks"][0]["clips"][1]["selected_angle_source_id"] = None
    with pytest.raises(UnsafeTimelineDelivery, match="explicit selected multicam angle"):
        export_timeline_delivery(_config(tmp_path), request, expected_project_id="p1")


def test_rejects_missing_typed_multicam_sync(tmp_path: Path) -> None:
    request = _request()
    request["timeline"]["multicam_groups"][0]["angles"][1]["sync_start_frame"] = None
    request["timeline"]["multicam_groups"][0]["angles"][1]["sync_end_frame"] = None
    with pytest.raises(UnsafeTimelineDelivery, match="typed sync range"):
        export_timeline_delivery(_config(tmp_path), request, expected_project_id="p1")


def test_rejects_transitions_instead_of_silently_dropping_them(tmp_path: Path) -> None:
    request = _request()
    request["timeline"]["sequences"][0]["transitions"] = [
        {
            "transition_id": "t1",
            "track_id": "V1",
            "left_clip_id": "c1",
            "right_clip_id": "c2",
            "duration": 4,
        }
    ]
    with pytest.raises(UnsafeTimelineDelivery, match="does not support transitions"):
        export_timeline_delivery(_config(tmp_path), request, expected_project_id="p1")
