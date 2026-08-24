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
) -> dict[str, Any]:
    config.ensure_output()
    output_dir = config.output_dir / "music"
    library = index_music_library(library_root)
    assets = assets_from_index(library)
    briefs = build_music_briefs(config, episode=episode, timeline_seconds=timeline_seconds)

    candidates_by_cue = {
        brief.cue_id: rank_candidates(
            brief,
            assets,
            top_k=max(1, min(20, int(top_k))),
            allow_unverified=allow_unverified,
        )
        for brief in briefs
    }
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
                "license": asset.license.to_dict(),
            }
        cues.append(row)

    plan = {
        "version": 1,
        "contract": "auto-score.v1",
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
            "selection": "local-score+global-continuity-v0",
            "timing": "proportional-script-estimate" if timeline_seconds else "script-estimate",
        },
        "summary": {
            "cues": len(cues),
            "selected": sum(1 for item in cues if item["status"] == "selected"),
            "needs_music": sum(1 for item in cues if item["status"] == "needs_music"),
            "library_tracks": library["summary"]["tracks"],
            "eligible_tracks": library["summary"]["eligible"],
        },
        "library": {
            "name": library.get("library_name", "music-library"),
            "contract": library.get("contract", ""),
        },
        "cues": cues,
    }
    _write_json(output_dir / "library_index.json", library)
    _write_json(output_dir / "music_plan.json", plan)
    return plan
