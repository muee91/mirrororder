from __future__ import annotations

import json
import os
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

import pytest

from script_organizer.timebase import fcpxml_project_timebase


ROOT = Path(__file__).resolve().parents[1]
CRATE = ROOT / "desktop" / "src-tauri" / "crates" / "timeline-core"


@lru_cache(maxsize=1)
def _rust_cli() -> Path:
    configured = os.environ.get("MIRRORORDER_TIMEBASE_BIN")
    if configured:
        binary = Path(configured)
        if not binary.is_file():
            pytest.skip(f"MIRRORORDER_TIMEBASE_BIN does not exist: {binary}")
        return binary

    cargo = os.environ.get("CARGO") or shutil.which("cargo")
    if not cargo:
        pytest.skip("cargo is unavailable; Rust parity tests require the timebase CLI")
    subprocess.run(
        [cargo, "build", "--locked", "--bin", "mirrororder-timebase", "--manifest-path", str(CRATE / "Cargo.toml")],
        cwd=ROOT,
        check=True,
    )
    binary = CRATE / "target" / "debug" / ("mirrororder-timebase.exe" if os.name == "nt" else "mirrororder-timebase")
    if not binary.is_file():
        pytest.fail(f"Rust build completed without producing {binary}")
    return binary


def _rust_result(path: Path) -> dict:
    completed = subprocess.run(
        [_rust_cli()],
        input=json.dumps(
            {
                "contract": "timebase.v1",
                "operation": "fcpxml_project_timebase",
                "path": str(path),
            }
        ),
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["contract"] == "timebase.v1"
    return payload["result"]


def _write(path: Path, body: str) -> Path:
    path.write_text(body, encoding="utf-8")
    return path


def test_rust_timebase_matches_python_for_ntsc_and_integer_rates(tmp_path: Path) -> None:
    cases = (
        (
            "1001/24000s",
            {
                "status": "confirmed",
                "source": "fcpxml_sequence",
                "format_id": "r1",
                "frame_duration": "1001/24000s",
                "numerator": 24000,
                "denominator": 1001,
            },
        ),
        (
            "1/50s",
            {
                "status": "confirmed",
                "source": "fcpxml_sequence",
                "format_id": "r1",
                "frame_duration": "1/50s",
                "numerator": 50,
                "denominator": 1,
            },
        ),
    )
    for index, (frame_duration, expected) in enumerate(cases):
        path = _write(
            tmp_path / f"case-{index}.fcpxml",
            f'<fcpxml><resources><format id="r1" frameDuration="{frame_duration}"/></resources>'
            '<library><event><project><sequence format="r1"/></project></event></library></fcpxml>',
        )
        python_result = fcpxml_project_timebase(path)
        rust_result = _rust_result(path)
        assert python_result == expected
        assert rust_result == expected


def test_rust_timebase_matches_python_for_namespace_decimal_and_duplicates(tmp_path: Path) -> None:
    path = _write(
        tmp_path / "namespaced.fcpxml",
        '<fcpxml xmlns="urn:fcpxml"><resources>'
        '<format id="r1" frameDuration="1/25s"/>'
        '<format id="r1" frameDuration="0.04s"/>'
        '<format id="r1" frameDuration="invalid"/>'
        '</resources><library><event><project><sequence format="r1"/></project></event></library></fcpxml>',
    )
    expected = {
        "status": "confirmed",
        "source": "fcpxml_sequence",
        "format_id": "r1",
        "frame_duration": "1/25s",
        "numerator": 25,
        "denominator": 1,
    }
    assert fcpxml_project_timebase(path) == expected
    assert _rust_result(path) == expected


@pytest.mark.parametrize(
    "filename, content, expected",
    [
        (
            "missing-sequence-format.fcpxml",
            '<fcpxml><library><event><project><sequence format="unknown"/></project></event></library></fcpxml>',
            {
                "status": "unknown",
                "source": "fcpxml_sequence",
                "reason": "sequence_format_missing",
                "format_id": "unknown",
            },
        ),
        (
            "missing-sequence.fcpxml",
            "<fcpxml><library><event><project/></event></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "project_sequence_missing"},
        ),
        (
            "malformed.fcpxml",
            "<fcpxml><library>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
        (
            "leading-junk.fcpxml",
            "junk<fcpxml><library><event><project><sequence format=\"r1\"/></project></event></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
        (
            "trailing-junk.fcpxml",
            "<fcpxml><library><event><project><sequence format=\"r1\"/></project></event></library></fcpxml>junk",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
        (
            "unbound-prefix.fcpxml",
            "<x:fcpxml><library><event><project><sequence format=\"r1\"/></project></event></library></x:fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
        (
            "unbound-attribute-prefix.fcpxml",
            "<fcpxml x:bad=\"value\"><library><event><project><sequence format=\"r1\"/></project></event></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
        (
            "invalid-control.fcpxml",
            "<fcpxml><library><event><project><sequence format=\"r1\" note=\"bad\x01value\"/></project></event></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
        (
            "encoding-mismatch.fcpxml",
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?><fcpxml><library><event><project><sequence format=\"r1\"/></project></event></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
        (
            "declaration-after-whitespace.fcpxml",
            " <?xml version=\"1.0\"?><fcpxml><library><event><project><sequence format=\"r1\"/></project></event></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
        (
            "sequence-outside-project.fcpxml",
            "<fcpxml><library><event><project/></event><sequence format=\"r1\"/></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "project_sequence_missing"},
        ),
        (
            "sequence-in-foreign-element.fcpxml",
            "<fcpxml><library><event><project/><other><sequence format=\"r1\"/></other></event></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "project_sequence_missing"},
        ),
        (
            "invalid-comment.fcpxml",
            "<!-- invalid--comment --><fcpxml><library><event><project><sequence format=\"r1\"/></project></event></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
        (
            "malformed-nesting.fcpxml",
            "<fcpxml><library><event><project><sequence format=\"r1\"></project></event></library></fcpxml>",
            {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"},
        ),
    ],
)
def test_rust_timebase_matches_python_fail_closed(tmp_path: Path, filename: str, content: str, expected: dict) -> None:
    path = _write(tmp_path / filename, content)
    assert fcpxml_project_timebase(path) == expected
    assert _rust_result(path) == expected


def test_rust_timebase_matches_python_for_missing_source(tmp_path: Path) -> None:
    path = tmp_path / "does-not-exist.fcpxml"
    expected = {"status": "unknown", "source": "fcpxml_sequence", "reason": "source_missing"}
    assert fcpxml_project_timebase(path) == expected
    assert _rust_result(path) == expected
