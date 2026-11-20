"""Local bounded spectral shortlist. Correlation, not this index, verifies placement."""
from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from tempfile import NamedTemporaryFile
from time import monotonic
from typing import Any

import numpy as np

from .recording_waveform_solver import WaveformReference

_CACHE_RATE = 16_000
_HOP = _CACHE_RATE // 4
_SIZE = _CACHE_RATE // 2
_BANDS = np.unique(np.geomspace(15, 1800, 33).astype(int))
_MAX_FINGERPRINTS = 500_000
_MAX_FILES = 5_000
_MAX_CANDIDATES = 64
_VERSION = "bands-v1"


@dataclass(frozen=True)
class ReferenceCandidates:
    references: list[WaveformReference]
    complete: bool
    reason: str
    metadata: dict[str, int]


def normalize_waveform_samples(samples: np.ndarray) -> np.ndarray:
    """Preserve relative waveform shape where resampling overshoots unity."""
    values = np.asarray(samples, dtype=np.float32)
    peak = float(np.max(np.abs(values), initial=0))
    return values / peak if np.isfinite(peak) and peak > 1 else values


def _features(source: np.ndarray, deadline: float, hop: int, width: int, check_cancelled: Callable[[], None]) -> np.ndarray:
    count = max(0, (source.size - width) // hop + 1)
    features = np.empty((count, len(_BANDS) - 1), dtype=np.float32)
    window = np.hanning(width)
    bands = _BANDS  # Physical cutoff frequencies are stable because width = rate / 2.
    for first in range(0, count, 64):
        check_cancelled()
        if monotonic() >= deadline:
            raise TimeoutError
        last = min(first + 64, count)
        part = source[first * hop:(last - 1) * hop + width]
        frames = np.lib.stride_tricks.sliding_window_view(part, width)[::hop]
        if not np.isfinite(frames).all():
            raise ValueError("nonfinite_cache")
        power = abs(np.fft.rfft(frames * window, axis=1)) ** 2
        sums = np.cumsum(power, axis=1)
        band = np.log1p(np.maximum(0, (sums[:, bands[1:]] - sums[:, bands[:-1]]) / width))
        band -= band.mean(axis=1, keepdims=True)
        norm = np.linalg.norm(band, axis=1, keepdims=True)
        features[first:last] = np.divide(band, norm, out=np.zeros_like(band), where=norm > 1e-5)
    return features


def _identity(path: Path, stat: Any) -> str:
    raw = f"{_VERSION}\0{path}\0{stat.st_ino}\0{stat.st_dev}\0{stat.st_size}\0{stat.st_mtime_ns}"
    return sha256(raw.encode()).hexdigest()


def _cached_features(path: Path, stat: Any, root: Path, deadline: float, check_cancelled: Callable[[], None]) -> tuple[np.ndarray, bool]:
    key = _identity(path, stat)
    target = root / (key + ".npz")
    count = max(0, (stat.st_size // 4 - _SIZE) // _HOP + 1)
    try:
        with np.load(target, allow_pickle=False) as archive:
            features = archive["features"]
            if features.shape == (count, len(_BANDS) - 1) and features.dtype == np.float32 and np.isfinite(features).all():
                return features, True
    except (OSError, KeyError, ValueError):
        pass
    source = np.memmap(path, mode="r", dtype="<f4")
    features = _features(source, deadline, _HOP, _SIZE, check_cancelled)
    del source
    if _identity(path, path.stat()) != key:
        raise ValueError("cache_changed")
    temp: Path | None = None
    try:
        root.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile(dir=root, suffix=".npz", delete=False) as handle:
            temp = Path(handle.name)
            np.savez(handle, features=features)
        temp.replace(target)
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)
    return features, False


@dataclass(frozen=True)
class _Hit:
    score: float
    camera: str
    path: Path
    identity: str
    origin: int
    cache_index: int
    window_samples: int


def build_recording_reference_candidates(
    rows: Sequence[Mapping[str, Any]],
    windows: Sequence[tuple[int, np.ndarray]],
    cache_root: Path,
    sample_rate: int = 8000,
    check_cancelled: Callable[[], None] = lambda: None,
) -> ReferenceCandidates:
    """Search every supplied camera cache or report incomplete.

    Reference start coordinates must already account for stream start PTS in
    the caller's master sample grid. Caches contain little-endian 16kHz f32.
    Candidate completeness describes the input scan, not waveform uniqueness.
    """
    check_cancelled()
    deadline = monotonic() + 60
    stats = {"files": 0, "cache_hits": 0, "fingerprints": 0, "candidates": 0}

    def incomplete(reason: str) -> ReferenceCandidates:
        return ReferenceCandidates([], False, reason, stats)

    if len(rows) > _MAX_FILES or len(windows) > 9:
        return incomplete("budget_incomplete")
    if sample_rate not in (8000, 16000) or not windows:
        return incomplete("unsupported_query")
    queries = []
    hop, width = sample_rate // 4, sample_rate // 2
    try:
        for start, samples in windows:
            if (type(start) is not int or not isinstance(samples, np.ndarray) or samples.ndim != 1
                    or not 4 * sample_rate <= samples.size <= 8 * sample_rate):
                return incomplete("unsupported_query")
            feature = _features(samples, deadline, hop, width, check_cancelled)
            picks = np.linspace(0, len(feature) - 1, 8, dtype=int)
            queries.append((picks, feature[picks], samples.size))

        per_query: list[dict[str, list[_Hit]]] = [defaultdict(list) for _ in queries]
        identities: dict[Path, str] = {}
        camera_by_identity: dict[str | Path, str] = {}
        for row in rows:
            check_cancelled()
            if monotonic() >= deadline:
                return incomplete("budget_incomplete")
            try:
                path = Path(row["cache_path"]).resolve(strict=True)
                camera, media_id = row["camera"], row["media_id"]
                origin = row["timeline_start_samples"]
                stat = path.stat()
            except (KeyError, OSError, TypeError, ValueError):
                return incomplete("reference_cache_unavailable")
            if (not isinstance(camera, str) or not camera.strip() or not isinstance(media_id, str)
                    or not media_id or type(origin) is not int or not path.is_file()
                    or stat.st_size < 4 or stat.st_size % 4):
                return incomplete("invalid_reference_row")
            canonical = camera.strip().casefold()
            if any(camera_by_identity.setdefault(key, canonical) != canonical for key in (media_id, path)):
                return incomplete("conflicting_reference_identity")
            count = max(0, (stat.st_size // 4 - _SIZE) // _HOP + 1)
            if stats["fingerprints"] + count > _MAX_FINGERPRINTS:
                return incomplete("budget_incomplete")
            stats["files"] += 1
            stats["fingerprints"] += count
            features, reused = _cached_features(path, stat, Path(cache_root), deadline, check_cancelled)
            stats["cache_hits"] += int(reused)
            key = _identity(path, stat)
            identities[path] = key
            for per_camera, (picks, query, window_samples) in zip(per_query, queries):
                check_cancelled()
                if monotonic() >= deadline:
                    return incomplete("budget_incomplete")
                length = len(features) - int(picks[-1])
                if length < 1:
                    continue
                score = np.zeros(length, dtype=np.float32)
                for delta, target in zip(picks, query):
                    score += np.einsum("ij,j->i", features[delta:delta + length], target)
                hits = per_camera[camera.strip().casefold()]
                for _ in range(2):
                    best = int(np.argmax(score))
                    value = float(score[best]) / len(picks)
                    if value <= 0:
                        break
                    hits.append(_Hit(value, camera, path, key, origin, best * _HOP, window_samples))
                    score[max(0, best - 8):best + 9] = -np.inf
                hits.sort(key=lambda hit: (-hit.score, str(hit.path), hit.cache_index))
                del hits[2:]

        chosen: dict[tuple[Path, int, str, int, int], _Hit] = {}
        for cameras in per_query:
            ranked = sorted((hits for hits in cameras.values() if hits), key=lambda hits: -hits[0].score)
            for hits in ranked[:3]:
                for hit in hits:
                    start = max(0, hit.cache_index - 8 * _CACHE_RATE)
                    end = hit.cache_index + (hit.window_samples * _CACHE_RATE // sample_rate) + 8 * _CACHE_RATE
                    chosen[(hit.path, hit.origin, hit.camera, start, end)] = hit
        if len(chosen) > _MAX_CANDIDATES:
            return incomplete("budget_incomplete")

        for path, identity in identities.items():
            check_cancelled()
            if monotonic() >= deadline:
                return incomplete("budget_incomplete")
            if _identity(path, path.stat()) != identity:
                return incomplete("reference_cache_changed")

        refs = []
        stride = _CACHE_RATE // sample_rate
        for (path, origin, camera, start, end), hit in chosen.items():
            check_cancelled()
            if monotonic() >= deadline:
                return incomplete("budget_incomplete")
            if _identity(path, path.stat()) != hit.identity:
                return incomplete("reference_cache_changed")
            source = np.memmap(path, mode="r", dtype="<f4")
            excerpt = normalize_waveform_samples(np.array(source[start:end:stride], copy=True))
            del source
            refs.append(WaveformReference(camera.strip(), origin + start // stride, excerpt))
        stats["candidates"] = len(refs)
        return ReferenceCandidates(refs, True, "", stats)
    except TimeoutError:
        return incomplete("budget_incomplete")
    except (OSError, ValueError):
        return incomplete("reference_cache_unavailable")
