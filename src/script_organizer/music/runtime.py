from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import ProjectConfig
from .library import assets_from_index, index_music_library
from .planner import build_music_briefs
from .scoring import choose_global_path, rank_candidates
from .semantic_rerank import rerank_candidates
from .semantic_retriever import SemanticRetriever


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
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


def build_music_plan(
    config: ProjectConfig,
    library_root: str | Path,
    *,
    episode: int | None = None,
    timeline_seconds: float | None = None,
    top_k: int = 5,
    allow_unverified: bool = False,
    analysis_mode: str = "auto",
    force_analysis: bool = False,
    semantic_mode: str = "auto",
    force_semantic: bool = False,
) -> dict[str, Any]:
    config.ensure_output()
    output_dir = config.output_dir / "music"
    library = index_music_library(
        library_root,
        analysis_mode=analysis_mode,
        force_analysis=force_analysis,
    )
    assets = assets_from_index(library)
    briefs = build_music_briefs(config, episode=episode, timeline_seconds=timeline_seconds)

    requested_top_k = max(1, min(20, int(top_k)))
    eligible_assets = [item for item in assets if item.license.eligible or allow_unverified]
    broad_pool = max(requested_top_k, min(40, len(eligible_assets)))
    retriever = SemanticRetriever(semantic_mode)
    semantic_backend_used = retriever.name
    semantic_cues = 0
    candidates_by_cue: dict[str, list] = {}

    for brief in briefs:
        candidates = rank_candidates(
            brief,
            assets,
            top_k=broad_pool,
            allow_unverified=allow_unverified,
        )
        if retriever.available and candidates:
            candidate_ids = {item.asset_id for item in candidates}
            semantic_assets = [item for item in eligible_assets if item.asset_id in candidate_ids]
            semantic_windows = retriever.rank(
                brief,
                semantic_assets,
                library_root,
                top_k_per_asset=3,
                force=force_semantic,
            )
            if semantic_windows:
                semantic_cues += 1
                candidates = rerank_candidates(
                    candidates,
                    semantic_windows,
                    top_k=requested_top_k,
                    semantic_weight=0.30,
                )
            else:
                candidates = candidates[:requested_top_k]
        else:
            candidates = candidates[:requested_top_k]
        candidates_by_cue[brief.cue_id] = candidates

    selected = choose_global_path(briefs, candidates_by_cue, assets)
    assets_by_id = {item.asset_id: item for item in assets}

    cues = []
    for brief, chosen in zip(briefs, selected):
        row: dict[str, Any] = {
            **brief.to_dict(),
            "status": "selected" if chosen is not None else "needs_music",
            "selected": chosen.to_dict() if chosen is not None else None,
            "candidates": [item.to_dict() for item in candidates_by_cue.get(brief.cue_id, [])],
        }
        if chosen is not None and chosen.asset_id in assets_by_id:
            asset = assets_by_id[chosen.asset_id]
            row["asset"] = {
                "asset_id": asset.asset_id,
                "path": asset.path,
                "title": asset.title,
                "bpm": asset.bpm,
                "analysis_source": asset.analysis_source,
                "license": asset.license.to_dict(),
            }
        cues.append(row)

    library_summary = library.get("summary", {}) if isinstance(library.get("summary"), dict) else {}
    plan = {
        "version": 3,
        "contract": "auto-score.v1",
        "feature_level": "v0.3",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "project": config.name,
        "episode": episode,
        "timeline_seconds": timeline_seconds,
        "policy": {
            "writes_review": False,
            "writes_editorial": False,
            "writes_auto_decisions": False,
            "license_gate": not allow_unverified,
            "allow_unverified": bool(allow_unverified),
            "analysis_mode": analysis_mode,
            "semantic_mode": semantic_mode,
            "semantic_backend": semantic_backend_used,
            "selection": "hybrid-local+semantic-window+beat-grounding+global-continuity-v0.3",
            "moment_grounding": "semantic-window retrieval + downbeat>beat>section-boundary",
            "timing": "proportional-script-estimate" if timeline_seconds else "script-estimate",
        },
        "summary": {
            "cues": len(cues),
            "selected": sum(1 for item in cues if item["status"] == "selected"),
            "needs_music": sum(1 for item in cues if item["status"] == "needs_music"),
            "library_tracks": int(library_summary.get("tracks", 0) or 0),
            "eligible_tracks": int(library_summary.get("eligible", 0) or 0),
            "analyzed_tracks": int(library_summary.get("analyzed", 0) or 0),
            "beat_tracked_tracks": int(library_summary.get("beat_tracked", 0) or 0),
            "semantic_cues": semantic_cues,
            "semantic_backend": semantic_backend_used,
            "beat_aligned_cues": sum(
                1 for item in cues if isinstance(item.get("selected"), dict) and item["selected"].get("beat_aligned") is True
            ),
        },
        "library": {
            "name": library.get("library_name", "music-library"),
            "contract": library.get("contract", ""),
            "analysis": library.get("analysis", {}),
            "warnings": library.get("warnings", []),
        },
        "cues": cues,
    }
    _write_json(output_dir / "library_index.json", library)
    _write_json(output_dir / "music_plan.json", plan)
    return plan
