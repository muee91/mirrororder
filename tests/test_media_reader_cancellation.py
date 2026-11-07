from __future__ import annotations

from pathlib import Path

import pytest

from script_organizer.media_reader import read_media_directory
from script_organizer.resource_scheduler import ResourceCancelled


def test_media_directory_scan_honors_cancellation_before_probe(tmp_path: Path) -> None:
    media = tmp_path / "media"
    media.mkdir()
    (media / "A001.mov").write_bytes(b"fixture")

    with pytest.raises(ResourceCancelled, match="媒体目录扫描已取消"):
        read_media_directory(media, cancelled=lambda: True)
