from __future__ import annotations

import csv
import importlib.util
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from types import SimpleNamespace

import pytest

from script_organizer.fcpxml_reader import read_fcpxml
from script_organizer.media_reader import infer_camera_label


SCRIPTS = Path(__file__).resolve().parents[1] / "vendor" / "multicam-audio-sync" / "scripts"


def _load(name: str, monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, name, module)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("camera", list("ABCDEFGHIJKLMNOPQRSTUVWXYZ"))
def test_host_and_sync_detect_all_explicit_camera_letters(camera: str, monkeypatch) -> None:
    vendor = _load("project_config", monkeypatch)
    for token in (camera, f"{camera}机", f"CAM_{camera}", f"CAMERA-{camera}", f"{camera}001C002_240101XY"):
        assert infer_camera_label(Path("shoot") / f"{token}.MP4") == camera
        assert vendor.infer_camera_label(f"{token}.MP4") == camera


@pytest.mark.parametrize("name", ["AERIAL", "CAMERA_TEST", "DETAIL", "EXTRA", "FOOTAGE", "DJI_20240101080000_0001_D"])
def test_ordinary_names_and_device_suffixes_are_not_camera_facts(name: str, monkeypatch) -> None:
    vendor = _load("project_config", monkeypatch)
    assert infer_camera_label(Path("shoot") / f"{name}.MP4") == "?"
    assert vendor.infer_camera_label(f"{name}.MP4") == ""


def test_six_camera_directories_and_flat_media_are_detected_without_defaulting_to_a(tmp_path: Path, monkeypatch) -> None:
    vendor = _load("project_config", monkeypatch)
    day = tmp_path / "day1"
    for camera in "ABCDEF":
        folder = day / camera
        folder.mkdir(parents=True)
        (folder / f"{camera}001C001.MP4").write_bytes(b"synthetic")
    assert vendor._detect_cam_dirs(str(day)) == {camera: [camera] for camera in "ABCDEF"}
    flat = tmp_path / "flat"
    flat.mkdir()
    for camera in "ABCDEF":
        (flat / f"{camera}001C001.MP4").write_bytes(b"synthetic")
    assert vendor._detect_cam_dirs(str(flat)) == {camera: ["."] for camera in "ABCDEF"}
    unknown = tmp_path / "unclassified"
    unknown.mkdir()
    (unknown / "DJI_20240101080000_0001_D.MP4").write_bytes(b"synthetic")
    assert vendor._detect_cam_dirs(str(unknown)) == {"?": ["."]}


def test_sync_index_keeps_six_cameras_and_excludes_photos_and_audio(tmp_path: Path, monkeypatch) -> None:
    vendor = _load("project_config", monkeypatch)
    indexer = _load("make_index", monkeypatch)
    source, work = tmp_path / "source", tmp_path / "work"
    folders = {}
    for camera in "ABCDEF":
        folder = source / "day1" / camera
        folder.mkdir(parents=True)
        (folder / f"{camera}001C001.MP4").write_bytes(f"video-{camera}".encode())
        (folder / f"{camera}001.JPG").write_bytes(b"photo")
        (folder / f"{camera}001.DNG").write_bytes(b"raw photo")
        (folder / f"{camera}001.WAV").write_bytes(b"audio")
        folders[camera] = [camera]
    cfg = SimpleNamespace(BASE=str(source), WORK=str(work), day_dirs=[("day1", "day1")], day_cam_dirs={"day1": folders}, camera_patterns={}, media_roles={})
    monkeypatch.setattr(indexer, "get_config", lambda: cfg)
    monkeypatch.setattr(indexer, "probe_file", lambda _path: {"dur": 2.0, "size": 10, "tc": "00:00:00:00", "creation": ""})

    count, failures = indexer.build()

    with (work / "index.tsv").open() as handle:
        rows = list(csv.reader(handle, delimiter="\t"))
    assert count == 6
    assert failures == 0
    assert {row[2] for row in rows} == set("ABCDEF")
    assert all(Path(row[4]).suffix == ".MP4" for row in rows)
    assert vendor.infer_camera_label("D001C001.MP4") == "D"


