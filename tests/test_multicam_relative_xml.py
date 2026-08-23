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

    fake_project_config = types.ModuleType("project_config")
    fake_project_config.get_config = lambda: FakeConfig()
    monkeypatch.setitem(sys.modules, "project_config", fake_project_config)
    monkeypatch.setitem(sys.modules, "pandas", types.ModuleType("pandas"))

    spec = importlib.util.spec_from_file_location("mirrororder_test_multicam_builder", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_builder_resolves_staging_symlink_to_standard_relative_url(tmp_path: Path, monkeypatch) -> None:
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
    assert not value.startswith("file:")


def test_both_fcpxml_builders_use_relative_urls_and_no_absolute_url_helper() -> None:
    root = Path(__file__).resolve().parents[1]
    for name in ("build_fcpxml.py", "build_capcut_fcpxml.py"):
        source = (root / "vendor" / "multicam-audio-sync" / "scripts" / name).read_text(encoding="utf-8")
        assert "url_export(" in source
        assert "os.path.relpath(physical, OUTPUT_BASE)" in source
        assert "cfg.url_abs(BASE, path)" not in source
        assert "file://" not in source


def test_mirrororder_delivers_xml_inside_media_root_and_has_no_custom_portable_format() -> None:
    root = Path(__file__).resolve().parents[1]
    source = (root / "src" / "script_organizer" / "multicam_sync_engine.py").read_text(encoding="utf-8")
    assert 'xml_delivery = config.media_root / "交付"' in source
    assert '"media_reference_mode": "relative-to-xml"' in source
    assert "portable_fcpxml" not in source
    assert "media_relink_manifest" not in source
    assert "media_relink" not in source
