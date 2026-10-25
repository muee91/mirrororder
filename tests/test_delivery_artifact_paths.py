from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from script_organizer.config import ProjectConfig
from script_organizer.delivery_runtime import _decorate_premiere_report, _decorate_report, _decorate_timeline_report
from script_organizer.fcpxml_exporter import export
from script_organizer.nle_delivery import PREMIERE_XMEML_NAME
from script_organizer.nle_delivery import TIMELINE_FCPXML_NAME


def _config(tmp_path: Path) -> ProjectConfig:
    output = tmp_path / "project" / "output"
    output.mkdir(parents=True)
    script = tmp_path / "project" / "script.txt"
    script.write_text("synthetic", encoding="utf-8")
    config = ProjectConfig(
        config_path=tmp_path / "project" / "project.toml",
        name="Path Safe Delivery",
        fcpxml=None,
        script=script,
        output_dir=output,
        transcript_dir=tmp_path / "project" / "cache" / "transcripts",
        input_kind="media-directory",
    )
    (output / "material_index.json").write_text(json.dumps({"groups": [], "clips": []}), encoding="utf-8")
    (output / "script.json").write_text(json.dumps({"segments": []}), encoding="utf-8")
    (output / "matches.json").write_text(json.dumps({"by_segment": {}}), encoding="utf-8")
    return config


def test_persisted_delivery_manifest_and_report_are_path_free(tmp_path: Path) -> None:
    config = _config(tmp_path)
    report = export(config)

    persisted_report = json.loads((config.output_dir / "export_report.json").read_text(encoding="utf-8"))
    manifest = json.loads((config.output_dir / "selection_manifest.json").read_text(encoding="utf-8"))
    raw = json.dumps({"report": persisted_report, "manifest": manifest}, ensure_ascii=False)

    assert report == persisted_report
    assert persisted_report["organized_fcpxml"] == "organized.fcpxml"
    assert persisted_report["selection_manifest"] == "selection_manifest.json"
    assert persisted_report["artifact_scope"] == "project_output"
    assert persisted_report["device_paths_exposed"] is False
    assert manifest["version"] == 4
    assert manifest["semantics"]["device_paths_exposed"] is False
    assert str(tmp_path) not in raw
    assert "/Volumes/" not in raw
    assert "/Users/" not in raw
    assert "C:\\" not in raw


def test_local_delivery_response_resolves_only_allowlisted_artifact_refs(tmp_path: Path) -> None:
    config = _config(tmp_path)
    report = export(config)
    project = SimpleNamespace(config=config)

    decorated = _decorate_report(project, report)
    assert decorated["selection_manifest_ref"] == "selection_manifest.json"
    assert decorated["selection_manifest"] == str(config.output_dir / "selection_manifest.json")
    assert decorated["selection_manifest_exists"] is True
    assert decorated["organized_fcpxml_ref"] == "organized.fcpxml"
    assert decorated["organized_fcpxml"] == str(config.output_dir / "organized.fcpxml")
    assert decorated["organized_fcpxml_exists"] is False
    assert decorated["persisted_report_path_safe"] is True
    assert decorated["device_paths_exposed"] is True
    assert decorated["device_paths_scope"] == "localhost_response_only"

    malicious = _decorate_report(
        project,
        {
            **report,
            "selection_manifest": "../../outside.json",
            "organized_fcpxml": "/tmp/evil.fcpxml",
        },
    )
    assert malicious["selection_manifest"] == ""
    assert malicious["organized_fcpxml"] == ""
    assert malicious["selection_manifest_exists"] is False
    assert malicious["organized_fcpxml_exists"] is False


def test_timeline_delivery_response_resolves_only_the_allowlisted_timeline_artifact(tmp_path: Path) -> None:
    config = _config(tmp_path)
    project = SimpleNamespace(config=config)
    timeline_file = config.output_dir / TIMELINE_FCPXML_NAME
    timeline_file.write_text("<fcpxml/>", encoding="utf-8")
    report = {
        "contract": "timeline_delivery_report.v2",
        "artifact_scope": "project_output",
        "organized_fcpxml": TIMELINE_FCPXML_NAME,
        "timeline_authority": {"generation": "g1", "revision": 3},
        "device_paths_exposed": False,
    }

    decorated = _decorate_timeline_report(project, report)
    assert decorated["organized_fcpxml_ref"] == TIMELINE_FCPXML_NAME
    assert decorated["organized_fcpxml"] == str(timeline_file)
    assert decorated["organized_fcpxml_exists"] is True
    assert decorated["persisted_report_path_safe"] is True
    assert decorated["device_paths_exposed"] is True
    assert decorated["device_paths_scope"] == "localhost_response_only"

    malicious = _decorate_timeline_report(project, {**report, "organized_fcpxml": "../../outside.fcpxml"})
    assert malicious["organized_fcpxml"] == ""
    assert malicious["organized_fcpxml_exists"] is False


def test_premiere_delivery_response_resolves_only_the_allowlisted_export_artifact(tmp_path: Path) -> None:
    config = _config(tmp_path)
    project = SimpleNamespace(config=config)
    premiere_file = config.output_dir / PREMIERE_XMEML_NAME
    premiere_file.write_text("<xmeml version=\"4\"/>", encoding="utf-8")
    report = {
        "contract": "premiere_timeline_delivery_report.v1",
        "artifact_scope": "project_output",
        "premiere_xmeml": PREMIERE_XMEML_NAME,
        "timeline_authority": {"generation": "g1", "revision": 3},
        "persisted_report_contains_device_paths": False,
        "interchange_contains_device_media_paths": True,
    }

    decorated = _decorate_premiere_report(project, report)
    assert decorated["premiere_xmeml_ref"] == PREMIERE_XMEML_NAME
    assert decorated["premiere_xmeml"] == str(premiere_file)
    assert decorated["premiere_xmeml_exists"] is True
    assert decorated["persisted_report_path_safe"] is True
    assert decorated["device_paths_exposed"] is True
    assert decorated["device_paths_scope"] == "localhost_response_only"

    malicious = _decorate_premiere_report(project, {**report, "premiere_xmeml": "../../outside.xml"})
    assert malicious["premiere_xmeml"] == ""
    assert malicious["premiere_xmeml_exists"] is False
