from __future__ import annotations

import hashlib
import json
from collections import Counter
from typing import Any

from .coverage_graph import build_coverage_graph
from .delivery_semantics import resolve_delivery_state
from .editorial_store import EditorialStore
from .review_store import ReviewStore


ROUGH_CUT_CONTRACT = "rough_cut_plan.v1"


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _source_revision(coverage_revision: str, review: dict[str, Any], editorial: dict[str, Any]) -> str:
    raw = {
        "coverage": coverage_revision,
        "review": _int(review.get("revision"), 0),
        "editorial": _int(editorial.get("revision"), 0),
    }
    return hashlib.sha1(
        json.dumps(raw, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:20]


def _segment_index(script: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(item.get("segment_id", "")): item
        for item in _as_list(script.get("segments"))
        if isinstance(item, dict) and item.get("segment_id")
    }


def _group_index(index: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        str(item.get("group_id", "")): item
        for item in _as_list(index.get("groups"))
        if isinstance(item, dict) and item.get("group_id")
    }


def _safe_segment(segment: dict[str, Any]) -> dict[str, Any]:
    return {
        "segment_id": str(segment.get("segment_id", "") or ""),
        "order": _int(segment.get("order"), 0),
        "type": str(segment.get("type", "") or ""),
        "speaker": str(segment.get("speaker", "") or "")[:120],
        "text": str(segment.get("text", "") or segment.get("raw_text", "") or "")[:500],
    }


def _safe_angle(group_id: str, angle: dict[str, Any]) -> dict[str, Any]:
    return {
        "group_id": group_id,
        "clip_id": str(angle.get("clip_id", "") or ""),
        "camera": str(angle.get("camera", "") or ""),
        "name": str(angle.get("name", "") or "")[:300],
        "shot_type": str(angle.get("shot_type", "unknown") or "unknown"),
        "coverage_role": str(angle.get("coverage_role", "unknown") or "unknown"),
    }


def _role_pools(candidates: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    pools: dict[str, list[dict[str, Any]]] = {}
    for candidate in candidates:
        if candidate.get("delivery_state") == "reject":
            continue
        group_id = str(candidate.get("group_id", "") or "")
        for raw_angle in _as_list(candidate.get("angles")):
            if not isinstance(raw_angle, dict):
                continue
            role = str(raw_angle.get("coverage_role", "unknown") or "unknown")
            if role == "unknown":
                continue
            pools.setdefault(role, []).append(_safe_angle(group_id, raw_angle))
    for rows in pools.values():
        rows.sort(key=lambda item: (item["group_id"], item["camera"], item["clip_id"]))
    return dict(sorted(pools.items()))


def _segment_plan(
    segment: dict[str, Any],
    coverage_groups: list[dict[str, Any]],
    groups_by_id: dict[str, dict[str, Any]],
    review: dict[str, Any],
    editorial: dict[str, Any],
) -> dict[str, Any]:
    segment_id = str(segment.get("segment_id", "") or "")
    candidates: list[dict[str, Any]] = []
    for coverage_group in coverage_groups:
        if segment_id not in _as_list(coverage_group.get("script_segment_ids")):
            continue
        group_id = str(coverage_group.get("group_id", "") or "")
        group = _as_dict(groups_by_id.get(group_id))
        if not group:
            continue
        # Coverage only contains human or completed automatic mappings. The
        # historical delivery fallback for a mapped group is therefore Keep,
        # exactly as selection_manifest v3 treats manual/confirmed mapping.
        resolved = resolve_delivery_state(
            review=review,
            editorial=editorial,
            segment_id=segment_id,
            group=group,
            automatic_state="keep",
        )
        candidates.append(
            {
                "group_id": group_id,
                "delivery_state": str(resolved.get("state", "unreviewed") or "unreviewed"),
                "decision_source": str(resolved.get("decision_source", "unreviewed") or "unreviewed"),
                "creative_authority": str(resolved.get("decision_source", "")) != "automatic_mapping_fallback",
                "angles": [dict(item) for item in _as_list(coverage_group.get("angles")) if isinstance(item, dict)],
                "continuity_risk": str(_as_dict(coverage_group.get("rough_cut")).get("continuity_risk", "unknown") or "unknown"),
                "audit_mapping_current": bool(_as_dict(coverage_group.get("audit")).get("mapping_current", False)),
            }
        )

    candidates.sort(
        key=lambda item: (
            {"best": 0, "keep": 1, "unreviewed": 2, "reject": 3}.get(item["delivery_state"], 2),
            item["group_id"],
        )
    )
    best = [item for item in candidates if item["delivery_state"] == "best"]
    eligible = [item for item in candidates if item["delivery_state"] != "reject"]
    explicit_human = [item for item in eligible if item["creative_authority"]]
    issues: list[dict[str, Any]] = []

    if len(best) == 1:
        selection_status = "explicit_best"
        primary_group_id = best[0]["group_id"]
    elif len(best) > 1:
        selection_status = "conflict_multiple_best"
        primary_group_id = ""
        issues.append(
            {
                "code": "multiple_explicit_best",
                "severity": "warning",
                "label": "同一剧本段存在多个显式 Best，需要人工消解",
            }
        )
    elif not eligible:
        selection_status = "no_eligible_take"
        primary_group_id = ""
        issues.append(
            {
                "code": "no_eligible_take",
                "severity": "warning",
                "label": "当前剧本段没有可进入粗剪规划的 Take",
            }
        )
    else:
        selection_status = "needs_editorial_choice"
        primary_group_id = ""
        issues.append(
            {
                "code": "no_explicit_best",
                "severity": "info",
                "label": "已有可用 Take，但尚无显式 Best；规划不会替编辑选择",
            }
        )

    high_continuity = [item["group_id"] for item in eligible if item["continuity_risk"] == "high"]
    if high_continuity:
        issues.append(
            {
                "code": "continuity_attention",
                "severity": "warning",
                "label": f"{len(high_continuity)} 个可用 Take 有高连续性风险证据",
                "group_ids": high_continuity,
            }
        )

    return {
        "script": _safe_segment(segment),
        "selection_status": selection_status,
        "primary_group_id": primary_group_id,
        "candidates": candidates,
        "role_pools": _role_pools(candidates),
        "summary": {
            "candidates": len(candidates),
            "eligible": len(eligible),
            "explicit_best": len(best),
            "human_authority_candidates": len(explicit_human),
            "automatic_mapping_candidates": sum(
                1 for item in eligible if item["decision_source"] == "automatic_mapping_fallback"
            ),
        },
        "issues": issues,
    }


def build_rough_cut_plan(
    project: Any,
    *,
    scene_id: str | None = None,
    episode: int | None = None,
) -> dict[str, Any]:
    """Build a read-only assembly plan without choosing creative Bests.

    The plan consumes coverage.v1 and the existing delivery.v1 resolver. It does
    not write a timeline, selection manifest, FCPXML or human decision state.
    """

    project.reload_if_changed()
    coverage = build_coverage_graph(project, scene_id=scene_id, episode=episode)
    script = _as_dict(project.script)
    index = _as_dict(project.index)
    segments = _segment_index(script)
    groups_by_id = _group_index(index)
    review = ReviewStore(project.config.output_dir / "review.json").load()
    editorial = EditorialStore(project.config.output_dir).load()

    scene_rows: list[dict[str, Any]] = []
    status_counts: Counter[str] = Counter()
    high_continuity = 0

    for scene in _as_list(coverage.get("scenes")):
        if not isinstance(scene, dict):
            continue
        coverage_groups = [item for item in _as_list(scene.get("take_groups")) if isinstance(item, dict)]
        segment_plans: list[dict[str, Any]] = []
        for segment_id in _as_list(scene.get("script_segment_ids")):
            segment = _as_dict(segments.get(str(segment_id)))
            if not segment or str(segment.get("type", "") or "") == "scene_heading":
                continue
            planned = _segment_plan(segment, coverage_groups, groups_by_id, review, editorial)
            segment_plans.append(planned)
            status_counts[planned["selection_status"]] += 1
            if any(issue.get("code") == "continuity_attention" for issue in planned["issues"]):
                high_continuity += 1

        conflicts = sum(1 for row in segment_plans if row["selection_status"] == "conflict_multiple_best")
        no_eligible = sum(1 for row in segment_plans if row["selection_status"] == "no_eligible_take")
        needs_choice = sum(1 for row in segment_plans if row["selection_status"] == "needs_editorial_choice")
        if conflicts or no_eligible:
            readiness = "blocked"
        elif needs_choice or any(
            any(issue.get("code") == "continuity_attention" for issue in row["issues"])
            for row in segment_plans
        ):
            readiness = "needs_review"
        else:
            readiness = "ready"
        scene_rows.append(
            {
                "scene_id": str(scene.get("scene_id", "") or ""),
                "episode": _int(scene.get("episode"), 0),
                "heading": str(scene.get("heading", "") or ""),
                "readiness": readiness,
                "summary": {
                    "segments": len(segment_plans),
                    "explicit_best": sum(1 for row in segment_plans if row["selection_status"] == "explicit_best"),
                    "needs_choice": needs_choice,
                    "conflicts": conflicts,
                    "no_eligible": no_eligible,
                },
                "segments": segment_plans,
            }
        )

    if status_counts.get("conflict_multiple_best", 0) or status_counts.get("no_eligible_take", 0):
        readiness = "blocked"
    elif status_counts.get("needs_editorial_choice", 0) or high_continuity:
        readiness = "needs_review"
    else:
        readiness = "ready"

    return {
        "contract": ROUGH_CUT_CONTRACT,
        "revision": _source_revision(str(coverage.get("revision", "") or ""), review, editorial),
        "project_id": str(getattr(project, "project_id", "") or ""),
        "coverage_revision": str(coverage.get("revision", "") or ""),
        "filters": dict(_as_dict(coverage.get("filters"))),
        "readiness": readiness,
        "summary": {
            "scenes": len(scene_rows),
            "segments": sum(len(scene["segments"]) for scene in scene_rows),
            "selection_status": dict(sorted(status_counts.items())),
            "high_continuity_segments": high_continuity,
        },
        "scenes": scene_rows,
        "semantics": {
            "consumes_coverage_v1": True,
            "consumes_delivery_v1": True,
            "individual_opinions_used": False,
            "automatic_mapping_is_creative_best": False,
            "keep_promoted_to_best": False,
            "writes_review": False,
            "writes_editorial": False,
            "writes_selection_manifest": False,
            "writes_fcpxml": False,
        },
    }