def test_fcpxml_readback_preserves_six_angles_and_custom_camera_names(tmp_path: Path) -> None:
    labels = [*"ABCDEF", "RED"]
    assets, angles = [], []
    for index, camera in enumerate(labels):
        media = tmp_path / f"{camera}001.mov"
        media.write_bytes(f"media-{camera}".encode())
        assets.append(f'<asset id="r{index}" src="{media.as_uri()}"/>')
        angles.append(f'<mc-angle name="{camera}" angleID="angle_{camera}"><asset-clip ref="r{index}" duration="2s"/></mc-angle>')
    path = tmp_path / "six-cameras.fcpxml"
    path.write_text('<fcpxml version="1.8"><resources>' + ''.join(assets) + '<media id="multi"><multicam>' + ''.join(angles) + '</multicam></media></resources><library><event><project><sequence><spine><mc-clip ref="multi" duration="2s"/></spine></sequence></project></event></library></fcpxml>', encoding="utf-8")

    clips = read_fcpxml(path)

    assert len(clips) == len(labels)
    assert {clip.camera for clip in clips} == set(labels)


def test_export_and_raw_draft_validation_preserve_all_six_cameras(tmp_path: Path, monkeypatch) -> None:
    vendor = _load("project_config", monkeypatch)
    source, work, delivery = tmp_path / "source", tmp_path / "work", tmp_path / "delivery"
    work.mkdir()
    for camera in "ABCDEF":
        folder = source / "day1" / camera
        folder.mkdir(parents=True)
        (folder / f"{camera}001.MP4").write_bytes(f"video-{camera}".encode())
    monkeypatch.setattr(vendor, "detect_video_format", lambda _path: (25.0, 1920, 1080))
    monkeypatch.setattr(vendor, "detect_audio_rate", lambda _path: 48000)
    monkeypatch.setattr(vendor, "detect_fps_frac", lambda _path: None)
    cfg = vendor.Config(str(source), str(work), str(delivery), {"project_name": "six-camera", "fps": 25, "out_name": "synchronized.fcpxml", "export_base": str(source)})
    monkeypatch.setattr(vendor, "get_config", lambda: cfg)
    with (work / "positions_day1_compressed.tsv").open("w", newline="") as handle:
        writer = csv.writer(handle, delimiter="\t")
        writer.writerow(["id", "day", "cam", "dir", "file", "dur", "pos", "tc", "clipn"])
        for camera in "ABCDEF":
            writer.writerow([f"clip-{camera}", "day1", camera, f"day1/{camera}", f"{camera}001.MP4", 2, 0, "00:00:00:00", 1])
    _load("build_fcpxml", monkeypatch).main()
    clips = read_fcpxml(delivery / "synchronized.fcpxml")
    assert {clip.camera for clip in clips} == set("ABCDEF")
    assert len(clips) == 6
    cfg.manual["out_name"] = "premiere.xml"
    _load("build_pr_xml", monkeypatch).main()
    root = ET.parse(delivery / "premiere.xml").getroot()
    assert len(root.findall(".//sequence/media/video/track")) == 6
    builder = _load("build_capcut_draft_31", monkeypatch)
    monkeypatch.setattr(builder, "find_draft_root", lambda: None)
    draft = Path(builder.build())
    main = json.loads((draft / "draft_info.json").read_text())
    assert len(main["tracks"]) == 7
    assert len(main["materials"]["drafts"][0]["draft"]["tracks"]) == 6
    validator = _load("validate_capcut_draft", monkeypatch)
    monkeypatch.setattr(sys, "argv", ["validate_capcut_draft.py", str(draft), "--mode=raw"])
    with pytest.raises(SystemExit) as result:
        validator.main()
    assert result.value.code == 0, validator.ERRORS

    # Losing one nested angle must still fail; supporting six is not a relaxed
    # "any number of tracks passes" check.
    sub_path = draft / "subdraft" / "draft_content.json"
    top = json.loads(sub_path.read_text())
    top["materials"]["drafts"][0]["draft"]["tracks"].pop()
    sub_path.write_text(json.dumps(top), encoding="utf-8")
    validator.NOTES.clear()
    validator.ERRORS.clear()
    with pytest.raises(SystemExit) as result:
        validator.main()
    assert result.value.code == 1
    assert any("角度轨数量与主稿机位一致" in message for message in validator.ERRORS)


def test_unknown_camera_directory_stays_unclassified_and_manual_labels_win(tmp_path: Path, monkeypatch) -> None:
    vendor = _load("project_config", monkeypatch)
    assert infer_camera_label(Path("shoot/D/A001.MP4")) == "D"
    assert infer_camera_label(Path("shoot/D/A001.MP4"), {"F": "A001"}) == "F"
    assert vendor.infer_camera_label("A001.MP4", {"F": "A001"}) == "F"
    indexer = _load("make_index", monkeypatch)
    source, work = tmp_path / "source", tmp_path / "work"
    day = source / "broll"
    day.mkdir(parents=True)
    (day / "DJI_20240101080000_0001_D.MP4").write_bytes(b"video")
    cfg = SimpleNamespace(BASE=str(source), WORK=str(work), day_dirs=[("broll", "broll")], day_cam_dirs={"broll": vendor._detect_cam_dirs(str(day))}, camera_patterns={}, media_roles={})
    monkeypatch.setattr(indexer, "get_config", lambda: cfg)
    monkeypatch.setattr(indexer, "probe_file", lambda _path: {"dur": 2.0, "size": 10, "tc": "", "creation": ""})
    assert indexer.build() == (1, 0)
    with (work / "index.tsv").open() as handle:
        rows = list(csv.reader(handle, delimiter="\t"))
    assert rows[0][2] == "?"


