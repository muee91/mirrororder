from __future__ import annotations

import hashlib
import json
import re
import shutil
import statistics
import subprocess
import wave
from pathlib import Path
from typing import Any

from .analysis import ANALYSIS_VERSION, analyze_audio
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


def _float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _sections_from_rows(
    rows: object,
    duration: float,
    *,
    default_source: str,
) -> tuple[MusicSection, ...]:
    result: list[MusicSection] = []
    if not isinstance(rows, list):
        return ()
    for item in rows:
        if not isinstance(item, dict):
            continue
        start = max(0.0, _float(item.get("start"), 0.0))
        raw_end = _float(item.get("end"), duration)
        end = min(duration, raw_end) if duration else raw_end
        if end <= start:
            continue
        energy_value = item.get("energy")
        energy = None if energy_value is None else max(0.0, min(1.0, _float(energy_value, 0.5)))
        result.append(
            MusicSection(
                start=start,
                end=end,
                kind=str(item.get("kind", "section") or "section"),
                tags=_words(item.get("tags", [])),
                energy=energy,
                boundary_source=str(item.get("boundary_source", default_source) or default_source),
            )
        )
    return tuple(result)


def _infer_filename_tags(path: Path) -> tuple[str, ...]:
    stem = re.sub(r"[_\-.]+", " ", path.stem.casefold())
    return _words(stem)


def _bpm_from_beats(beats: tuple[float, ...]) -> float | None:
    if len(beats) < 4:
        return None
    intervals = [right - left for left, right in zip(beats, beats[1:]) if 0.2 <= right - left <= 2.0]
    if not intervals:
        return None
    median = statistics.median(intervals)
    if median <= 0:
        return None
    bpm = 60.0 / median
    while bpm < 70:
        bpm *= 2
    while bpm > 180:
        bpm /= 2
    return round(bpm, 3)


def _curve_from_analysis(analysis: dict[str, Any]) -> tuple[tuple[float, float], ...]:
    result = []
    rows = analysis.get("energy_curve", [])
    if isinstance(rows, list):
        for item in rows:
            if not isinstance(item, dict):
                continue
            result.append(
                (
                    max(0.0, _float(item.get("time"), 0.0)),
                    max(0.0, min(1.0, _float(item.get("value"), 0.0))),
                )
            )
    return tuple(result)


