"""Device-local preview for batch media reconnection and audio role pooling.

This module is deliberately a pure, read-only library:

* ``preview_directory_relink`` never writes to a shared project JSON.  It only
  reads candidate files on the current machine and returns a response whose
  ``scope`` is ``device_local_response``.  Device paths (``/Volumes/...``,
  ``/Users/...``, Windows drive paths) are allowed in that response but must
  never be copied into a shared package -- see
  ``script_organizer/project_transfer/operations.py``.
* ``classify_audio_asset_role`` is a conservative heuristic.  It separates
  on-set sync recordings from post-production music / sfx so that BGM cannot
  silently enter the multicam sync pool.  Ambiguous cases are marked with a
  low confidence and still require human confirmation.
"""

from __future__ import annotations

import os
import re
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterator

from .media_identity import media_id_for_path

RELINK_CONTRACT = "media_batch_relink_preview.v1"

_MUSIC_ASCII = re.compile(r"(?<![a-z])(?:bgm|music|ost)(?![a-z])")
_MUSIC_CJK = ("配乐", "音乐")
_SFX_ASCII = re.compile(r"(?<![a-z])(?:sfx|whoosh|foley)(?![a-z])")
_SFX_CJK = ("音效", "转场")
_SYNC_ASCII = re.compile(r"(?<![a-z])(?:zoom|mixpre|sounddevices|boom|lav)(?![a-z])")
_SYNC_CJK = ("同期", "场")
_TAKE_TOKEN = re.compile(r"(?<![a-z0-9])t\d{2,3}(?![a-z0-9])")
_VIDEO_SUFFIXES = {
    ".mov", ".mp4", ".m4v", ".mxf", ".mkv", ".avi",
    ".r3d", ".braw", ".mts", ".m2ts", ".mpg", ".mpeg",
}
_LOSSLESS_SUFFIXES = {".wav", ".aif", ".aiff"}
_COMPRESSED_SUFFIXES = {".mp3", ".aac", ".m4a", ".flac", ".ogg"}
_AUDIO_SUFFIXES = _LOSSLESS_SUFFIXES | _COMPRESSED_SUFFIXES
_SHORT_SFX_SECONDS = 2.0


def _media_family(suffix: str) -> str:
    ext = suffix.casefold()
    if ext in _VIDEO_SUFFIXES:
        return "video"
    if ext in _AUDIO_SUFFIXES:
        return "audio"
    return ext


def _role_result(role: str, confidence: str, reason: str) -> dict[str, Any]:
    return {
        "role": role,
        "confidence": confidence,
        "reason": reason,
        "sync_eligible": role == "sync_recording",
    }


def _match_token(haystack: str, ascii_pattern: re.Pattern[str], cjk_keywords: tuple[str, ...]) -> str:
    match = ascii_pattern.search(haystack)
    if match:
        return match.group(0)
    for keyword in cjk_keywords:
        if keyword in haystack:
            return keyword
    return ""