def test_sync_index_ids_follow_media_occurrences_instead_of_scan_order(tmp_path: Path, monkeypatch) -> None:
    _load("project_config", monkeypatch)
    indexer = _load("make_index", monkeypatch)
    source, work = tmp_path / "source", tmp_path / "work"
    folder = source / "day1" / "D"
    folder.mkdir(parents=True)
    media = folder / "D002.MP4"
    media.write_bytes(b"original media")
    cfg = SimpleNamespace(BASE=str(source), WORK=str(work), day_dirs=[("day1", "day1")], day_cam_dirs={"day1": {"D": ["D"]}}, camera_patterns={}, media_roles={})
    monkeypatch.setattr(indexer, "get_config", lambda: cfg)
    monkeypatch.setattr(indexer, "probe_file", lambda _path: {"dur": 2.0, "size": 10, "tc": "", "creation": ""})

    def ids():
        indexer.build()
        return {row[4]: row[0] for row in csv.reader((work / "index.tsv").read_text().splitlines(), delimiter="\t")}

    original = ids()[media.name]
    (folder / "D001.MP4").write_bytes(b"inserted earlier")
    assert ids()[media.name] == original
    media.write_bytes(b"replacement media")
    assert ids()[media.name] != original
    # The new namespace must never read the old order-based audio caches.
    assert original != "day1_D_00000"


def test_flat_mixed_cameras_keep_unknown_video_and_folder_camera_precedes_filename(tmp_path: Path, monkeypatch) -> None:
    vendor = _load("project_config", monkeypatch)
    indexer = _load("make_index", monkeypatch)
    source, work = tmp_path / "source", tmp_path / "work"
    flat = source / "flat"
    flat.mkdir(parents=True)
    for camera in "ABCDEF":
        (flat / f"{camera}001.MP4").write_bytes(camera.encode())
    (flat / "DJI_0001_D.MP4").write_bytes(b"unknown")
    folder = source / "day1" / "D"
    folder.mkdir(parents=True)
    (folder / "A999.MP4").write_bytes(b"folder takes priority")
    cfg = SimpleNamespace(BASE=str(source), WORK=str(work), day_dirs=[("flat", "flat"), ("day1", "day1")], day_cam_dirs={"flat": vendor._detect_cam_dirs(str(flat)), "day1": {"D": ["D"]}}, camera_patterns={}, media_roles={})
    monkeypatch.setattr(indexer, "get_config", lambda: cfg)
    monkeypatch.setattr(indexer, "probe_file", lambda _path: {"dur": 2.0, "size": 10, "tc": "", "creation": ""})
    assert indexer.build() == (8, 0)
    rows = list(csv.reader((work / "index.tsv").read_text().splitlines(), delimiter="\t"))
    assert next(row[2] for row in rows if row[4] == "DJI_0001_D.MP4") == "?"
    assert next(row[2] for row in rows if row[4] == "A999.MP4") == "D"
    cfg.camera_patterns = {"F": "A999"}
    indexer.build()
    rows = list(csv.reader((work / "index.tsv").read_text().splitlines(), delimiter="\t"))
    assert next(row[2] for row in rows if row[4] == "A999.MP4") == "F"


def test_failed_audio_extraction_cannot_be_reused_as_completed_cache(tmp_path: Path, monkeypatch) -> None:
    vendor = _load("project_config", monkeypatch)
    cfg = SimpleNamespace(BASE=str(tmp_path), WORK=str(tmp_path / "work"))
    monkeypatch.setattr(vendor, "get_config", lambda: cfg)
    extractor = _load("extract_parallel", monkeypatch)
    audio = Path(cfg.WORK) / "audio"
    audio.mkdir(parents=True)
    attempts = []

    def run(command, **_kwargs):
        attempts.append(command)
        Path(command[-1]).write_bytes(b"incomplete" if len(attempts) == 1 else b"complete audio")
        return SimpleNamespace(returncode=1 if len(attempts) == 1 else 0, stderr=b"interrupted")

    monkeypatch.setattr(extractor.subprocess, "run", run)
    row = "clip-id\tday1\tD\tday1/D\tD001.MP4"
    assert extractor.extract_one(row)[1].startswith("FAIL")
    assert not (audio / "clip-id.f32").exists()
    assert extractor.extract_one(row) == ("clip-id", "ok")
    assert (audio / "clip-id.f32").read_bytes() == b"complete audio"
    assert extractor.extract_one(row) == ("clip-id", "cached")
    assert len(attempts) == 2


