from __future__ import annotations

import json
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import unquote

from script_organizer.media_relink import (
    materialize_portable_fcpxml,
    rewrite_fcpxml_media,
    rewrite_premiere_media,
    write_relink_manifest,
)


def _asset_src(path: Path) -> str:
    tree = ET.parse(path)
    asset = next(element for element in tree.getroot().iter() if element.tag.rsplit("}", 1)[-1] == "asset")
    return asset.attrib["src"]


def test_fcpxml_references_real_media_not_temporary_sync_symlink(tmp_path: Path) -> None:
    source_root = tmp_path / "原始 素材"
    camera = source_root / "A1"
    camera.mkdir(parents=True)
    media = camera / "片段 01.mov"
    media.write_bytes(b"media")

    stage = tmp_path / "project" / "output" / ".multicam-sync" / "media-layout"
    day = stage / "day1"
    day.mkdir(parents=True)
    (day / "A1").symlink_to(camera, target_is_directory=True)

    delivery = tmp_path / "project" / "output" / "sync"
    delivery.mkdir(parents=True)
    fcpxml = delivery / "synchronized.fcpxml"
    staged_media = day / "A1" / media.name
    fcpxml.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<fcpxml version="1.8"><resources>'
        f'<asset id="r1" name="clip" src="{staged_media.as_uri()}" />'
        '</resources></fcpxml>',
        encoding="utf-8",
    )

    report = rewrite_fcpxml_media(fcpxml, scan_root=stage, source_root=source_root)

    assert report["rewritten"] == 1
    assert _asset_src(fcpxml) == media.resolve().as_uri()
    assert ".multicam-sync" not in fcpxml.read_text(encoding="utf-8")


def test_portable_fcpxml_keeps_only_media_root_relative_hierarchy(tmp_path: Path) -> None:
    source_root = tmp_path / "素材 根目录"
    media = source_root / "第一天" / "B1" / "镜头 001.mov"
    media.parent.mkdir(parents=True)
    media.write_bytes(b"media")

    local_xml = tmp_path / "delivery" / "synchronized.fcpxml"
    local_xml.parent.mkdir(parents=True)
    local_xml.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<fcpxml version="1.8"><resources>'
        f'<asset id="r1" name="clip" src="{media.resolve().as_uri()}" />'
        '</resources></fcpxml>',
        encoding="utf-8",
    )
    portable_xml = local_xml.with_name("synchronized_portable.fcpxml")

    local_report = rewrite_fcpxml_media(local_xml, scan_root=source_root, source_root=source_root)
    portable_report = rewrite_fcpxml_media(
        local_xml,
        scan_root=source_root,
        source_root=source_root,
        output=portable_xml,
        portable=True,
    )

    portable_src = unquote(_asset_src(portable_xml))
    assert portable_src == f"./{source_root.name}/第一天/B1/镜头 001.mov"
    raw = portable_xml.read_text(encoding="utf-8")
    assert str(tmp_path) not in raw
    assert "/Users/" not in raw
    assert "/Volumes/" not in raw
    assert "%20" in raw

    manifest_path = local_xml.parent / "media_relink_manifest.json"
    manifest = write_relink_manifest(
        manifest_path,
        source_root=source_root,
        local_fcpxml=local_report,
        portable_fcpxml=portable_report,
    )
    manifest_text = manifest_path.read_text(encoding="utf-8")
    assert str(tmp_path) not in manifest_text
    assert manifest["files"][0]["relative_path"] == "第一天/B1/镜头 001.mov"
    assert manifest["exports"]["fcpxml"] == "synchronized.fcpxml"
    assert manifest["exports"]["fcpxml_portable"] == "synchronized_portable.fcpxml"


def test_portable_fcpxml_can_be_materialized_for_one_new_media_root(tmp_path: Path) -> None:
    old_root = tmp_path / "old" / "Footage"
    old_media = old_root / "day1" / "A1" / "C0001.mov"
    old_media.parent.mkdir(parents=True)
    old_media.write_bytes(b"same")
    local_xml = tmp_path / "delivery" / "synchronized.fcpxml"
    local_xml.parent.mkdir(parents=True)
    local_xml.write_text(
        '<fcpxml version="1.8"><resources>'
        f'<asset id="r1" name="C0001" src="{old_media.resolve().as_uri()}" />'
        '</resources></fcpxml>',
        encoding="utf-8",
    )
    portable_xml = local_xml.with_name("synchronized_portable.fcpxml")
    local_report = rewrite_fcpxml_media(local_xml, scan_root=old_root, source_root=old_root)
    portable_report = rewrite_fcpxml_media(
        local_xml,
        scan_root=old_root,
        source_root=old_root,
        output=portable_xml,
        portable=True,
    )
    manifest = local_xml.parent / "media_relink_manifest.json"
    write_relink_manifest(
        manifest,
        source_root=old_root,
        local_fcpxml=local_report,
        portable_fcpxml=portable_report,
    )

    new_root = tmp_path / "another computer" / "different volume" / "Footage"
    new_media = new_root / "day1" / "A1" / "C0001.mov"
    new_media.parent.mkdir(parents=True)
    shutil.copyfile(old_media, new_media)
    rebound = tmp_path / "new-machine.fcpxml"

    result = materialize_portable_fcpxml(portable_xml, manifest, new_root, rebound)

    assert result["complete"] is True
    assert result["rewritten"] == 1
    assert _asset_src(rebound) == new_media.resolve().as_uri()
    assert str(old_root) not in rebound.read_text(encoding="utf-8")


def test_premiere_pathurl_is_canonicalized_away_from_staging(tmp_path: Path) -> None:
    source_root = tmp_path / "Footage"
    camera = source_root / "C1"
    camera.mkdir(parents=True)
    media = camera / "clip.mov"
    media.write_bytes(b"media")
    stage = tmp_path / ".multicam-sync" / "media-layout" / "day1"
    stage.mkdir(parents=True)
    (stage / "C1").symlink_to(camera, target_is_directory=True)
    staged = stage / "C1" / "clip.mov"
    xml = tmp_path / "synchronized_premiere.xml"
    xml.write_text(
        '<xmeml version="4"><project><children><sequence><media><video><track>'
        '<clipitem><file><pathurl>'
        + "file://localhost" + staged.as_uri()[len("file://"):]
        + '</pathurl></file></clipitem>'
        '</track></video></media></sequence></children></project></xmeml>',
        encoding="utf-8",
    )

    report = rewrite_premiere_media(xml, scan_root=stage.parent, source_root=source_root)

    assert report["rewritten"] == 1
    text = xml.read_text(encoding="utf-8")
    assert ".multicam-sync" not in text
    assert "file://localhost" in text
    assert "Footage/C1/clip.mov" in unquote(text)


def test_sync_engine_uses_distinct_builder_outputs() -> None:
    root = Path(__file__).resolve().parents[1]
    source = (root / "src" / "script_organizer" / "multicam_sync_engine.py").read_text(encoding="utf-8")
    assert '"synchronized.fcpxml"' in source
    assert '"synchronized_final.fcpxml"' in source
    assert '"synchronized_premiere.xml"' in source
    assert '"synchronized_capcut.fcpxml"' in source
    assert '"synchronized_portable.fcpxml"' in source
    assert '"media_relink_manifest.json"' in source
