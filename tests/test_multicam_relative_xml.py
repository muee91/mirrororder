from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from urllib.parse import unquote


def _load_builder(monkeypatch, path: Path, *, base: Path, output: Path, export_base: Path):
    class FakeConfig:
        WORK = "/tmp/work"
        BASE = str(base)
        OUT_DIR = str(output)
        manual = {"export_base": str(export_base), "project_name": "test", "out_name": "synchronized.fcpxml"}
        frame_den = 50000
        frame_ticks = 2000
        fps = 25.0
        width = 1920
        height = 1080
        cam_list = ["A"]
        day_dirs = [("day1", "day1")]
        audio_rate = 48000
        audio_ch = 2
        format_name = "FFVideoFormat1920x1080p25"

        @staticmethod
        def sec_to_ticks(value):
            return int(round(float(value) * 50000))

        @staticmethod
        def url_abs(base, path):
            from urllib.parse import quote
            return "file://" + quote(str(Path(base) / path))

    fake_project_config = types.ModuleType("project_config")
    fake_project_config.get_config = lambda: FakeConfig()
    monkeypatch.setitem(sys.modules, "project_config", fake_project_config)
    monkeypatch.setitem(sys.modules, "pandas", types.ModuleType("pandas"))

    spec = importlib.util.spec_from_file_location("mirrororder_test_multicam_builder", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _staging_fixture(tmp_path: Path):
    source = tmp_path / "素材根"
    camera = source / "A1"
    camera.mkdir(parents=True)
    media = camera / "片段 01.mov"
    media.write_bytes(b"media")
    delivery = source / "交付"
    delivery.mkdir()
    stage = tmp_path / "project" / "output" / ".multicam-sync" / "media-layout"
    fake_day = stage / "day1"
    fake_day.mkdir(parents=True)
    (fake_day / "A1").symlink_to(camera, target_is_directory=True)
    return source, delivery, stage, media


def test_fcp_builder_resolves_staging_symlink_to_relative_url(tmp_path: Path, monkeypatch) -> None:
    source, delivery, stage, _media = _staging_fixture(tmp_path)
    root = Path(__file__).resolve().parents[1]
    builder = _load_builder(
        monkeypatch,
        root / "vendor" / "multicam-audio-sync" / "scripts" / "build_fcpxml.py",
        base=stage,
        output=delivery,
        export_base=source,
    )
    value = unquote(builder.url_export("day1/A1/片段 01.mov"))
    assert value == "../A1/片段 01.mov"
    assert ".multicam-sync" not in value
    assert str(tmp_path) not in value


def test_capcut_builder_keeps_absolute_file_url_but_resolves_staging(tmp_path: Path, monkeypatch) -> None:
    source, delivery, stage, media = _staging_fixture(tmp_path)
    root = Path(__file__).resolve().parents[1]
    builder = _load_builder(
        monkeypatch,
        root / "vendor" / "multicam-audio-sync" / "scripts" / "build_capcut_fcpxml.py",
        base=stage,
        output=delivery,
        export_base=source,
    )
    value = unquote(builder.url_abs("day1/A1/片段 01.mov"))
    assert value.startswith("file://")
    assert str(media) in value
    assert ".multicam-sync" not in value


def test_builders_have_distinct_media_url_policies() -> None:
    root = Path(__file__).resolve().parents[1]
    fcp = (root / "vendor" / "multicam-audio-sync" / "scripts" / "build_fcpxml.py").read_text(encoding="utf-8")
    capcut = (root / "vendor" / "multicam-audio-sync" / "scripts" / "build_capcut_fcpxml.py").read_text(encoding="utf-8")
    assert "url_export(" in fcp
    assert "os.path.relpath(physical, OUTPUT_BASE)" in fcp
    assert "url_abs(" in capcut
    assert "cfg.url_abs" in capcut
    assert "os.path.relpath(physical, OUTPUT_BASE)" not in capcut


def test_mirrororder_has_no_custom_portable_format() -> None:
    root = Path(__file__).resolve().parents[1]
    source = (root / "src" / "script_organizer" / "multicam_sync_engine.py").read_text(encoding="utf-8")
    assert 'xml_delivery = config.media_root / "交付"' in source
    assert "portable_fcpxml" not in source
    assert "media_relink_manifest" not in source
    assert "media_relink" not in source
