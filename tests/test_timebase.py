from __future__ import annotations

from pathlib import Path

from script_organizer.timebase import fcpxml_project_timebase


def _write_fcpxml(path: Path, frame_duration: str) -> None:
    path.write_text(
        f'''<?xml version="1.0" encoding="utf-8"?>
<fcpxml version="1.9">
  <resources><format id="r1" frameDuration="{frame_duration}" width="1920" height="1080"/></resources>
  <library><event name="E"><project name="P"><sequence format="r1" duration="10s"><spine/></sequence></project></event></library>
</fcpxml>''',
        encoding="utf-8",
    )


def test_fcpxml_timebase_keeps_ntsc_rational_rate(tmp_path: Path) -> None:
    path = tmp_path / "23976.fcpxml"
    _write_fcpxml(path, "1001/24000s")

    result = fcpxml_project_timebase(path)

    assert result["status"] == "confirmed"
    assert result["numerator"] == 24000
    assert result["denominator"] == 1001
    assert result["frame_duration"] == "1001/24000s"


def test_fcpxml_timebase_reads_integer_rate(tmp_path: Path) -> None:
    path = tmp_path / "50.fcpxml"
    _write_fcpxml(path, "1/50s")

    result = fcpxml_project_timebase(path)

    assert result["numerator"] == 50
    assert result["denominator"] == 1


def test_fcpxml_timebase_fails_closed_without_sequence_format(tmp_path: Path) -> None:
    path = tmp_path / "unknown.fcpxml"
    path.write_text(
        '<fcpxml version="1.9"><library><event><project><sequence><spine/></sequence></project></event></library></fcpxml>',
        encoding="utf-8",
    )

    result = fcpxml_project_timebase(path)

    assert result["status"] == "unknown"
    assert result["reason"] == "sequence_format_missing"
