from __future__ import annotations

import json
import re
import subprocess
from fractions import Fraction
from pathlib import Path

from .fcpxml_reader import stable_clip_id
from .media_identity import media_identity
from .models import Clip


VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".mxf", ".mts", ".avi", ".mkv"}


def _probe(path: Path) -> tuple[float, float | None]:
    """Read duration and capture time without importing a media framework."""
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration:format_tags=creation_time",
        "-of",
        "json",
        str(path),
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=12, check=True)
        payload = json.loads(result.stdout)
        format_row = payload.get("format", {}) if isinstance(payload, dict) else {}
        duration = max(0.01, float(format_row.get("duration", 0) or 0))
        creation_time = None
        raw_time = format_row.get("tags", {}).get("creation_time") if isinstance(format_row.get("tags", {}), dict) else None
        if raw_time:
            from datetime import datetime

            creation_time = datetime.fromisoformat(str(raw_time).replace("Z", "+00:00")).timestamp()
        return duration, creation_time
    except (OSError, ValueError, subprocess.SubprocessError):
        return 1.0, None


def _camera(path: Path, patterns: dict[str, str]) -> str:
    candidate = path.name.upper()
    for camera, pattern in sorted(patterns.items()):
        try:
            if re.search(pattern, candidate, re.IGNORECASE):
                return camera
        except re.error:
            continue
    match = re.search(r"(?:^|[_\-\s])([A-Z])\d", candidate)
    return match.group(1) if match else "?"


def read_media_directory(
    root: str | Path,
    camera_patterns: dict[str, str] | None = None,
    timeline_mode: str = "sequential",
) -> list[Clip]:
    """Build clips from ordinary video media without pretending unsynced files overlap."""
    directory = Path(root)
    patterns = camera_patterns or {}
    files = sorted(
        path
        for path in directory.rglob("*")
        if path.is_file() and path.suffix.lower() in VIDEO_SUFFIXES and not path.name.startswith("._")
    )
    rows = []
    for occurrence, path in enumerate(files):
        duration, captured_at = _probe(path)
        stat_time = path.stat().st_mtime
        rows.append((path, duration, captured_at if captured_at is not None else stat_time, occurrence))
    if timeline_mode == "sequential":
        rows.sort(key=lambda row: str(row[0]).casefold())
    else:
        rows.sort(key=lambda row: (row[2], str(row[0]).casefold()))
    if not rows:
        return []
    first_time = rows[0][2]
    cursor = Fraction(0)
    clips: list[Clip] = []
    for path, duration, captured_at, occurrence in rows:
        duration_fraction = Fraction(str(round(duration, 3)))
        if timeline_mode == "sequential":
            start = cursor
            cursor += duration_fraction
        else:
            start = Fraction(str(round(max(0.0, captured_at - first_time), 3)))
        clips.append(
            Clip(
                clip_id=stable_clip_id(str(path), "media-directory", occurrence),
                name=path.stem,
                camera=_camera(path, patterns),
                media_path=str(path),
                timeline_start=start,
                timeline_end=start + duration_fraction,
                duration=duration_fraction,
                exists=True,
                source_asset_id="media-directory",
                source_start=Fraction(0),
                source_end=duration_fraction,
                media_id=media_identity(path),
            )
        )
    return clips
