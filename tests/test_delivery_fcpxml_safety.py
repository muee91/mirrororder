from __future__ import annotations

import json
from pathlib import Path

from script_organizer.config import ProjectConfig
from script_organizer.fcpxml_exporter import export


def test_delivery_export_keeps_source_fcpxml_byte_for_byte(tmp_path: Path) -> None:
    output = tmp_path / "output"
    output.mkdir()
    source = tmp_path / "source.fcpxml"
    source_bytes = b'<?xml version="1.0"?><fcpxml version="1.9"><resources/></fcpxml>\n'
    source.write_bytes(source_bytes)

    config = ProjectConfig(
        config_path=tmp_path / "project.toml",
        name="FCP Safety",
        fcpxml=source,
        script=tmp_path / "script.txt",
        output_dir=output,
        transcript_dir=tmp_path / "transcripts",
        input_kind="fcpxml",
    )
    (output / "material_index.json").write_text(json.dumps({"groups": []}), encoding="utf-8")
    (output / "script.json").write_text(json.dumps({"segments": []}), encoding="utf-8")
    (output / "matches.json").write_text(json.dumps({"by_segment": {}}), encoding="utf-8")

    report = export(config)

    assert (output / "organized.fcpxml").read_bytes() == source_bytes
    assert report["selection_contract"] == "delivery.v1"
    assert report["selection_manifest_version"] == 3
    assert report["keywords_written"] is False
    assert report["multicam_structure_modified"] is False
    assert "unchanged copy" in report["warning"]
