from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .models import MusicAsset, MusicBrief


@dataclass(frozen=True)
class SemanticWindow:
    asset_id: str
    start: float
    end: float
    score: float
    backend: str


def _cache_root() -> Path:
    override = os.environ.get("MIRRORORDER_MUSIC_SEMANTIC_CACHE", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / "Library" / "Application Support" / "MirrorOrder" / "music-semantic-v1"


def _cosine(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    ln = math.sqrt(sum(a * a for a in left))
    rn = math.sqrt(sum(b * b for b in right))
    if ln <= 1e-12 or rn <= 1e-12:
        return 0.0
    return max(-1.0, min(1.0, dot / (ln * rn)))


def _query_text(brief: MusicBrief) -> str:
    tags = ", ".join(brief.tags)
    return (
        f"Instrumental cinematic underscore. Purpose: {brief.purpose}. "
        f"Mood and dramatic tags: {tags}. Target energy {brief.target_energy:.2f}. "
        f"Dialogue density {brief.dialogue_density:.2f}. Scene context: {brief.text}"
    )


def _window_ranges(asset: MusicAsset, *, window_seconds: float = 20.0, hop_seconds: float = 8.0) -> list[tuple[float, float]]:
    duration = max(0.0, float(asset.duration))
    if duration <= 0:
        return []
    window = max(6.0, min(window_seconds, duration))
    hop = max(2.0, min(hop_seconds, window))
    starts = []
    current = 0.0
    while current + 1.0 < duration:
        starts.append(current)
        if current + window >= duration:
            break
        current += hop
    final = max(0.0, duration - window)
    if not starts or abs(starts[-1] - final) > 0.5:
        starts.append(final)
    return [(round(start, 3), round(min(duration, start + window), 3)) for start in starts]


def _decode_window(path: Path, start: float, end: float, sample_rate: int = 48000):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg unavailable")
    duration = max(0.1, end - start)
    result = subprocess.run(
        [ffmpeg, "-v", "error", "-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", str(path),
         "-vn", "-ac", "1", "-ar", str(sample_rate), "-f", "f32le", "pipe:1"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=90,
        check=False,
    )
    if result.returncode != 0 or not result.stdout:
        raise RuntimeError((result.stderr or b"ffmpeg decode failed").decode("utf-8", errors="ignore")[:400])
    import numpy as np
    return np.frombuffer(result.stdout, dtype="<f4"), sample_rate


class ClapSemanticBackend:
    name = "clap"
    model_id = "laion/clap-htsat-fused"

    def __init__(self) -> None:
        try:
            import torch
            from transformers import AutoProcessor, ClapModel
        except Exception as exc:  # optional dependency
            raise RuntimeError("CLAP optional dependencies are unavailable") from exc
        self.torch = torch
        self.processor = AutoProcessor.from_pretrained(self.model_id)
        self.model = ClapModel.from_pretrained(self.model_id)
        if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            self.device = torch.device("mps")
        elif torch.cuda.is_available():
            self.device = torch.device("cuda")
        else:
            self.device = torch.device("cpu")
        self.model.to(self.device)
        self.model.eval()

    def text_embedding(self, text: str) -> list[float]:
        batch = self.processor(text=[text], return_tensors="pt", padding=True)
        batch = {key: value.to(self.device) for key, value in batch.items()}
        with self.torch.inference_mode():
            vector = self.model.get_text_features(**batch)[0].float().cpu().tolist()
        return vector

    def audio_embedding(self, signal, sample_rate: int) -> list[float]:
        batch = self.processor(audios=[signal], sampling_rate=sample_rate, return_tensors="pt")
        batch = {key: value.to(self.device) for key, value in batch.items()}
        with self.torch.inference_mode():
            vector = self.model.get_audio_features(**batch)[0].float().cpu().tolist()
        return vector


def semantic_backend(mode: str):
    normalized = str(mode or "auto").strip().casefold()
    if normalized == "off":
        return None
    if normalized not in {"auto", "clap"}:
        raise ValueError(f"不支持的 semantic backend：{mode}")
    try:
        return ClapSemanticBackend()
    except Exception:
        if normalized == "clap":
            raise
        return None


def _asset_cache_key(asset: MusicAsset, backend_name: str) -> str:
    payload = f"{backend_name}|{asset.asset_id}|{asset.duration:.3f}|20|8"
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def _load_cached_vectors(path: Path) -> list[dict[str, Any]] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        rows = payload.get("windows", [])
        return rows if isinstance(rows, list) else None
    except (OSError, ValueError):
        return None


def _write_cache(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def rank_semantic_windows(
    brief: MusicBrief,
    assets: list[MusicAsset],
    library_root: str | Path,
    *,
    mode: str = "auto",
    top_k_per_asset: int = 3,
    force: bool = False,
) -> tuple[dict[str, list[SemanticWindow]], str]:
    backend = semantic_backend(mode)
    if backend is None:
        return {}, "off"
    root = Path(library_root).expanduser().resolve()
    query = backend.text_embedding(_query_text(brief))
    output: dict[str, list[SemanticWindow]] = {}
    for asset in assets:
        source = root / asset.path
        if not source.is_file() or asset.duration <= 0:
            continue
        cache = _cache_root() / backend.name / f"{_asset_cache_key(asset, backend.name)}.json"
        rows = None if force else _load_cached_vectors(cache)
        if rows is None:
            rows = []
            for start, end in _window_ranges(asset):
                try:
                    signal, sr = _decode_window(source, start, end)
                    vector = backend.audio_embedding(signal, sr)
                except Exception:
                    continue
                rows.append({"start": start, "end": end, "vector": vector})
            _write_cache(cache, {"version": 1, "backend": backend.name, "asset_id": asset.asset_id, "windows": rows})
        scored = []
        for row in rows:
            vector = row.get("vector", [])
            if not isinstance(vector, list):
                continue
            similarity = (_cosine(query, [float(value) for value in vector]) + 1.0) / 2.0
            scored.append(SemanticWindow(asset.asset_id, float(row.get("start", 0)), float(row.get("end", 0)), similarity, backend.name))
        scored.sort(key=lambda item: (-item.score, item.start))
        if scored:
            output[asset.asset_id] = scored[:max(1, top_k_per_asset)]
    return output, backend.name
