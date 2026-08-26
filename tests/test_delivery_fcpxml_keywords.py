from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

from script_organizer.config import ProjectConfig
from script_organizer.fcpxml_exporter import UnsafeFCPXMLExport, export


def _config(tmp_path: Path, source: Path) -> ProjectConfig:
    output = tmp_path / "output"
    output.mkdir()
    return ProjectConfig(
        config_path=tmp_path / "project.toml",
        name="Delivery Keywords",
        fcpxml=source,
        script=tmp_path / "script.txt",
        output_dir=output,
        transcript_dir=tmp_path / "transcripts",
        input_kind="fcpxml",
    )


def _write_delivery_facts(config: ProjectConfig, state: str = "best") -> None:
    output = config.output_dir
    (output / "material_index.json").write_text(
        json.dumps(
            {
                "clips": [
                    {
                        "clip_id": "C_1",
                        "source_asset_id": "a1",
                        "source_start": 2.0,
                        "source_end": 6.0,
                        "duration": 4.0,
                    }
                ],
                "groups": [
                    {
                        "group_id": "G_1",
                        "parent_group_id": "",
                        "members": [
                            {
                                "clip_id": "C_1",
                                "source_start": 2.0,
                                "source_end": 6.0,
                                "duration": 4.0,
                            }
                        ],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    (output / "script.json").write_text(
        json.dumps(
            {
                "segments": [
                    {
                        "segment_id": "S_1",
                        "episode": 1,
                        "scene_id": "SC_1",
                        "text": "你好",
                    }
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (output / "matches.json").write_text(
        json.dumps({"by_segment": {"S_1": [{"group_id": "G_1", "confidence": "exact_dialogue"}]}}),
        encoding="utf-8",
    )
    (output / "review.json").write_text(
        json.dumps(
            {
                "version": 2,
                "revision": 3,
                "assignments": {"S_1": {"G_1": {"state": state, "actor": "主剪"}}},
                "groups": {},
                "clips": {},
                "placements": {},
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def _source_xml(include_browser_clip: bool = True) -> bytes:
    browser = '<asset-clip name="A001" ref="a1" duration="10s" start="0s"/>' if include_browser_clip else ""
    return f'''<?xml version="1.0" encoding="utf-8"?>
<fcpxml version="1.9">
  <resources>
    <format id="r1" frameDuration="1/25s" width="1920" height="1080"/>
    <asset id="a1" name="A001" src="file:///A001.mov" format="r1" duration="10s" start="0s"/>
    <media id="m1"><multicam format="r1"><mc-angle name="A" angleID="A"><asset-clip ref="a1" duration="10s"/></mc-angle></multicam></media>
  </resources>
  <library><event name="Event">
    <project name="Project"><sequence format="r1" duration="10s"><spine><mc-clip ref="m1" duration="10s"/></spine></sequence></project>
    {browser}
  </event></library>
</fcpxml>'''.encode("utf-8")


def test_export_injects_frame_aligned_event_browser_keyword_without_touching_source(tmp_path: Path) -> None:
    source = tmp_path / "source.fcpxml"
    source_bytes = _source_xml()
    source.write_bytes(source_bytes)
    config = _config(tmp_path, source)
    _write_delivery_facts(config, "best")

    report = export(config)

    assert source.read_bytes() == source_bytes
    assert report["keywords_written"] is True
    assert report["keyword_count"] == 1
    assert report["decision_ranges_written"] == 1
    assert report["multicam_structure_modified"] is False

    root = ET.parse(config.output_dir / "organized.fcpxml").getroot()
    browser_clip = next(
        child
        for event in root.iter("event")
        for child in list(event)
        if child.tag == "asset-clip" and child.get("ref") == "a1"
    )
    keyword = next(child for child in list(browser_clip) if child.tag == "keyword")
    assert keyword.attrib == {
        "start": "2s",
        "duration": "4s",
        "value": "镜序｜Best｜E1｜S_1",
    }
    # The resource multicam stays structurally untouched: no keyword is written
    # into its angle clip or timeline mc-clip.
    multicam = next(root.iter("multicam"))
    assert not any(element.tag == "keyword" for element in multicam.iter())


def test_export_fails_closed_when_decision_cannot_map_to_event_browser_asset(tmp_path: Path) -> None:
    source = tmp_path / "source.fcpxml"
    source_bytes = _source_xml(include_browser_clip=False)
    source.write_bytes(source_bytes)
    config = _config(tmp_path, source)
    _write_delivery_facts(config, "reject")

    with pytest.raises(UnsafeFCPXMLExport, match="Event Browser asset-clip"):
        export(config)

    assert source.read_bytes() == source_bytes
    assert not (config.output_dir / "organized.fcpxml").exists()
