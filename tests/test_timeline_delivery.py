from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from script_organizer.config import ProjectConfig
from script_organizer.timeline_delivery import (
    TIMELINE_DELIVERY_CONTRACT,
    UnsafeTimelineDelivery,
    export_timeline_snapshot,
)


def _config(tmp_path: Path) -> ProjectConfig:
    source = tmp_path / "input.fcpxml"
    source.write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<fcpxml version="1.11">
  <resources>
    <format id="r1" name="FFVideoFormat1080p24" frameDuration="1/24s" width="1920" height="1080"/>
    <asset id="a1" name="A.mov" start="0s" duration="20s" format="r1" hasVideo="1" hasAudio="1">
      <media-rep kind="original-media" src="file:///Volumes/SYNTH/A.mov"/>
    </asset>
    <asset id="a2" name="B.mov" start="0s" duration="30s" format="r1" hasVideo="1" hasAudio="1">
      <media-rep kind="original-media" src="file:///Volumes/SYNTH/B.mov"/>
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
            "version": 1,
            "project_id": "p1",
            "sources": [
                {"source_id": "source:a", "clip_id": "clip-a", "media_id": "ma", "name": "A.mov", "duration_frames": 480},
                {"source_id": "source:b", "clip_id": "clip-b", "media_id": "mb", "name": "B.mov", "duration_frames": 720},
            ],
            "multicam_groups": [{"group_id": "g1", "angle_source_ids": ["source:a", "source:b"]}],
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
                                    "enabled": True,
                                    "multicam_group_id": "g1",
                                    "selected_angle_source_id": "source:b",
                                    "metadata": {},
                                },
                            ],
                        },
                        {"track_id": "A1", "kind": "audio", "clips": []},
                    ],
                    "markers": [{"marker_id": "m1", "position": 24, "label": "beat"}],
                    "transitions": [],
                }
            ],
            "active_sequence_id": "main",
        },
    }


