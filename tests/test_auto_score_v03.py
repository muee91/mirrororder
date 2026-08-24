from __future__ import annotations

from script_organizer.music.models import MusicCandidate
from script_organizer.music.semantic import SemanticWindow, semantic_backend
from script_organizer.music.semantic_rerank import rerank_candidates


def _candidate(asset_id: str, score: float, start: float = 8.0) -> MusicCandidate:
    return MusicCandidate(
        cue_id="cue-1",
        asset_id=asset_id,
        source_start=start,
        source_end=start + 12.0,
        score=score,
        scores={"semantic": score},
        eligible=True,
        boundary_source="downbeat->downbeat",
        beat_aligned=True,
    )


def test_semantic_rerank_can_promote_better_audio_window() -> None:
    lexical = [_candidate("A", 0.80), _candidate("B", 0.72)]
    windows = {
        "A": [SemanticWindow("A", 8.0, 28.0, 0.30, "test")],
        "B": [SemanticWindow("B", 8.0, 28.0, 0.98, "test")],
    }
    rows = rerank_candidates(lexical, windows, top_k=2, semantic_weight=0.45)
    assert rows[0].asset_id == "B"
    assert rows[0].scores["embedding_semantic"] > rows[1].scores["embedding_semantic"]
    assert rows[0].source_start == 8.0
    assert rows[0].boundary_source == "downbeat->downbeat"


def test_semantic_rerank_preserves_fallback_without_embeddings() -> None:
    lexical = [_candidate("A", 0.80), _candidate("B", 0.72)]
    rows = rerank_candidates(lexical, {}, top_k=1)
    assert [item.asset_id for item in rows] == ["A"]


def test_semantic_off_has_no_optional_dependency_requirement() -> None:
    assert semantic_backend("off") is None
