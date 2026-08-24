from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import ProjectConfig
from .generation import prepare_generated_tracks, resolve_generation_provider
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


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _cue_dir_name(cue_id: str) -> str:
    value = re.sub(r"[^A-Za-z0-9._-]+", "_", str(cue_id)).strip("._")
    return value[:96] or "cue"


def _semantic_rerank(
    retriever: SemanticRetriever,
    brief,
    candidates,
    assets,
    library_root,
    *,
    top_k: int,
    force_semantic: bool,
):
    if not retriever.available or not candidates:
        return candidates[:top_k], False
    candidate_ids = {item.asset_id for item in candidates}
    semantic_assets = [item for item in assets if item.asset_id in candidate_ids]
    semantic_windows = retriever.rank(
        brief,
        semantic_assets,
        library_root,
        top_k_per_asset=3,
        force=force_semantic,
    )
    if not semantic_windows:
        return candidates[:top_k], False
    return (
        rerank_candidates(
            candidates,
            semantic_windows,
            top_k=top_k,
            semantic_weight=0.30,
        ),
        True,
    )


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
    generation_mode: str = "off",
    generation_threshold: float = 0.64,
    generation_count: int = 2,
    generated_rights_confirmed: bool = False,
    acestep_url: str = "",
    stable_audio_bin: str = "",
) -> dict[str, Any]:
    config.ensure_output()
    output_dir = config.output_dir / "music"
    library_root_path = Path(library_root).expanduser().resolve()
    library = index_music_library(
        library_root_path,
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
        candidates, used_semantic = _semantic_rerank(
            retriever,
            brief,
            candidates,
            eligible_assets,
            library_root_path,
            top_k=requested_top_k,
            force_semantic=force_semantic,
        )
        if used_semantic:
            semantic_cues += 1
        candidates_by_cue[brief.cue_id] = candidates

    provider = resolve_generation_provider(
        generation_mode,
        acestep_url=acestep_url,
        stable_audio_bin=stable_audio_bin,
    )
    generated_alternatives: dict[str, list] = {}
    generation_rows: list[dict[str, Any]] = []
    generation_errors: list[dict[str, str]] = []
    generated_assets_all = []
    threshold = max(0.0, min(1.0, float(generation_threshold)))
    count = max(1, min(4, int(generation_count)))

    if provider is not None:
        for brief in briefs:
            existing = candidates_by_cue.get(brief.cue_id, [])
            best_score = float(existing[0].score) if existing else 0.0
            if existing and best_score >= threshold:
                continue

            cue_dir_name = _cue_dir_name(brief.cue_id)
            cue_dir = output_dir / "generated" / cue_dir_name
            shutil.rmtree(cue_dir, ignore_errors=True)
            try:
                tracks = provider.generate(brief, cue_dir, count=count)
                generation_rows.extend(
                    prepare_generated_tracks(
                        tracks,
                        brief,
                        rights_confirmed=generated_rights_confirmed,
                    )
                )
                generated_library = index_music_library(
                    cue_dir,
                    analysis_mode=analysis_mode,
                    force_analysis=force_analysis,
                )
                cue_assets = assets_from_index(generated_library)
                cue_candidates = rank_candidates(
                    brief,
                    cue_assets,
                    top_k=max(requested_top_k, count),
                    # Always score generated alternatives for comparison. They
                    # only enter the selection pool when rights are confirmed.
                    allow_unverified=True,
                )
                cue_candidates, generated_used_semantic = _semantic_rerank(
                    retriever,
                    brief,
                    cue_candidates,
                    cue_assets,
                    cue_dir,
                    top_k=requested_top_k,
                    force_semantic=force_semantic,
                )
                if generated_used_semantic:
                    semantic_cues += 1

                if not generated_rights_confirmed:
                    cue_candidates = [
                        replace(
                            item,
                            eligible=False,
                            rejection_reason="generated_rights_unconfirmed",
                        )
                        for item in cue_candidates
                    ]
                generated_alternatives[brief.cue_id] = cue_candidates

                if generated_rights_confirmed:
                    adjusted_assets = [
                        replace(item, path=f"generated/{cue_dir_name}/{item.path}")
                        for item in cue_assets
                    ]
                    generated_assets_all.extend(adjusted_assets)
                    merged = [*existing, *cue_candidates]
                    merged.sort(key=lambda item: (-item.score, item.asset_id, item.source_start))
                    candidates_by_cue[brief.cue_id] = merged[:requested_top_k]
            except Exception as exc:
                generation_errors.append(
                    {
                        "cue_id": brief.cue_id,
                        "provider": getattr(provider, "name", "unknown"),
                        "error": str(exc)[:1200],
                    }
                )

    if generated_assets_all:
        assets.extend(generated_assets_all)

    selected = choose_global_path(briefs, candidates_by_cue, assets)
    assets_by_id = {item.asset_id: item for item in assets}

    cues = []
    generated_selected = 0
    for brief, chosen in zip(briefs, selected):
        generated_rows = generated_alternatives.get(brief.cue_id, [])
        row: dict[str, Any] = {
            **brief.to_dict(),
            "status": "selected" if chosen is not None else "needs_music",
            "selected": chosen.to_dict() if chosen is not None else None,
            "candidates": [item.to_dict() for item in candidates_by_cue.get(brief.cue_id, [])],
            "generated_alternatives": [item.to_dict() for item in generated_rows],
        }
        if generated_rows:
            row["generation"] = {
                "provider": getattr(provider, "name", "off") if provider is not None else "off",
                "rights_confirmed": bool(generated_rights_confirmed),
                "eligible_for_selection": bool(generated_rights_confirmed),
            }
        if chosen is not None and chosen.asset_id in assets_by_id:
            asset = assets_by_id[chosen.asset_id]
            is_generated = asset.path.startswith("generated/")
            generated_selected += int(is_generated)
            row["asset"] = {
                "asset_id": asset.asset_id,
                "path": asset.path,
                "title": asset.title,
                "bpm": asset.bpm,
                "analysis_source": asset.analysis_source,
                "generated": is_generated,
                "license": asset.license.to_dict(),
            }
        cues.append(row)

    library_summary = library.get("summary", {}) if isinstance(library.get("summary"), dict) else {}
    provider_name = getattr(provider, "name", "off") if provider is not None else ("unavailable" if generation_mode != "off" else "off")
    plan = {
        "version": 4,
        "contract": "auto-score.v1",
        "feature_level": "v0.4",
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
            "generation_mode": generation_mode,
            "generation_provider": provider_name,
            "generation_threshold": threshold,
            "generated_rights_confirmed": bool(generated_rights_confirmed),
            "selection": "library-first+generated-fallback+hybrid-semantic+beat-grounding+global-continuity-v0.4",
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
            "generation_provider": provider_name,
            "generation_cues": len(generated_alternatives),
            "generated_tracks": len(generation_rows),
            "generation_failures": len(generation_errors),
            "generated_selected": generated_selected,
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
        "generation": {
            "provider": provider_name,
            "errors": generation_errors,
            "provenance_path": "output/music/provenance.jsonl",
        },
        "cues": cues,
    }
    _write_json(output_dir / "library_index.json", library)
    _write_jsonl(output_dir / "provenance.jsonl", generation_rows)
    _write_json(output_dir / "music_plan.json", plan)
    return plan