def _tag(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def test_exports_captured_rust_timeline_positions_source_ranges_and_authority(tmp_path: Path) -> None:
    config = _config(tmp_path)
    report = export_timeline_snapshot(config, _request(), expected_project_id="p1")

    assert report["contract"] == "timeline_delivery_report.v1"
    assert report["timeline_authority"] == {"generation": "g-final", "revision": 12}
    assert report["video_clip_count"] == 2
    assert report["multicam_flattened_count"] == 1
    assert report["markers_not_exported"] == 1
    assert report["organized_fcpxml"] == "timeline_organized.fcpxml"
    assert report["device_paths_exposed"] is False
    assert report["semantics"]["embedded_asset_audio_preserved"] is True
    assert "/Volumes/" not in json.dumps(report)

    root = ET.parse(config.output_dir / "timeline_organized.fcpxml").getroot()
    assert len([item for item in root.iter() if _tag(item) == "resources"]) == 1
    sequence = next(item for item in root.iter() if _tag(item) == "sequence")
    assert sequence.get("format") == "r1"
    assert sequence.get("duration") == "6s"
    assert sequence.get("tcStart") == "0s"
    assert sequence.get("tcFormat") == "NDF"
    assert sequence.get("audioLayout") == "stereo"
    assert sequence.get("audioRate") == "48k"
    spine = next(item for item in sequence if _tag(item) == "spine")
    children = list(spine)
    assert [_tag(item) for item in children] == ["asset-clip", "gap", "asset-clip"]
    assert children[0].attrib == {
        "name": "A.mov",
        "ref": "a1",
        "offset": "0s",
        "start": "2s",
        "duration": "3s",
    }
    assert children[1].get("offset") == "3s"
    assert children[1].get("duration") == "1s"
    assert children[2].attrib == {
        "name": "B.mov",
        "ref": "a2",
        "offset": "4s",
        "start": "14s",
        "duration": "2s",
    }


def test_rejects_timeline_project_mismatch(tmp_path: Path) -> None:
    with pytest.raises(UnsafeTimelineDelivery, match="project_id mismatch"):
        export_timeline_snapshot(_config(tmp_path), _request(), expected_project_id="other")


def test_rejects_independent_audio_tracks_until_semantics_are_supported(tmp_path: Path) -> None:
    request = _request()
    request["timeline"]["sequences"][0]["tracks"][1]["clips"] = [
        {
            "clip_id": "audio-1",
            "source_id": "source:a",
            "timeline_start": 0,
            "source_in": 0,
            "duration": 24,
            "enabled": True,
            "multicam_group_id": None,
            "selected_angle_source_id": None,
            "metadata": {},
        }
    ]
    with pytest.raises(UnsafeTimelineDelivery, match="independent audio-track"):
        export_timeline_snapshot(_config(tmp_path), request, expected_project_id="p1")


def test_rejects_transitions_instead_of_silently_dropping_them(tmp_path: Path) -> None:
    request = _request()
    request["timeline"]["sequences"][0]["transitions"] = [
        {"transition_id": "t1", "track_id": "V1", "left_clip_id": "c1", "right_clip_id": "c2", "duration": 4}
    ]
    with pytest.raises(UnsafeTimelineDelivery, match="does not support transitions"):
        export_timeline_snapshot(_config(tmp_path), request, expected_project_id="p1")


def test_rejects_missing_material_asset_mapping(tmp_path: Path) -> None:
    request = _request()
    request["timeline"]["sources"][1]["clip_id"] = "unknown-clip"
    with pytest.raises(UnsafeTimelineDelivery, match="no material-index FCPXML asset mapping"):
        export_timeline_snapshot(_config(tmp_path), request, expected_project_id="p1")


def test_rejects_overlapping_video_clips_even_if_client_payload_is_malformed(tmp_path: Path) -> None:
    request = _request()
    request["timeline"]["sequences"][0]["tracks"][0]["clips"][1]["timeline_start"] = 60
    with pytest.raises(UnsafeTimelineDelivery, match="overlap"):
        export_timeline_snapshot(_config(tmp_path), request, expected_project_id="p1")


def test_rejects_all_disabled_video_clips_instead_of_generating_an_empty_final_cut(tmp_path: Path) -> None:
    request = _request()
    for clip in request["timeline"]["sequences"][0]["tracks"][0]["clips"]:
        clip["enabled"] = False
    with pytest.raises(UnsafeTimelineDelivery, match="at least one enabled video clip"):
        export_timeline_snapshot(_config(tmp_path), request, expected_project_id="p1")


def test_rejects_ambiguous_same_rate_formats_without_a_project_sequence_format(tmp_path: Path) -> None:
    config = _config(tmp_path)
    tree = ET.parse(config.fcpxml)
    root = tree.getroot()
    resources = next(item for item in root if _tag(item) == "resources")
    ET.SubElement(resources, "format", {"id": "r2", "name": "Other24", "frameDuration": "1/24s", "width": "1280", "height": "720"})
    source_sequence = next(item for item in root.iter() if _tag(item) == "sequence")
    source_sequence.attrib.pop("format", None)
    tree.write(config.fcpxml, encoding="utf-8", xml_declaration=True)

    with pytest.raises(UnsafeTimelineDelivery, match="multiple matching formats"):
        export_timeline_snapshot(config, _request(), expected_project_id="p1")


def test_rejects_selected_multicam_angle_outside_declared_group(tmp_path: Path) -> None:
    request = _request()
    request["timeline"]["multicam_groups"][0]["angle_source_ids"] = ["source:a"]
    with pytest.raises(UnsafeTimelineDelivery, match="selected angle is not in multicam group"):
        export_timeline_snapshot(_config(tmp_path), request, expected_project_id="p1")


def test_rejects_unresolved_multicam_angle_instead_of_flattening_the_base_source(tmp_path: Path) -> None:
    request = _request()
    request["timeline"]["sequences"][0]["tracks"][0]["clips"][1]["selected_angle_source_id"] = None
    with pytest.raises(UnsafeTimelineDelivery, match="multicam clip has no selected angle"):
        export_timeline_snapshot(_config(tmp_path), request, expected_project_id="p1")


def test_rejects_multicam_rebase_without_selected_angle_source_start_evidence(tmp_path: Path) -> None:
    config = _config(tmp_path)
    payload = json.loads((config.output_dir / "material_index.json").read_text(encoding="utf-8"))
    payload["clips"][1].pop("source_start", None)
    (config.output_dir / "material_index.json").write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(UnsafeTimelineDelivery, match="source_start evidence"):
        export_timeline_snapshot(config, _request(), expected_project_id="p1")


def test_rejects_multicam_rebase_when_selected_occurrence_is_too_short(tmp_path: Path) -> None:
    config = _config(tmp_path)
    payload = json.loads((config.output_dir / "material_index.json").read_text(encoding="utf-8"))
    payload["clips"][1]["source_end"] = 15.0
    (config.output_dir / "material_index.json").write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(UnsafeTimelineDelivery, match="selected material occurrence"):
        export_timeline_snapshot(config, _request(), expected_project_id="p1")
