from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from array import array
from pathlib import Path
from typing import Any

ANALYSIS_VERSION = 2
ENERGY_WINDOW_SECONDS = 0.5
MIN_SECTION_SECONDS = 8.0

_BEAT_TRACKER: object | None = None
_BEAT_TRACKER_DEVICE = ""


def _cache_root() -> Path:
    configured = os.environ.get("MIRRORORDER_DEVICE_STATE_DIR", "").strip()
    if configured:
        root = Path(configured).expanduser().resolve()
    else:
        root = Path.home() / "Library" / "Application Support" / "MirrorOrder"
    path = root / "music-analysis-v2"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _cache_path(asset_id: str) -> Path:
    safe = "".join(char for char in asset_id if char.isalnum() or char in {"_", "-"})
    return _cache_root() / f"{safe or 'unknown'}.json"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = int(round((len(ordered) - 1) * max(0.0, min(1.0, fraction))))
    return ordered[index]


def _smooth(values: list[float], radius: int = 1) -> list[float]:
    if radius <= 0:
        return values[:]
    result = []
    for index in range(len(values)):
        start = max(0, index - radius)
        end = min(len(values), index + radius + 1)
        window = values[start:end]
        result.append(sum(window) / len(window))
    return result


def energy_curve(path: str | Path, *, sample_rate: int = 8000) -> list[dict[str, float]]:
    """Return a normalized RMS energy curve without adding Python audio dependencies."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return []
    source = Path(path).expanduser().resolve()
    try:
        result = subprocess.run(
            [
                ffmpeg,
                "-v",
                "error",
                "-i",
                str(source),
                "-vn",
                "-ac",
                "1",
                "-ar",
                str(sample_rate),
                "-f",
                "s16le",
                "-",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=180,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if result.returncode != 0 or not result.stdout:
        return []

    samples = array("h")
    samples.frombytes(result.stdout)
    if sys.byteorder != "little":
        samples.byteswap()
    window_size = max(1, int(sample_rate * ENERGY_WINDOW_SECONDS))
    db_values: list[float] = []
    times: list[float] = []
    for start in range(0, len(samples), window_size):
        window = samples[start : start + window_size]
        if not window:
            continue
        square_sum = sum(float(value) * float(value) for value in window)
        rms = math.sqrt(square_sum / len(window)) / 32768.0
        db_values.append(20.0 * math.log10(max(rms, 1e-6)))
        times.append((start + len(window) / 2) / sample_rate)
    if not db_values:
        return []

    smoothed = _smooth(db_values, radius=1)
    low = _percentile(smoothed, 0.10)
    high = _percentile(smoothed, 0.90)
    span = max(6.0, high - low)
    return [
        {
            "time": round(time_value, 3),
            "value": round(max(0.0, min(1.0, (db - low) / span)), 6),
        }
        for time_value, db in zip(times, smoothed)
    ]


def _beat_device() -> str:
    requested = os.environ.get("MIRRORORDER_BEAT_THIS_DEVICE", "auto").strip().lower()
    if requested and requested != "auto":
        return requested
    try:
        import torch

        if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


def beat_grid(path: str | Path) -> tuple[list[float], list[float], str, str]:
    """Run Beat This in-process when installed; failure is an explicit soft fallback."""
    global _BEAT_TRACKER, _BEAT_TRACKER_DEVICE
    try:
        from beat_this.inference import File2Beats
    except Exception as exc:
        return [], [], "unavailable", f"beat-this import failed: {exc.__class__.__name__}"

    device = _beat_device()
    checkpoint = os.environ.get("MIRRORORDER_BEAT_THIS_CHECKPOINT", "final0").strip() or "final0"
    try:
        if _BEAT_TRACKER is None or _BEAT_TRACKER_DEVICE != device:
            _BEAT_TRACKER = File2Beats(
                checkpoint_path=checkpoint,
                device=device,
                dbn=False,
            )
            _BEAT_TRACKER_DEVICE = device
        beats_raw, downbeats_raw = _BEAT_TRACKER(str(Path(path).expanduser().resolve()))  # type: ignore[misc]
        beats = sorted({round(float(value), 6) for value in beats_raw if float(value) >= 0})
        downbeats = sorted({round(float(value), 6) for value in downbeats_raw if float(value) >= 0})
        return beats, downbeats, f"beat-this:{device}", ""
    except Exception as exc:
        return [], [], "failed", f"beat-this failed: {exc.__class__.__name__}"


def _nearest(value: float, anchors: list[float], tolerance: float = 1.5) -> float | None:
    if not anchors:
        return None
    candidate = min(anchors, key=lambda item: abs(item - value))
    return candidate if abs(candidate - value) <= tolerance else None


def _mean_energy(curve: list[dict[str, float]], start: float, end: float) -> float:
    values = [
        float(item.get("value", 0.0))
        for item in curve
        if start <= float(item.get("time", 0.0)) < end
    ]
    return sum(values) / len(values) if values else 0.5


def detect_sections(
    duration: float,
    curve: list[dict[str, float]],
    downbeats: list[float] | None = None,
) -> list[dict[str, Any]]:
    """Heuristic energy segmentation, optionally snapped to downbeats."""
    if duration <= 0:
        return []
    downbeats = sorted(float(value) for value in (downbeats or []) if 0 <= float(value) <= duration)
    candidates: list[tuple[float, float]] = []
    for index in range(2, max(2, len(curve) - 2)):
        left = [float(item.get("value", 0.0)) for item in curve[max(0, index - 3) : index]]
        right = [float(item.get("value", 0.0)) for item in curve[index : min(len(curve), index + 3)]]
        if not left or not right:
            continue
        delta = abs(sum(right) / len(right) - sum(left) / len(left))
        if delta >= 0.20:
            candidates.append((float(curve[index].get("time", 0.0)), delta))

    if duration >= 36 and not candidates:
        candidates.extend([(duration / 3, 0.1), (duration * 2 / 3, 0.1)])

    candidates.sort(key=lambda item: (-item[1], item[0]))
    boundaries = [0.0]
    for raw_time, _strength in candidates:
        snapped = _nearest(raw_time, downbeats, tolerance=1.5)
        value = snapped if snapped is not None else raw_time
        if value < MIN_SECTION_SECONDS or duration - value < MIN_SECTION_SECONDS:
            continue
        if any(abs(value - existing) < MIN_SECTION_SECONDS for existing in boundaries):
            continue
        boundaries.append(value)
    boundaries.append(duration)
    boundaries = sorted(set(round(item, 3) for item in boundaries))

    sections: list[dict[str, Any]] = []
    peak_energy = -1.0
    peak_index = -1
    energies: list[float] = []
    for index in range(len(boundaries) - 1):
        start, end = boundaries[index], boundaries[index + 1]
        energy = _mean_energy(curve, start, end)
        energies.append(energy)
        if energy > peak_energy:
            peak_energy = energy
            peak_index = index

    for index in range(len(boundaries) - 1):
        start, end = boundaries[index], boundaries[index + 1]
        energy = energies[index]
        previous = energies[index - 1] if index else energy
        if index == 0:
            kind = "intro"
        elif index == peak_index and energy >= 0.62:
            kind = "climax"
        elif energy - previous >= 0.10:
            kind = "build"
        elif previous - energy >= 0.10:
            kind = "release"
        elif index == len(boundaries) - 2:
            kind = "outro"
        else:
            kind = "section"
        source = "energy"
        if _nearest(start, downbeats, tolerance=0.08) is not None and start > 0:
            source = "energy+downbeat"
        sections.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "kind": kind,
                "tags": [kind] if kind not in {"section", "intro", "outro"} else [],
                "energy": round(energy, 6),
                "boundary_source": source,
            }
        )
    return sections


def analyze_audio(
    path: str | Path,
    *,
    asset_id: str,
    duration: float,
    mode: str = "auto",
    force: bool = False,
) -> dict[str, Any]:
    mode = str(mode or "auto").strip().lower()
    if mode not in {"off", "basic", "auto"}:
        raise ValueError(f"不支持的音乐分析模式：{mode}")
    if mode == "off":
        return {
            "version": ANALYSIS_VERSION,
            "mode": "off",
            "beats": [],
            "downbeats": [],
            "energy_curve": [],
            "sections": [],
            "beat_source": "off",
            "energy_source": "off",
            "warning": "",
        }

    cache = _cache_path(asset_id)
    cached = _read_json(cache)
    if (
        not force
        and cached.get("version") == ANALYSIS_VERSION
        and cached.get("asset_id") == asset_id
        and cached.get("mode") == mode
    ):
        return cached

    curve = energy_curve(path)
    beats: list[float] = []
    downbeats: list[float] = []
    beat_source = "disabled"
    warning = ""
    if mode == "auto":
        beats, downbeats, beat_source, warning = beat_grid(path)
    sections = detect_sections(duration, curve, downbeats)
    payload = {
        "version": ANALYSIS_VERSION,
        "asset_id": asset_id,
        "mode": mode,
        "beats": beats,
        "downbeats": downbeats,
        "energy_curve": curve,
        "sections": sections,
        "beat_source": beat_source,
        "energy_source": "ffmpeg-pcm-rms-v1" if curve else "unavailable",
        "warning": warning,
    }
    _write_json(cache, payload)
    return payload