def classify_audio_asset_role(
    path_or_name: str | Path,
    *,
    duration_seconds: float | None = None,
    channels: int | None = None,
) -> dict[str, Any]:
    """Classify one audio asset into a sync / music / sfx pool.

    Keywords describing post-production intent win over format heuristics, so
    a WAV named ``BGM_01.wav`` stays out of the multicam sync pool.  Only
    ``sync_recording`` sets ``sync_eligible=True``.
    """
    text = str(path_or_name or "")
    lowered = text.casefold()
    name = Path(text).name
    suffix = Path(name).suffix.casefold()

    music_keyword = _match_token(lowered, _MUSIC_ASCII, _MUSIC_CJK)
    if music_keyword:
        return _role_result(
            "music",
            "high",
            f"music keyword '{music_keyword}' in directory/file name; post-production music asset",
        )

    sfx_keyword = _match_token(lowered, _SFX_ASCII, _SFX_CJK)
    if sfx_keyword:
        return _role_result(
            "sfx",
            "high",
            f"sfx keyword '{sfx_keyword}' in directory/file name; post-production sound effect",
        )

    sync_keyword = _match_token(lowered, _SYNC_ASCII, _SYNC_CJK)
    take_match = _TAKE_TOKEN.search(name.casefold())
    if suffix in _LOSSLESS_SUFFIXES and (sync_keyword or take_match):
        token = sync_keyword or (take_match.group(0) if take_match else "")
        return _role_result(
            "sync_recording",
            "high",
            f"lossless on-set audio with field/take token '{token}'",
        )

    if suffix == ".wav" and channels is not None and channels > 1:
        return _role_result(
            "sync_recording",
            "medium",
            f"multichannel WAV ({channels} channels) treated as an on-set recording candidate",
        )

    if suffix in _COMPRESSED_SUFFIXES:
        return _role_result(
            "music",
            "low",
            f"compressed audio '{suffix}' without music/sfx keywords defaults to music; "
            "low confidence, requires confirmation",
        )

    if suffix in _LOSSLESS_SUFFIXES:
        if duration_seconds is not None and duration_seconds < _SHORT_SFX_SECONDS:
            return _role_result(
                "sfx",
                "low",
                "very short lossless clip without keywords; possible sound effect, "
                "requires confirmation",
            )
        return _role_result(
            "sync_recording",
            "low",
            "lossless audio without an explicit field/take token; heuristic sync candidate, "
            "requires confirmation",
        )

    return _role_result(
        "music",
        "low",
        "unrecognized audio format defaults to music; low confidence, requires confirmation",
    )


def _iter_safe_files(root: Path, stats: dict[str, int]) -> Iterator[Path]:
    """Yield non-hidden regular files, never following symlinks outside root."""
    root_real = root.resolve()
    visited: set[str] = set()
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            real_current = str(current.resolve())
            if real_current in visited:
                continue
            visited.add(real_current)
            entries = list(os.scandir(current))
        except OSError:
            continue
        for entry in entries:
            name = entry.name
            if name.startswith("."):  # includes .git, .Trashes, .DS_Store, ._ AppleDouble
                continue
            try:
                if entry.is_symlink():
                    resolved = Path(entry.path).resolve()
                    try:
                        resolved.relative_to(root_real)
                    except ValueError:
                        stats["symlinks_skipped"] += 1
                        continue
                if entry.is_dir(follow_symlinks=True):
                    stack.append(Path(entry.path))
                elif entry.is_file(follow_symlinks=True):
                    yield Path(entry.path)
            except OSError:
                continue


def _coerce_size(value: Any) -> int | None:
    try:
        size = int(value)
    except (TypeError, ValueError):
        return None
    return size if size >= 0 else None


