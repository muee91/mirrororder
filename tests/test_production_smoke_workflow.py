from __future__ import annotations

import hashlib
import json
import xml.etree.ElementTree as ET
from pathlib import Path

from script_organizer.config import ProjectConfig
from script_organizer.nle_delivery import export_timeline_delivery, export_timeline_premiere_delivery
from script_organizer.nle_delivery import TIMELINE_DELIVERY_CONTRACT, TIMELINE_FCPXML_NAME


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _config(tmp_path: Path) -> ProjectConfig:
    for name in ("A.mov", "B.mov", "C.mov"):
        (tmp_path / name).write_bytes(b"")
    source = tmp_path / "input.fcpxml"
    source.write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.11">
  <resources>
    <format id="r1" name="FFVideoFormat1080p24" frameDuration="1/24s" width="1920" height="1080"/>
    <asset id="a1" name="A.mov" start="0s" duration="30s" format="r1" hasVideo="1" hasAudio="1"><media-rep kind="original-media" src="A.mov"/></asset>
    <asset id="a2" name="B.mov" start="0s" duration="30s" format="r1" hasVideo="1" hasAudio="1"><media-rep kind="original-media" src="B.mov"/></asset>
    <asset id="a3" name="C.mov" start="0s" duration="30s" format="r1" hasVideo="1" hasAudio="1"><media-rep kind="original-media" src="C.mov"/></asset>
  </resources>
  <library><event name="Source"><project name="Source"><sequence format="r1" duration="30s" tcStart="0s" tcFormat="NDF"><spine/></sequence></project></event></library>
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
                    {"clip_id": "clip-a", "source_asset_id": "a1", "source_start": 0.0, "source_end": 30.0},
                    {"clip_id": "clip-b", "source_asset_id": "a2", "source_start": 0.0, "source_end": 30.0},
                    {"clip_id": "clip-c", "source_asset_id": "a3", "source_start": 0.0, "source_end": 30.0},
                ]
            }
        ),
        encoding="utf-8",
    )
    return ProjectConfig(
        config_path=tmp_path / "project.toml",
        name="Production Smoke",
        fcpxml=source,
        script=tmp_path / "script.docx",
        output_dir=output,
        transcript_dir=tmp_path / "transcripts",
    )


def _request() -> dict:
    return {
        "contract": TIMELINE_DELIVERY_CONTRACT,
        "authority": {"generation": "g-production-smoke", "revision": 9},
        "timeline": {
            "version": 2,
            "project_id": "p1",
            "sources": [
                {"source_id": "source:a", "clip_id": "clip-a", "media_id": "ma", "name": "A.mov", "duration_frames": 720},
                {"source_id": "source:b", "clip_id": "clip-b", "media_id": "mb", "name": "B.mov", "duration_frames": 720},
                {"source_id": "source:c", "clip_id": "clip-c", "media_id": "mc", "name": "C.mov", "duration_frames": 720},
            ],
            "multicam_groups": [
                {
                    "group_id": "g-multicam",
                    "angle_source_ids": ["source:a", "source:b"],
                    "angles": [
                        {"source_id": "source:a", "camera": "A", "name": "A.mov", "sync_start_frame": 0, "sync_end_frame": 600},
                        {"source_id": "source:b", "camera": "B", "name": "B.mov", "sync_start_frame": 24, "sync_end_frame": 624},
                    ],
                    "reference_source_id": "source:a",
                    "audio_source_id": "source:a",
                }
            ],
            "sequences": [
                {
                    "sequence_id": "main",
                    "name": "镜序生产验收",
                    "frame_rate": {"numerator": 24, "denominator": 1},
                    "tracks": [
                        {
                            "track_id": "V1",
                            "kind": "video",
                            "clips": [
                                {
                                    "clip_id": "clip-replaced-take",
                                    "source_id": "source:c",
                                    "timeline_start": 0,
                                    "source_in": 48,
                                    "duration": 72,
                                    "enabled": True,
                                    "multicam_group_id": None,
                                    "selected_angle_source_id": None,
                                    "metadata": {
                                        "group_id": "g-take-3",
                                        "segment_id": "s1",
                                        "script_segment_ids": "[\"s1\"]",
                                        "edit_source": "replace_take",
                                        "decision_source": "editorial_decision",
                                    },
                                },
                                {
                                    "clip_id": "clip-multicam",
                                    "source_id": "source:a",
                                    "timeline_start": 72,
                                    "source_in": 120,
                                    "duration": 48,
                                    "enabled": True,
                                    "multicam_group_id": "g-multicam",
                                    "selected_angle_source_id": "source:b",
                                    "metadata": {"group_id": "g-take-4", "segment_id": "s2"},
                                },
                            ],
                        },
                        {
                            "track_id": "A1",
                            "kind": "audio",
                            "clips": [
                                {
                                    "clip_id": "audio-1",
                                    "source_id": "source:c",
                                    "timeline_start": 0,
                                    "source_in": 48,
                                    "duration": 48,
                                    "enabled": True,
                                    "multicam_group_id": None,
                                    "selected_angle_source_id": None,
                                    "metadata": {"group_id": "g-take-3"},
                                }
                            ],
                        },
                    ],
                    "markers": [
                        {
                            "marker_id": "m-script",
                            "position": 36,
                            "duration": 0,
                            "kind": "script",
                            "label": "第12场表演转折",
                            "metadata": {"script_segment_id": "s1"},
                        }
                    ],
                    "transitions": [],
                }
            ],
            "active_sequence_id": "main",
        },
    }


def _local_tag(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def test_production_smoke_preserves_editorial_timeline_across_both_nle_adapters(tmp_path: Path) -> None:
    config = _config(tmp_path)
    request = _request()

    fcp_report = export_timeline_delivery(config, request, expected_project_id="p1")
    premiere_report = export_timeline_premiere_delivery(config, request, expected_project_id="p1")

    assert fcp_report["timeline_authority"] == request["authority"]
    assert premiere_report["timeline_authority"] == request["authority"]
    assert fcp_report["video_clip_count"] == 2
    assert fcp_report["audio_clip_count"] == 1
    assert fcp_report["multicam_clip_count"] == 1
    assert fcp_report["marker_count"] == 1
    assert fcp_report["multicam_flattened_count"] == 0
    assert premiere_report["video_clip_count"] == 2
    assert premiere_report["multicam_source_sequence_written"] is True
    assert premiere_report["markers_not_exported"] == 1

    fcpxml = config.output_dir / TIMELINE_FCPXML_NAME
    premiere = config.output_dir / "timeline_premiere.xml"
    fcp_first = _sha256(fcpxml)
    premiere_first = _sha256(premiere)

    # Same immutable Timeline authority must generate byte-identical interchange.
    export_timeline_delivery(config, request, expected_project_id="p1")
    export_timeline_premiere_delivery(config, request, expected_project_id="p1")
    assert _sha256(fcpxml) == fcp_first
    assert _sha256(premiere) == premiere_first

    fcp_root = ET.parse(fcpxml).getroot()
    assert any(_local_tag(item) == "multicam" for item in fcp_root.iter())
    assert any(_local_tag(item) == "mc-clip" for item in fcp_root.iter())
    assert any(_local_tag(item) == "marker" and item.get("value") == "第12场表演转折" for item in fcp_root.iter())

    premiere_root = ET.parse(premiere).getroot()
    sequence_ids = {item.get("id") for item in premiere_root.iter() if _local_tag(item) == "sequence"}
    assert sequence_ids == {"mo_edit", "mo_multicam_sources"}
