from __future__ import annotations

import json
import re
import subprocess
import time
from fractions import Fraction
from pathlib import Path
from typing import Callable, Iterable

from .fcpxml_reader import stable_clip_id
from .media_identity import media_identity
from .models import Clip
from .resource_scheduler import ResourceCancelled


VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".mxf", ".mts", ".avi", ".mkv"}
_CONVENTIONAL_CAMERAS = ("A", "B", "C")


def _probe(path: Path, cancelled: Callable[[], bool] | None = None) -> tuple[float, float | None]:
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
    if cancelled and cancelled():
        raise ResourceCancelled("媒体探测已取消")
    process: subprocess.Popen[str] | None = None
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 12.0
        while True:
            if cancelled and cancelled():
                process.kill()
                process.communicate()
                raise ResourceCancelled("媒体探测已取消")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                process.kill()
                process.communicate()
                return 1.0, None
            try:
                stdout, _stderr = process.communicate(timeout=min(0.25, remaining))
                if process.returncode != 0:
                    return 1.0, None
                break
            except subprocess.TimeoutExpired:
                continue
        payload = json.loads(stdout or "")
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


def _camera_token(value: str) -> str:
    """Return A/B/C for strong conventional camera tokens only.

    We intentionally do not treat arbitrary occurrences of the letters A/B/C as
    camera metadata. Accepted industry-style tokens include A, A机, A1, A001,
    CAM_A, CAMERA-B and equivalent B/C forms.
    """
    text = str(value or "").strip()
    if not text:
        return ""
    upper = text.upper()
    for camera in _CONVENTIONAL_CAMERAS:
        patterns = (
            rf"^{camera}(?:机|CAM|CAMERA)?$",
            rf"^{camera}\d+$",
            rf"^(?:CAMERA|CAM)[_\-\s]*{camera}(?:\d+)?$",
            rf"(?:^|[_\-\s]){camera}(?=\d|[_\-\s]|机|$)",
        )
        if any(re.search(pattern, upper, re.IGNORECASE) for pattern in patterns):
            return camera
    return ""


def infer_camera_label(path: str | Path, patterns: dict[str, str] | None = None) -> str:
    """Infer a camera label with explicit config first, conventions second.

    Configured patterns are evaluated against the full path as well as filename,
    so a project can override unconventional folder/file naming. Without config,
    A/B/C file tokens and A/B/C/A机/B机/C机 camera folders are treated as the
    conventional default. The result remains editable elsewhere in Production.
    """
    candidate = Path(path)
    configured = patterns or {}
    full_text = candidate.as_posix()
    filename = candidate.name
    for camera, pattern in configured.items():
        try:
            if re.search(pattern, full_text, re.IGNORECASE) or re.search(pattern, filename, re.IGNORECASE):
                return str(camera).upper()
        except re.error:
            continue

    # Parent folder is usually stronger evidence than filename. Check nearest
    # folders first so /shoot/A机/A001.mov resolves A deterministically.
    for part in reversed(candidate.parent.parts):
        detected = _camera_token(part)
        if detected:
            return detected
    detected = _camera_token(candidate.stem)
    if detected:
        return detected
    match = re.search(r"(?:^|[_\-\s])([ABC])(?=\d|[_\-\s]|机|$)", candidate.name, re.IGNORECASE)
    return match.group(1).upper() if match else "?"


def _camera(path: Path, patterns: dict[str, str]) -> str:
    return infer_camera_label(path, patterns)


def read_media_directory(
    root: str | Path | Iterable[str | Path],
    camera_patterns: dict[str, str] | None = None,
    timeline_mode: str = "sequential",
    cancelled: Callable[[], bool] | None = None,
) -> list[Clip]:
    """Build clips from ordinary video media without pretending unsynced files overlap."""
    if isinstance(root, (str, Path)):
        directories = [Path(root)]
    else:
        directories = [Path(value) for value in root]
    patterns = camera_patterns or {}
    files_set: set[Path] = set()
    for directory in directories:
        if cancelled and cancelled():
            raise ResourceCancelled("媒体目录扫描已取消")
        if not directory.is_dir():
            continue
        for path in directory.rglob("*"):
            if cancelled and cancelled():
                raise ResourceCancelled("媒体目录扫描已取消")
            if path.is_file() and path.suffix.lower() in VIDEO_SUFFIXES and not path.name.startswith("._"):
                files_set.add(path)
    files = sorted(files_set, key=lambda path: str(path).casefold())
    rows = []
    for occurrence, path in enumerate(files):
        if cancelled and cancelled():
            raise ResourceCancelled("媒体探测已取消")
        duration, captured_at = _probe(path, cancelled)
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