def _expected_media(material_index: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """One row per physical media_id that has a usable file name."""
    items: list[Any] = []
    if isinstance(material_index, dict):
        for bucket in ("clips", "recordings"):
            raw = material_index.get(bucket, [])
            if isinstance(raw, list):
                items.extend(raw)
    rows: dict[str, dict[str, Any]] = {}
    for clip in items:
        if not isinstance(clip, dict):
            continue
        media_id = str(clip.get("media_id", "") or "").strip()
        raw_name = (
            clip.get("file_name")
            or clip.get("name")
            or clip.get("media_path")
            or clip.get("source_media_path")
            or ""
        )
        name = Path(str(raw_name)).name
        if not media_id or not name or media_id in rows:
            continue
        rows[media_id] = {
            "media_id": media_id,
            "name": name,
            "name_key": name.casefold(),
            "stem_key": Path(name).stem.casefold(),
            "media_family": _media_family(Path(name).suffix),
            "size_bytes": _coerce_size(
                clip.get("size_bytes")
                if clip.get("size_bytes") is not None
                else clip.get("file_size")
            ),
        }
    return rows


def _file_size(path: Path) -> int | None:
    try:
        return int(path.stat().st_size)
    except OSError:
        return None


def preview_directory_relink(
    material_index: dict[str, Any],
    scan_root: str | Path,
    *,
    max_files: int = 20000,
) -> dict[str, Any]:
    """Preview which indexed media can be reconnected from a device-local root.

    Two-stage matching: cheap ``(lowercase filename, size_bytes)`` prefilter,
    then content fingerprint via ``media_id_for_path`` on the few candidates.
    A fingerprint hit is exact; a filename hit without a fingerprint match is
    downgraded to ``requires_confirmation=True``.  Nothing on disk is changed.
    """
    root = Path(scan_root).expanduser()
    if not root.is_dir() or not os.access(root, os.R_OK | os.X_OK):
        raise ValueError(f"扫描目录不存在或不可读取：{root}")
    limit = max(0, int(max_files))
    stats = {"symlinks_skipped": 0}

    files: list[Path] = []
    for path in _iter_safe_files(root, stats):
        files.append(path)
        if len(files) > limit:
            break
    truncated = len(files) > limit
    if truncated:
        files = files[:limit]

    files_by_name: dict[str, list[Path]] = defaultdict(list)
    files_by_stem: dict[str, list[Path]] = defaultdict(list)
    for path in files:
        files_by_name[path.name.casefold()].append(path)
        files_by_stem[path.stem.casefold()].append(path)

    expected = _expected_media(material_index)
    matched_exact: list[dict[str, Any]] = []
    matched_filename_only: list[dict[str, Any]] = []
    still_missing: list[dict[str, Any]] = []

    for media_id, row in expected.items():
        candidates: list[Path] = []
        seen_paths: set[str] = set()
        stem_matches = [
            path
            for path in files_by_stem.get(row["stem_key"], [])
            if _media_family(path.suffix) == row["media_family"]
        ]
        for path in files_by_name.get(row["name_key"], []) + stem_matches:
            try:
                key = str(path.resolve())
            except OSError:
                key = str(path)
            if key not in seen_paths:
                seen_paths.add(key)
                candidates.append(path)

        expected_size = row["size_bytes"]
        # Prefer a same-size candidate; still keep other same-name files so a
        # renamed/edited copy can be reported as a filename-only fallback.
        candidates.sort(
            key=lambda path: (
                0 if expected_size is not None and _file_size(path) == expected_size else 1,
                str(path).casefold(),
            )
        )

        found_exact = False
        fallback: Path | None = None
        for path in candidates:
            actual_id = media_id_for_path(path)
            if actual_id and actual_id == media_id:
                matched_exact.append(
                    {
                        "media_id": media_id,
                        "name": row["name"],
                        "candidate_path": str(path),
                        "confidence": "exact_media_id",
                        "requires_confirmation": False,
                        "size_bytes": _file_size(path),
                    }
                )
                found_exact = True
                break
            if fallback is None:
                fallback = path

        if found_exact:
            continue
        if fallback is not None:
            matched_filename_only.append(
                {
                    "media_id": media_id,
                    "name": row["name"],
                    "candidate_path": str(fallback),
                    "confidence": "filename_only",
                    "requires_confirmation": True,
                    "reason": "name matched but content fingerprint did not (or expected size unavailable)",
                    "size_bytes": _file_size(fallback),
                }
            )
        else:
            still_missing.append(
                {
                    "media_id": media_id,
                    "name": row["name"],
                    "requires_confirmation": False,
                    "reason": "no candidate with a matching file name in the scan root",
                }
            )

    order = lambda item: (str(item.get("name", "")).casefold(), str(item.get("media_id", "")))
    matched_exact.sort(key=order)
    matched_filename_only.sort(key=order)
    still_missing.sort(key=order)

    return {
        "contract": RELINK_CONTRACT,
        "scope": "device_local_response",
        "scan_root": str(root),
        "truncated": truncated,
        "files_scanned": len(files),
        "symlinks_skipped": stats["symlinks_skipped"],
        "summary": {
            "total_media": len(expected),
            "exact_count": len(matched_exact),
            "filename_only_count": len(matched_filename_only),
            "missing_count": len(still_missing),
        },
        "matched_exact": matched_exact,
        "matched_filename_only": matched_filename_only,
        "still_missing": still_missing,
    }