def index_music_library(
    root: str | Path,
    *,
    analysis_mode: str = "off",
    force_analysis: bool = False,
) -> dict[str, Any]:
    library_root = Path(root).expanduser().resolve()
    if not library_root.is_dir():
        raise ValueError(f"音乐库目录不存在：{library_root}")
    mode = str(analysis_mode or "off").strip().lower()
    if mode not in {"off", "basic", "auto"}:
        raise ValueError(f"不支持的音乐分析模式：{mode}")
    manifest = _manifest_rows(library_root)
    assets: list[MusicAsset] = []
    warnings: list[str] = []
    for path in sorted(library_root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in AUDIO_SUFFIXES:
            continue
        metadata = _metadata_for(library_root, path, manifest)
        duration = _probe_duration(path)
        asset_id = _asset_id(path)
        analysis = analyze_audio(
            path,
            asset_id=asset_id,
            duration=duration,
            mode=mode,
            force=force_analysis,
        )
        warning = str(analysis.get("warning", "") or "")
        if warning:
            warnings.append(f"{path.name}: {warning}")

        beats = tuple(_float(value) for value in analysis.get("beats", []) if _float(value) >= 0)
        downbeats = tuple(_float(value) for value in analysis.get("downbeats", []) if _float(value) >= 0)
        curve = _curve_from_analysis(analysis)
        manual_sections = _sections_from_rows(metadata.get("sections", []), duration, default_source="metadata")
        analyzed_sections = _sections_from_rows(analysis.get("sections", []), duration, default_source="analysis")
        sections = manual_sections or analyzed_sections
        if not sections and duration > 0:
            sections = (MusicSection(0.0, duration, "full", (), None, "duration"),)

        tags = tuple(sorted(set(_infer_filename_tags(path)) | set(_words(metadata.get("tags", [])))))
        bpm_value = None
        if metadata.get("bpm") is not None:
            candidate = _float(metadata.get("bpm"), 0.0)
            bpm_value = candidate if candidate > 0 else None
        if bpm_value is None:
            bpm_value = _bpm_from_beats(beats)

        vocal_probability = max(0.0, min(1.0, _float(metadata.get("vocal_probability"), 0.0)))
        if metadata.get("energy") is not None:
            energy = max(0.0, min(1.0, _float(metadata.get("energy"), 0.5)))
        elif curve:
            energy = sum(value for _time, value in curve) / len(curve)
        else:
            energy = 0.5
        analysis_source = "+".join(
            value
            for value in (
                str(analysis.get("energy_source", "") or ""),
                str(analysis.get("beat_source", "") or ""),
            )
            if value and value not in {"off", "disabled", "unavailable"}
        ) or "none"

        assets.append(
            MusicAsset(
                asset_id=asset_id,
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
                sections=sections,
                license=_license(metadata),
                beats=beats,
                downbeats=downbeats,
                energy_curve=curve,
                analysis_source=analysis_source,
                analysis_version=int(analysis.get("version", 0) or 0),
            )
        )
    return {
        "version": 2,
        "contract": "music-library.v2",
        "library_name": library_root.name or "music-library",
        "analysis": {
            "mode": mode,
            "version": ANALYSIS_VERSION,
            "device_local_cache": True,
        },
        "summary": {
            "tracks": len(assets),
            "eligible": sum(1 for item in assets if item.license.eligible),
            "unverified_or_restricted": sum(1 for item in assets if not item.license.eligible),
            "analyzed": sum(1 for item in assets if item.analysis_source != "none"),
            "beat_tracked": sum(1 for item in assets if item.beats),
            "auto_sectioned": sum(1 for item in assets if any(section.boundary_source.startswith("energy") for section in item.sections)),
        },
        "warnings": warnings[:100],
        "assets": [item.to_dict() for item in assets],
    }


def assets_from_index(payload: dict[str, Any]) -> list[MusicAsset]:
    result: list[MusicAsset] = []
    for raw in payload.get("assets", []):
        if not isinstance(raw, dict):
            continue
        lic = raw.get("license", {}) if isinstance(raw.get("license"), dict) else {}
        sections = _sections_from_rows(raw.get("sections", []), _float(raw.get("duration"), 0.0), default_source="index")
        curve_rows = raw.get("energy_curve", [])
        curve: list[tuple[float, float]] = []
        if isinstance(curve_rows, list):
            for item in curve_rows:
                if isinstance(item, dict):
                    curve.append((_float(item.get("time"), 0.0), _float(item.get("value"), 0.0)))
        bpm_value = _float(raw.get("bpm"), 0.0) if raw.get("bpm") is not None else 0.0
        result.append(
            MusicAsset(
                asset_id=str(raw.get("asset_id", "")),
                path=str(raw.get("path", "")),
                title=str(raw.get("title", "")),
                duration=_float(raw.get("duration"), 0.0),
                tags=tuple(str(value) for value in raw.get("tags", []) if value),
                moods=tuple(str(value) for value in raw.get("moods", []) if value),
                styles=tuple(str(value) for value in raw.get("styles", []) if value),
                bpm=bpm_value if bpm_value > 0 else None,
                musical_key=str(raw.get("musical_key", "")),
                vocal_probability=max(0.0, min(1.0, _float(raw.get("vocal_probability"), 0.0))),
                energy=max(0.0, min(1.0, _float(raw.get("energy"), 0.5))),
                sections=sections,
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
                beats=tuple(_float(value) for value in raw.get("beats", []) if _float(value) >= 0),
                downbeats=tuple(_float(value) for value in raw.get("downbeats", []) if _float(value) >= 0),
                energy_curve=tuple(curve),
                analysis_source=str(raw.get("analysis_source", "none") or "none"),
                analysis_version=int(raw.get("analysis_version", 0) or 0),
            )
        )
    return result
