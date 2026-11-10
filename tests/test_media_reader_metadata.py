from __future__ import annotations

import json
from pathlib import Path

from script_organizer import media_reader
from script_organizer.media_reader import MediaProbe, read_media_directory


class _ProbeProcess:
    def __init__(self, payload: str, returncode: int = 0) -> None:
        self.payload = payload
        self.returncode = returncode

    def communicate(self, timeout: float | None = None):
        return self.payload, ""

    def kill(self) -> None:
        self.returncode = -9


def test_probe_parses_frame_rate_timecode_and_rotation(monkeypatch, tmp_path: Path) -> None:
    payload = {
        "format": {
            "duration": "12.5",
            "tags": {"timecode": "01:02:03:04"},
        },
        "streams": [
            {
                "avg_frame_rate": "30000/1001",
                "r_frame_rate": "30000/1001",
                "tags": {"rotate": "90"},
                "side_data_list": [],
            }
        ],
    }
    monkeypatch.setattr(
        media_reader.subprocess,
        "Popen",
        lambda *args, **kwargs: _ProbeProcess(json.dumps(payload)),
    )

    result = media_reader._probe(tmp_path / "A001.mov")

    assert result.status == "ok"
    assert result.duration == 12.5
    assert result.fps == 30000 / 1001
    assert result.timecode == "01:02:03:04"
    assert result.rotation == 90


def test_probe_failure_is_explicit_and_does_not_fabricate_duration(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(
        media_reader.subprocess,
        "Popen",
        lambda *args, **kwargs: _ProbeProcess("", returncode=1),
    )

    result = media_reader._probe(tmp_path / "broken.mov")

    assert result.status == "probe_failed"
    assert result.duration == 0
    assert result.error


def test_media_directory_marks_unreadable_file_unavailable(monkeypatch, tmp_path: Path) -> None:
    media = tmp_path / "media"
    media.mkdir()
    broken = media / "A001.mov"
    broken.write_bytes(b"truncated")
    monkeypatch.setattr(
        media_reader,
        "_probe",
        lambda path, cancelled=None: MediaProbe(0, None, status="probe_failed", error="bad media"),
    )

    clip = read_media_directory(media)[0]

    assert clip.exists is False
    assert clip.duration == 0
    assert clip.probe_status == "probe_failed"
    assert clip.probe_error == "bad media"
    assert clip.to_dict()["probe_status"] == "probe_failed"
