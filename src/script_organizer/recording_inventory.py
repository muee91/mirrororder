"""Automatic sync preflight. Discovery is NOT synchronization or provenance."""
from __future__ import annotations

import json
import os
import re
import subprocess
import wave
from pathlib import Path
from typing import Callable

from .media_batch_relink import classify_audio_asset_role
from .media_identity import media_id_for_path


_CLOCK_NAME_RE = re.compile(r"(?<!\d)(?P<date>20\d{6}|\d{8})[_-](?P<time>\d{6})(?:[_-]|\.|$)")


def _recording_clock_hint(path: Path, tags: dict[str, object] | None = None) -> dict[str, str | int]:
    """Read device-clock metadata as a path-free hint, never as placement authority."""
    hint: dict[str, str | int] = {}
    match = _CLOCK_NAME_RE.search(path.stem)
    if match:
        raw_date = match.group("date")
        hint["filename_date"] = raw_date if len(raw_date) == 8 else "20" + raw_date
        hint["filename_time"] = match.group("time")
    for key in ("date", "creation_time", "time_reference"):
        value = tags.get(key) if tags else None
        if value not in (None, ""):
            hint[key] = int(value) if key == "time_reference" and str(value).isdigit() else str(value)
    return hint


def _probe_audio_with_ffprobe(path: Path) -> tuple[tuple[int, int, int, float], dict[str, str | int]] | None:
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries",
             "stream=codec_type,sample_rate,channels,nb_frames:format=duration:format_tags=date,creation_time,time_reference",
             "-of", "json", str(path)],
            capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    try:
        payload = json.loads(result.stdout)
        stream = next(item for item in payload.get("streams", []) if item.get("codec_type") == "audio")
        sample_rate = int(stream.get("sample_rate") or 0)
        channels = int(stream.get("channels") or 0)
        frame_count = int(stream.get("nb_frames") or 0)
        duration = float(payload.get("format", {}).get("duration") or 0.0)
        tags = payload.get("format", {}).get("tags", {})
    except (KeyError, TypeError, ValueError, StopIteration):
        return None
    if sample_rate <= 0 or channels <= 0 or duration <= 0:
        return None
    sample_count = frame_count if frame_count > 0 else round(duration * sample_rate)
    if sample_count <= 0:
        return None
    return (sample_rate, sample_count, channels, duration), _recording_clock_hint(
        path, tags if isinstance(tags, dict) else None
    )


def _probe_audio(path: Path) -> tuple[tuple[int, int, int, float], dict[str, str | int]] | None:
    try:
        with wave.open(str(path), "rb") as audio:
            sample_rate = audio.getframerate()
            sample_count = audio.getnframes()
            channels = audio.getnchannels()
        duration = sample_count / sample_rate if sample_rate > 0 else 0.0
        return (sample_rate, sample_count, channels, duration), _recording_clock_hint(path)
    except (OSError, EOFError, wave.Error):
        return _probe_audio_with_ffprobe(path)


def discover_recordings(roots: tuple[Path, ...], *, output: Path,
                        roles: dict, check_cancelled: Callable[[], None], local_paths: dict | None = None) -> dict:
    rows: dict[str, dict] = {}
    unreadable = derived = excluded = 0
    visited: set[Path] = set()
    output = output.resolve()
    for root in sorted({Path(p).resolve() for p in roots}):
        check_cancelled()
        if not root.is_dir():
            unreadable += 1
            continue
        errors = []
        for directory, dirs, files in os.walk(root, followlinks=False, onerror=errors.append):
            check_cancelled()
            here = Path(directory)
            dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d != '交付'
                             and (here / d).resolve() != output and not (here / d).is_symlink())
            for name in sorted(files):
                if name.startswith('._') or Path(name).suffix.lower() != '.wav':
                    continue
                path = here / name
                if path.is_symlink() or path.resolve() in visited:
                    continue
                visited.add(path.resolve())
                check_cancelled()
                if any(p.casefold().replace('_', ' ') == 'corrected audio' for p in path.relative_to(root).parts):
                    derived += 1
                    continue
                identity = media_id_for_path(path)
                if not identity:
                    unreadable += 1
                    continue
                if roles.get(identity, {}).get('sync_policy') == 'exclude':
                    excluded += 1
                    continue
                row = {
                    'media_id': identity,
                    'name': path.name,
                    'status': 'unverified_candidate',
                    'source_kind': 'unverified',
                }
                duration_seconds: float | None = None
                probed = _probe_audio(path)
                if probed is not None:
                    (sample_rate, sample_count, channels, duration_seconds), clock_hint = probed
                    row.update(sample_rate=sample_rate, sample_count=sample_count, channels=channels)
                    if sample_count <= 0 or sample_rate <= 0 or channels <= 0:
                        row['status'] = 'invalid_or_empty_audio'
                    if clock_hint:
                        row['clock_hint'] = clock_hint
                else:
                    row['status'] = 'unsupported_or_unreadable_audio'
                # Read-only, non-authoritative hint.  It must never filter out a
                # file or change the existing recording_inventory.v1 fields.
                row['audio_role_hint'] = classify_audio_asset_role(
                    path, duration_seconds=duration_seconds, channels=row.get('channels')
                )
                rows[identity] = row
                if local_paths is not None:
                    local_paths[identity] = path
        unreadable += len(errors)
    return {'contract': 'recording_inventory.v1', 'status': 'discovered_not_synchronized',
            'coverage': 'configured_media_roots_only_not_complete_recording_roster',
            'candidates': [rows[key] for key in sorted(rows)], 'unreadable_entries': unreadable,
            'derived_candidates_excluded': derived, 'explicitly_excluded': excluded}


def recording_diagnostics(inventory: dict) -> list[dict[str, str]]:
    diagnostics: list[dict[str, str]] = []
    if inventory['candidates'] or inventory['unreadable_entries'] or inventory['derived_candidates_excluded']:
        diagnostics.append({'code': 'recordings_not_automatically_aligned', 'message':
                            '独立录音尚未自动对齐：已盘点登记素材根中的 WAV，但缺少可信原始时钟/事件锚点；发现不等于同步。已有录音摆位保留，不能宣称完整录音交付。'})
        if any(isinstance(row.get('clock_hint'), dict) for row in inventory['candidates'] if isinstance(row, dict)):
            diagnostics.append({'code': 'recording_device_clock_hint_only', 'message':
                                '已读取录音设备时间提示；同步摆位仍以波形证据或人工确认的母版播放头为准。'})
        return diagnostics
    return [{'code': 'recording_roster_unknown', 'message':
             '登记素材根未发现可用独立 WAV；这不证明项目没有外录音，当前产物仅能视为视频/机内参考声同步。'}]
