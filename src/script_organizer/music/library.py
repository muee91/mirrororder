from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import wave
from pathlib import Path
from typing import Any

from .models import LicenseRecord, MusicAsset, MusicSection

AUDIO_SUFFIXES = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".aif", ".aiff", ".ogg"}


def _load_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, ValueError):
        return {}


def _probe_duration(path: Path) -> float:
    if path.suffix.lower() == ".wav":
        try:
            with wave.open(str(path), "rb") as handle:
                rate = handle.getframerate()
                return handle.getnframes() / rate if rate else 0.0
        except (wave.Error, OSError):
            pass
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        try:
            result = subprocess.run(
                [
                    ffprobe,
                    "-v", "error",
                    "-show_entries", "format=duration",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    str(path),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=12,
                check=False,
            )
            return max(0.0, float((result.stdout or "0").strip() or 0))
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
    return 0.0


def _asset_id(path: Path) -> str:
    digest = hashlib.sha1()
    try:
        size = path.stat().st_size
        digest.update(str(size).encode("ascii"))
        with path.open("rb") as handle:
            digest.update(handle.read(1024 * 1024))
            if size > 1024 * 1024:
                handle.seek(max(0, size - 1024 * 1024))
                digest.update(handle.read(1024 * 1024))
    except OSError:
        digest.update(str(path).encode("utf-8"))
    return "MU_" + digest.hexdigest()[:20]


def _words(value: object) -> tuple[str, ...]:
    if isinstance(value, str):
        rows = re.split(r"[,，;/|\s]+", value)
    elif isinstance(value, list):
        rows = [str(item) for item in value]
    else:
        rows = []
    return tuple(sorted({item.strip().casefold() for item in rows if item.strip()}))


def _manifest_rows(root: Path) -> dict[str, dict[str, Any]]:
    payload = _load_json(root / "music_library.json")
    rows = payload.get("tracks", [])
    result: dict[str, dict[str, Any]] = {}
    if isinstance(rows, list):
        for row in rows:
            if not isinstance(row, dict):
                continue
            key = str(row.get("path", "") or "").replace("\\", "/").lstrip("./")
            if key:
                result[key] = row
    return result


def _metadata_for(root: Path, path: Path, manifest: dict[str, dict[str, Any]]) -> dict[str, Any]:
    relative = path.relative_to(root).as_posix()
    result = dict(manifest.get(relative, {}))
    sidecar = path.with_suffix(path.suffix + ".music.json")
    if sidecar.is_file():
        result.update(_load_json(sidecar))
    return result


def _strict_bool(value: object) -> bool:
    return value is True


def _license(metadata: dict[str, Any]) -> LicenseRecord:
    raw = metadata.get("license", {})
    raw = raw if isinstance(raw, dict) else {}
    return LicenseRecord(
        source=str(raw.get("source", "unknown") or "unknown"),
        license_id=str(raw.get("license_id", raw.get("id", "unverified")) or "unverified"),
        source_url=str(raw.get("source_url", "") or ""),
        creator=str(raw.get("creator", "") or ""),
        commercial_use=_strict_bool(raw.get("commercial_use", False)),
        sync_right=_strict_bool(raw.get("sync_right", False)),
        attribution_required=_strict_bool(raw.get("attribution_required", False)),
        attribution_text=str(raw.get("attribution_text", "") or ""),
    )


def _sections(metadata: dict[str, Any], duration: float) -> tuple[MusicSection, ...]:
    result: list[MusicSection] = []
    raw = metadata.get("sections", [])
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            try:
                start = max(0.0, float(item.get("start", 0.0) or 0.0))
                end = min(duration, float(item.get("end", duration) or duration)) if duration else float(item.get("end", 0.0) or 0.0)
            except (TypeError, ValueError):
                continue
            if end <= start:
                continue
            result.append(
                MusicSection(
                    start=start,
                    end=end,
                    kind=str(item.get("kind", "section") or "section"),
                    tags=_words(item.get("tags", [])),
                )
            )
    if not result and duration > 0:
        result.append(MusicSection(0.0, duration, "full", ()))
    return tuple(result)


def _infer_filename_tags(path: Path) -> tuple[str, ...]:
    stem = re.sub(r"[_\-.]+", " ", path.stem.casefold())
    return _words(stem)


def index_music_library(root: str | Path) -> dict[str, Any]:
    library_root = Path(root).expanduser().resolve()
    if not library_root.is_dir():
        raise ValueError(f"音乐库目录不存在：{library_root}")
    manifest = _manifest_rows(library_root)
    assets: list[MusicAsset] = []
    for path in sorted(library_root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in AUDIO_SUFFIXES:
            continue
        metadata = _metadata_for(library_root, path, manifest)
        duration = _probe_duration(path)
        tags = tuple(sorted(set(_infer_filename_tags(path)) | set(_words(metadata.get("tags", [])))))
        try:
            bpm_value = float(metadata["bpm"]) if metadata.get("bpm") is not None else None
        except (TypeError, ValueError):
            bpm_value = None
        try:
            vocal_probability = max(0.0, min(1.0, float(metadata.get("vocal_probability", 0.0) or 0.0)))
        except (TypeError, ValueError):
            vocal_probability = 0.0
        try:
            energy = max(0.0, min(1.0, float(metadata.get("energy", 0.5) or 0.5)))
        except (TypeError, ValueError):
            energy = 0.5
        assets.append(
            MusicAsset(
                asset_id=_asset_id(path),
                path=path.relative_to(library_root).as_posix(),
                title=str(metadata.get("title", path.stem) or path.stem),
                duration=duration,
                tags=tags,
                moods=_words(metadata.get("moods", [])),
                styles=_words(metadata.get("styles", [])),
                bpm=bpm_value,
                musical_key=str(metadata.get("key", metadata.get("musical_key", "")) or ""),
                vocal_probability=vocal_probability,
                energy=energy,
                sections=_sections(metadata, duration),
                license=_license(metadata),
            )
        )
    return {
        "version": 1,
        "contract": "music-library.v1",
        "library_name": library_root.name or "music-library",
        "summary": {
            "tracks": len(assets),
            "eligible": sum(1 for item in assets if item.license.eligible),
            "unverified_or_restricted": sum(1 for item in assets if not item.license.eligible),
        },
        "assets": [item.to_dict() for item in assets],
    }


def assets_from_index(payload: dict[str, Any]) -> list[MusicAsset]:
    result: list[MusicAsset] = []
    for raw in payload.get("assets", []):
        if not isinstance(raw, dict):
            continue
        lic = raw.get("license", {}) if isinstance(raw.get("license"), dict) else {}
        sections = []
        for item in raw.get("sections", []):
            if isinstance(item, dict):
                sections.append(
                    MusicSection(
                        float(item.get("start", 0) or 0),
                        float(item.get("end", 0) or 0),
                        str(item.get("kind", "section") or "section"),
                        tuple(str(value) for value in item.get("tags", []) if value),
                    )
                )
        result.append(
            MusicAsset(
                asset_id=str(raw.get("asset_id", "")),
                path=str(raw.get("path", "")),
                title=str(raw.get("title", "")),
                duration=float(raw.get("duration", 0) or 0),
                tags=tuple(str(value) for value in raw.get("tags", []) if value),
                moods=tuple(str(value) for value in raw.get("moods", []) if value),
                styles=tuple(str(value) for value in raw.get("styles", []) if value),
                bpm=float(raw["bpm"]) if raw.get("bpm") is not None else None,
                musical_key=str(raw.get("musical_key", "")),
                vocal_probability=float(raw.get("vocal_probability", 0) or 0),
                energy=float(raw.get("energy", 0.5) or 0.5),
                sections=tuple(sections),
                license=LicenseRecord(
                    source=str(lic.get("source", "unknown")),
                    license_id=str(lic.get("license_id", "unverified")),
                    source_url=str(lic.get("source_url", "")),
                    creator=str(lic.get("creator", "")),
                    commercial_use=_strict_bool(lic.get("commercial_use", False)),
                    sync_right=_strict_bool(lic.get("sync_right", False)),
                    attribution_required=_strict_bool(lic.get("attribution_required", False)),
                    attribution_text=str(lic.get("attribution_text", "")),
                ),
            )
        )
    return result
