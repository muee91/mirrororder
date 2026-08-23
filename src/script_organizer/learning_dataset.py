from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .automation_store import AutomationStore
from .config import ProjectConfig
from .review_store import ReviewStore


LEARNING_CONTRACT = "learning.v1"


def _read(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _manual_ids(review: dict[str, Any], group: dict[str, Any]) -> list[str]:
    group_id = str(group.get("group_id", "") or "")
    parent = str(group.get("parent_group_id", "") or "")
    placements = _as_dict(review.get("placements"))
    placement = _as_dict(placements.get(group_id)) or (_as_dict(placements.get(parent)) if parent else {})
    ids = [str(value) for value in _as_list(placement.get("script_segment_ids")) if str(value)]
    for segment_id, rows in _as_dict(review.get("assignments")).items():
        row = _as_dict(rows)
        if group_id in row or (parent and parent in row):
            ids.append(str(segment_id))
    return list(dict.fromkeys(ids))


def write_learning_dataset(config: ProjectConfig, audit: dict[str, Any]) -> dict[str, Any]:
    """Write replay-ready hard cases without media paths or model authority.

    Human overrides and audit disagreements are especially valuable. The file
    is an R&D dataset only; production matching never reads it.
    """

    index = _read(config.output_dir / "material_index.json")
    matches = _read(config.output_dir / "matches.json")
    review = ReviewStore(config.output_dir / "review.json").load()
    automation = AutomationStore(config.output_dir).load()
    groups = {
        str(item.get("group_id")): item
        for item in _as_list(index.get("groups"))
        if isinstance(item, dict) and item.get("group_id")
    }
    match_groups = _as_dict(matches.get("groups"))
    automation_groups = _as_dict(automation.get("groups"))
    audit_groups = _as_dict(audit.get("groups"))
    analysis_revision = str(audit.get("analysis_revision", "") or "")
    cases = []

    for group_id, group in groups.items():
        automatic = _as_dict(automation_groups.get(group_id))
        manual_ids = _manual_ids(review, group)
        automatic_ids = [str(value) for value in _as_list(automatic.get("script_segment_ids")) if str(value)]
        audit_row = _as_dict(audit_groups.get(group_id))
        judge = _as_dict(audit_row.get("judge"))
        issue_codes = [
            str(item.get("code", ""))
            for item in _as_list(audit_row.get("issues"))
            if isinstance(item, dict) and item.get("code")
        ]
        failure = _as_dict(audit_row.get("algorithm_feedback"))
        status = str(automatic.get("status", "") or "")
        human_override = bool(manual_ids)
        mapping_conflict = bool(manual_ids and automatic_ids and set(manual_ids) != set(automatic_ids))
        disagreement = str(judge.get("verdict", "")) == "disagree"
        hard_status = status in {"needs_review", "unresolved"}
        if not (human_override or mapping_conflict or disagreement or hard_status):
            continue

        candidates = []
        row = _as_dict(match_groups.get(group_id))
        for candidate in _as_list(row.get("candidates"))[:3]:
            if not isinstance(candidate, dict):
                continue
            ids = candidate.get("script_segment_ids") or (
                [candidate.get("script_segment_id")] if candidate.get("script_segment_id") else []
            )
            candidates.append(
                {
                    "candidate_id": str(candidate.get("candidate_id", "") or ""),
                    "script_segment_ids": [str(value) for value in ids if str(value)],
                    "confidence": str(candidate.get("confidence", "") or ""),
                    "total_score": float(candidate.get("total_score", 0) or 0),
                    "dialogue_score": float(candidate.get("dialogue_score", 0) or 0),
                    "sequence_score": float(candidate.get("sequence_score", 0) or 0),
                    "margin": float(candidate.get("margin", 0) or 0),
                    "transcript_text": str(candidate.get("transcript_text", "") or "")[:1000],
                }
            )
        cases.append(
            {
                "contract": LEARNING_CONTRACT,
                "analysis_revision": analysis_revision,
                "group_id": group_id,
                "kind": str(group.get("kind", "") or ""),
                "cameras": [str(value) for value in _as_list(group.get("cameras")) if str(value)],
                "automatic": {
                    "status": status,
                    "mapping_source": str(automatic.get("mapping_source", "") or ""),
                    "script_segment_ids": automatic_ids,
                    "confidence": float(automatic.get("confidence", 0) or 0),
                },
                "human_expected": {
                    "script_segment_ids": manual_ids,
                },
                "audit": {
                    "verdict": str(judge.get("verdict", "") or "not_run"),
                    "confidence": float(judge.get("confidence", 0) or 0),
                    "issue_codes": list(dict.fromkeys(issue_codes)),
                    "failure_class": str(failure.get("failure_class", "") or ""),
                    "suspected_missing_feature": str(failure.get("suspected_missing_feature", "") or ""),
                },
                "candidates": candidates,
            }
        )

    cases.sort(key=lambda item: str(item.get("group_id", "")))
    target = config.output_dir / "learning_cases.jsonl"
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for item in cases:
                handle.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {"cases": len(cases), "path": str(target)}
