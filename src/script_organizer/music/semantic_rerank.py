from __future__ import annotations

from dataclasses import replace

from .models import MusicCandidate
from .semantic import SemanticWindow


def _overlap(left_start: float, left_end: float, right_start: float, right_end: float) -> float:
    intersection = max(0.0, min(left_end, right_end) - max(left_start, right_start))
    union = max(left_end, right_end) - min(left_start, right_start)
    return intersection / union if union > 1e-9 else 0.0


def _window_score(candidate: MusicCandidate, windows: list[SemanticWindow]) -> tuple[float, SemanticWindow | None]:
    best_score = 0.0
    best = None
    for window in windows:
        coverage = _overlap(candidate.source_start, candidate.source_end, window.start, window.end)
        proximity = 1.0 / (1.0 + abs(candidate.source_start - window.start) / 8.0)
        combined = window.score * (0.72 + 0.20 * coverage + 0.08 * proximity)
        if combined > best_score:
            best_score = combined
            best = window
    return min(1.0, best_score), best


def rerank_candidates(
    candidates: list[MusicCandidate],
    semantic_windows: dict[str, list[SemanticWindow]],
    *,
    top_k: int,
    semantic_weight: float = 0.30,
) -> list[MusicCandidate]:
    weight = max(0.0, min(0.65, float(semantic_weight)))
    if not semantic_windows or weight <= 0:
        return candidates[:max(1, top_k)]
    rows: list[MusicCandidate] = []
    for candidate in candidates:
        score, window = _window_score(candidate, semantic_windows.get(candidate.asset_id, []))
        if window is None:
            rows.append(candidate)
            continue
        fused = candidate.score * (1.0 - weight) + score * weight
        scores = dict(candidate.scores)
        scores["embedding_semantic"] = score
        scores["semantic_window_start"] = window.start
        scores["semantic_window_end"] = window.end
        rows.append(replace(candidate, score=fused, scores=scores))
    rows.sort(key=lambda item: (-item.score, item.asset_id, item.source_start))
    return rows[:max(1, top_k)]
