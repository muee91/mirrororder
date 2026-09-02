from __future__ import annotations

from pathlib import Path

import pytest

from script_organizer.media_playback_runtime import _parse_http_byte_range


@pytest.mark.parametrize(
    ("header", "size", "expected"),
    [
        ("", 100, None),
        ("items=0-9", 100, None),
        ("bytes=0-9", 100, (0, 9)),
        ("bytes=10-", 100, (10, 99)),
        ("bytes=-10", 100, (90, 99)),
        ("bytes=-1000", 100, (0, 99)),
        ("bytes=99-200", 100, (99, 99)),
        ("bytes=0-9,20-29", 100, None),
    ],
)
def test_http_byte_ranges_match_media_seek_semantics(
    header: str,
    size: int,
    expected: tuple[int, int] | None,
) -> None:
    assert _parse_http_byte_range(header, size) == expected


@pytest.mark.parametrize(
    ("header", "size"),
    [
        ("bytes=100-", 100),
        ("bytes=20-10", 100),
        ("bytes=-0", 100),
        ("bytes=abc-", 100),
        ("bytes=-abc", 100),
        ("bytes=-10", 0),
        ("bytes=-", 100),
    ],
)
def test_http_byte_ranges_reject_unsatisfiable_or_malformed_requests(header: str, size: int) -> None:
    with pytest.raises(ValueError, match="range invalid"):
        _parse_http_byte_range(header, size)


def test_media_playback_runtime_emits_webkit_range_contract() -> None:
    root = Path(__file__).resolve().parents[1]
    source = (root / "src" / "script_organizer" / "media_playback_runtime.py").read_text(encoding="utf-8")

    assert 'self.send_header("Accept-Ranges", "bytes")' in source
    assert 'self.send_header("Content-Range", f"bytes {start}-{end}/{size}")' in source
    assert 'self.send_header("Content-Range", f"bytes */{size}")' in source
    assert "HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE" in source
    assert "start + 4 * 1024 * 1024" not in source
    assert "head_only or length <= 0" in source
