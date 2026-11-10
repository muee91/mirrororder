"""Export a synthetic Desktop proposal through the real Python NLE adapters."""
from __future__ import annotations

import json
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

from script_organizer.config import ProjectConfig
from script_organizer.nle_delivery import (
    TIMELINE_DELIVERY_CONTRACT,
    TIMELINE_FCPXML_NAME,
    UnsafeTimelineDelivery,
    export_timeline_delivery,
    export_timeline_premiere_delivery,
)
from script_organizer.nle_sequence_ir import build_nle_sequence_ir


def export(project: dict, root: Path) -> dict:
    rate = project["sequences"][0]["frame_rate"]
    tree = ET.Element("fcpxml", version="1.11")
    resources = ET.SubElement(tree, "resources")
    ET.SubElement(resources, "format", id="r1", frameDuration=f"{rate['denominator']}/{rate['numerator']}s", width="1920", height="1080")
    clips = []
    for index, source in enumerate(project["sources"]):
        asset_id = f"asset{index}"
        name = f"{index}.mov"
        (root / name).write_bytes(b"")
        asset = ET.SubElement(resources, "asset", id=asset_id, name=source["name"], start="0s", duration="60s", format="r1", hasVideo="1", hasAudio="1")
        ET.SubElement(asset, "media-rep", kind="original-media", src=name)
        clips.append({"clip_id": source["clip_id"], "source_asset_id": asset_id, "source_start": 0.0, "source_end": 60.0})
    event = ET.SubElement(ET.SubElement(tree, "library"), "event", name="Synthetic")
    sequence = ET.SubElement(ET.SubElement(event, "project", name="Synthetic"), "sequence", format="r1", duration="60s", tcStart="0s", tcFormat="NDF")
    ET.SubElement(sequence, "spine")
    input_path = root / "input.fcpxml"
    ET.ElementTree(tree).write(input_path, encoding="utf-8", xml_declaration=True)
    output = root / "output"
    output.mkdir()
    (output / "material_index.json").write_text(json.dumps({"clips": clips}), encoding="utf-8")
    config = ProjectConfig(config_path=root / "project.toml", name="Synthetic", fcpxml=input_path, script=root / "script.txt", output_dir=output, transcript_dir=root / "transcripts")
    request = {"contract": TIMELINE_DELIVERY_CONTRACT, "authority": {"generation": "test", "revision": 1}, "timeline": project}
    result = {}
    for name, adapter in (("fcpxml", export_timeline_delivery), ("premiere", export_timeline_premiere_delivery)):
        try:
            report = adapter(config, request, expected_project_id="p1")
            result[name] = {"ok": True, "video_clip_count": report["video_clip_count"]}
        except UnsafeTimelineDelivery as error:
            result[name] = {"ok": False, "error": str(error)}
    if result["premiere"]["ok"]:
        edit = ET.parse(output / "timeline_premiere.xml").find(".//sequence[@id='mo_edit']/media/video/track/clipitem")
        result["premiere"]["edit"] = {key: edit.findtext(key) for key in ("name", "in", "out")}
    if result["fcpxml"]["ok"]:
        fcpxml = ET.parse(output / TIMELINE_FCPXML_NAME)
        selected_id = fcpxml.find(".//mc-clip/mc-source").get("angleID")
        result["fcpxml"]["selected_angle"] = fcpxml.find(f".//mc-angle[@angleID='{selected_id}']").get("name")
    if result["fcpxml"]["ok"] and result["premiere"]["ok"]:
        ir = build_nle_sequence_ir(project)
        result["resources"] = {"groups": [group["group_id"] for group in ir["multicam_groups"]], "sources": [source["source_id"] for source in ir["sources"]]}
    return result


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="mirrororder-assembly-delivery-") as temporary:
        print(json.dumps(export(json.load(sys.stdin), Path(temporary))))
