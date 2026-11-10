from __future__ import annotations

import json
import math
import re
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime
from fractions import Fraction
from pathlib import Path
from typing import Callable, Iterable

from .fcpxml_reader import stable_clip_id
from .media_identity import media_identity
from .models import Clip
from .resource_scheduler import ResourceCancelled


VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".mxf", ".mts", ".avi", ".mkv"}
_CONVENTIONAL_CAMERAS = ("A", "B", "C")


@dataclass(frozen=True)
class MediaProbe:
    """Small, serializable ffprobe result used by media-directory analysis.

    ``__iter__`` deliberately preserves the old two-value unpacking contract
    (duration, captured_at) for callers that used the private helper in tests.
    """

    duration: float
    captured_at: float | None
    fps: float | None = None
    timecode: str = ""
    rotation: int | None = None
    status: str = "ok"
    error: str = ""

    def __iter__(self):
        yield self.duration
        yield self.captured_at


def _failed_probe(error: str) -> MediaProbe:
    # Never substitute a plausible duration for an unreadable file.  A zero
    # duration also keeps invalid media from creating phantom timeline spans.
    return MediaProbe(0.0, None, status="probe_failed", error=error[:500])


def _parse_rate(value: object) -> float | None:
    text = str(value or "").strip()
    if not text or text in {"0/0", "0", "N/A"}:
        return None
    try:
        rate = float(Fraction(text)) if "/" in text else float(text)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    return rate if math.isfinite(rate) and rate > 0 else None


def _parse_rotation(stream: dict) -> int | None:
    side_data = stream.get("side_data_list", [])
    if isinstance(side_data, list):
        for item in side_data:
            if isinstance(item, dict) and item.get("rotation") is not None:
                value = item.get("rotation")
                try:
                    return int(round(float(value)))
                except (TypeError, ValueError):
                    pass
    tags = stream.get("tags", {})
    if isinstance(tags, dict) and tags.get("rotate") is not None:
        try:
            return int(round(float(tags["rotate"])))
        except (TypeError, ValueError):
            pass
    return None


def _probe(path: Path, cancelled: Callable[[], bool] | None = None) -> MediaProbe:
    """Read media metadata without importing a media framework.

    ffprobe failures are explicit.  Returning a made-up one-second duration
    here used to make empty/truncated files appear playable to analysis.
    """
    command = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "format=duration:format_tags=creation_time,timecode:stream=avg_frame_rate,r_frame_rate:stream_tags=timecode,rotate:stream_side_data=rotation",
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
                return _failed_probe("ffprobe timeout")
            try:
                stdout, _stderr = process.communicate(timeout=min(0.25, remaining))
                if process.returncode != 0:
                    return _failed_probe(f"ffprobe exited with code {process.returncode}")
                break
            except subprocess.TimeoutExpired:
                continue
        payload = json.loads(stdout or "")
        if not isinstance(payload, dict):
            return _failed_probe("ffprobe returned non-object JSON")
        format_row = payload.get("format", {})
        if not isinstance(format_row, dict):
            return _failed_probe("ffprobe response missing format")
        raw_duration = format_row.get("duration")
        try:
            duration = float(raw_duration)
        except (TypeError, ValueError):
            duration = 0.0
        if not math.isfinite(duration) or duration <= 0:
            return _failed_probe("media duration is missing or non-positive")
        creation_time = None
        format_tags = format_row.get("tags", {})
        raw_time = format_tags.get("creation_time") if isinstance(format_tags, dict) else None
        if raw_time:
            try:
                creation_time = datetime.fromisoformat(str(raw_time).replace("Z", "+00:00")).timestamp()
            except (TypeError, ValueError, OverflowError):
                # Bad creation metadata does not make an otherwise decodable
                # stream unusable; fall back to filesystem mtime ordering.
                creation_time = None
        streams = payload.get("streams", [])
        stream = streams[0] if isinstance(streams, list) and streams and isinstance(streams[0], dict) else {}
        if not stream:
            return _failed_probe("video stream is missing")
        stream_tags = stream.get("tags", {}) if isinstance(stream, dict) else {}
        timecode = ""
        if isinstance(stream_tags, dict):
            timecode = str(stream_tags.get("timecode", "") or "").strip()
        if not timecode and isinstance(format_tags, dict):
            timecode = str(format_tags.get("timecode", "") or "").strip()
        fps = _parse_rate(stream.get("avg_frame_rate") or stream.get("r_frame_rate")) if stream else None
        return MediaProbe(
            duration,
            creation_time,
            fps=fps,
            timecode=timecode,
            rotation=_parse_rotation(stream) if stream else None,
        )
    except json.JSONDecodeError:
        return _failed_probe("ffprobe returned invalid JSON")
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return _failed_probe(str(error) or "ffprobe failed")


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
        raw_probe = _probe(path, cancelled)
        # Keep compatibility with test doubles and older integrations that
        # returned only (duration, captured_at).
        if isinstance(raw_probe, MediaProbe):
            probe = raw_probe
        else:
            try:
                duration, captured_at = raw_probe
                numeric_duration = float(duration)
                probe = MediaProbe(
                    max(0.0, numeric_duration),
                    captured_at,
                    status="ok" if math.isfinite(numeric_duration) and numeric_duration > 0 else "probe_failed",
                    error="media duration is missing or non-positive"
                    if not math.isfinite(numeric_duration) or numeric_duration <= 0
                    else "",
                )
            except (TypeError, ValueError):
                probe = _failed_probe("invalid probe result")
        try:
            stat_time = path.stat().st_mtime
        except OSError:
            stat_time = 0.0
            if probe.status == "ok":
                probe = _failed_probe("media path disappeared during probe")
        captured_at = probe.captured_at if probe.captured_at is not None else stat_time
        rows.append((path, probe, captured_at, occurrence))
    if timeline_mode == "sequential":
        rows.sort(key=lambda row: str(row[0]).casefold())
    else:
        rows.sort(key=lambda row: (row[2], str(row[0]).casefold()))
    if not rows:
        return []
    first_time = rows[0][2]
    cursor = Fraction(0)
    clips: list[Clip] = []
    for path, probe, captured_at, occurrence in rows:
        duration_fraction = Fraction(str(round(max(0.0, probe.duration), 3)))
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
                exists=probe.status == "ok",
                source_asset_id="media-directory",
                source_start=Fraction(0),
                source_end=duration_fraction,
                media_id=media_identity(path),
                probe_status=probe.status,
                probe_error=probe.error,
                fps=probe.fps,
                timecode=probe.timecode,
                rotation=probe.rotation,
            )
        )
    return clips
