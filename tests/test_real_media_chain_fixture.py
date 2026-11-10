from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from scripts.validate_real_media_chain import validate


@pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="real-media chain fixture requires ffmpeg and ffprobe",
)
def test_real_media_chain_fixture_exercises_recovery_to_dual_nle_delivery(tmp_path: Path) -> None:
    report = validate(tmp_path / "real-media-chain")

    assert report["media"] == {"generated": 7, "recovered": 7, "missing": 0}
    assert report["metadata"] == {"schema": "mirrororder.media_metadata.v1", "files": 7}
    assert report["evidence"] == {"sidecars": 7, "schema": "mirrororder.evidence.v1"}
    assert report["delivery"]["selection_manifest_version"] == 4
    assert report["delivery"]["classic_fcpxml_keywords"] is True
    assert report["delivery"]["timeline_fcpxml"] == "timeline_organized.fcpxml"
    assert report["delivery"]["premiere_xmeml"] == "timeline_premiere.xml"
