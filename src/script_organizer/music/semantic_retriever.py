from __future__ import annotations

from pathlib import Path

from .models import MusicAsset, MusicBrief
from .semantic import (
    SemanticWindow,
    _asset_cache_key,
    _cache_root,
    _cosine,
    _decode_window,
    _load_cached_vectors,
    _query_text,
    _window_ranges,
    _write_cache,
    semantic_backend,
)


class SemanticRetriever:
    def __init__(self, mode: str = "auto") -> None:
        self.backend = semantic_backend(mode)
        self.name = self.backend.name if self.backend is not None else "off"

    @property
    def available(self) -> bool:
        return self.backend is not None

    def rank(
        self,
        brief: MusicBrief,
        assets: list[MusicAsset],
        library_root: str | Path,
        *,
        top_k_per_asset: int = 3,
        force: bool = False,
    ) -> dict[str, list[SemanticWindow]]:
        if self.backend is None:
            return {}
        root = Path(library_root).expanduser().resolve()
        query = self.backend.text_embedding(_query_text(brief))
        output: dict[str, list[SemanticWindow]] = {}
        for asset in assets:
            source = root / asset.path
            if not source.is_file() or asset.duration <= 0:
                continue
            cache = _cache_root() / self.backend.name / f"{_asset_cache_key(asset, self.backend.name)}.json"
            rows = None if force else _load_cached_vectors(cache)
            if rows is None:
                rows = []
                for start, end in _window_ranges(asset):
                    try:
                        signal, sr = _decode_window(source, start, end)
                        vector = self.backend.audio_embedding(signal, sr)
                    except Exception:
                        continue
                    rows.append({"start": start, "end": end, "vector": vector})
                _write_cache(cache, {"version": 1, "backend": self.backend.name, "asset_id": asset.asset_id, "windows": rows})
            scored: list[SemanticWindow] = []
            for row in rows:
                vector = row.get("vector", [])
                if not isinstance(vector, list):
                    continue
                similarity = (_cosine(query, [float(value) for value in vector]) + 1.0) / 2.0
                scored.append(
                    SemanticWindow(
                        asset.asset_id,
                        float(row.get("start", 0)),
                        float(row.get("end", 0)),
                        similarity,
                        self.backend.name,
                    )
                )
            scored.sort(key=lambda item: (-item.score, item.start))
            if scored:
                output[asset.asset_id] = scored[:max(1, top_k_per_asset)]
        return output