def test_camera_inference_does_not_read_system_or_workspace_ancestors() -> None:
    media = Path("/unrelated/T/workspace/shoot/day/A001.MP4")
    assert infer_camera_label(media) == "A"
    unknown = media.with_name("DJI_0001_D.MP4")
    assert infer_camera_label(unknown) == "?"
    root = Path("/unrelated/T/workspace/shoot")
    nested = root / "D" / "CARD1" / "CLIPS" / "A001.MP4"
    assert infer_camera_label(nested, media_roots=[root]) == "D"
    assert infer_camera_label(unknown, media_roots=[root]) == "?"


def test_resync_cannot_transfer_clip_identity_to_different_verified_media(tmp_path: Path) -> None:
    from script_organizer.material_index import _reconcile_previous_clip_identity

    first, replacement = tmp_path / "A001.mov", tmp_path / "D001.mov"
    first.write_bytes(b"original camera media")
    replacement.write_bytes(b"different camera media")
    xml = tmp_path / "resync.fcpxml"

    def document(media: Path):
        xml.write_text(f'<fcpxml><resources><asset id="day_day1_asset_0" src="{media.as_uri()}"/></resources><library><event><project><sequence><spine><asset-clip ref="day_day1_asset_0" duration="2s"/></spine></sequence></project></event></library></fcpxml>')

    document(first)
    original = read_fcpxml(xml)[0]
    previous = {"clips": [{"source_asset_id": original.source_asset_id, "clip_id": original.clip_id, "media_id": original.media_id}]}
    document(replacement)
    fresh = read_fcpxml(xml)[0]
    assert fresh.media_id != original.media_id
    assert read_fcpxml(xml, previous_index=previous)[0].clip_id == fresh.clip_id
    assert _reconcile_previous_clip_identity([fresh], previous)[0].clip_id == fresh.clip_id


def test_unknown_video_never_becomes_default_export_camera(tmp_path: Path, monkeypatch) -> None:
    vendor = _load("project_config", monkeypatch)
    source, work, delivery = tmp_path / "source", tmp_path / "work", tmp_path / "delivery"
    flat = source / "day1"
    flat.mkdir(parents=True)
    work.mkdir()
    names = {camera: f"{camera}001.MP4" for camera in "ABCDEF"}
    names["?"] = "DJI_0001_D.MP4"
    for camera, name in names.items():
        (flat / name).write_bytes(f"media-{camera}".encode())
    monkeypatch.setattr(vendor, "detect_video_format", lambda _path: (25.0, 1920, 1080))
    monkeypatch.setattr(vendor, "detect_audio_rate", lambda _path: 48000)
    monkeypatch.setattr(vendor, "detect_fps_frac", lambda _path: None)
    cfg = vendor.Config(str(source), str(work), str(delivery), {"fps": 25, "out_name": "sync.fcpxml", "export_base": str(source)})
    monkeypatch.setattr(vendor, "get_config", lambda: cfg)
    with (work / "positions_day1_compressed.tsv").open("w", newline="") as handle:
        writer = csv.writer(handle, delimiter="\t")
        writer.writerow(["id", "day", "cam", "dir", "file", "dur", "pos", "tc", "clipn"])
        for camera, name in names.items():
            writer.writerow([f"clip-{camera}", "day1", camera, "day1", name, 2, 0, "00:00:00:00", 1])
    _load("build_fcpxml", monkeypatch).main()
    root = ET.parse(delivery / "sync.fcpxml").getroot()
    assert len(root.findall(".//mc-angle")) == 7
    assert cfg.cam_list == [*"ABCDEF", "?"]
    assert {node.get("angleID") for node in root.findall(".//mc-angle")} == {"angle_A", "angle_B", "angle_C", "angle_D", "angle_E", "angle_F", "angle_?"}
    assert root.find(".//sequence/spine/mc-clip/mc-source").get("angleID") == "angle_A"
    cfg.manual["out_name"] = "sync-premiere.xml"
    _load("build_pr_xml", monkeypatch).main()
    premiere = ET.parse(delivery / "sync-premiere.xml").getroot()
    title = premiere.find("project/name").text
    assert "6机位" in title and "未分类" in title
    assert "7机位" not in title
