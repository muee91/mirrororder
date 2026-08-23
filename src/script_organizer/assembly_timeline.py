from __future__ import annotations

import hashlib
import json
from collections import Counter
from typing import Any

from .rough_cut_plan import build_rough_cut_plan


ASSEMBLY_CONTRACT = "assembly_timeline.v1"


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _revision(plan_revision: str) -> str:
    return hashlib.sha1(
        json.dumps({"rough_cut_plan": plan_revision}, sort_keys=True).encode("utf-8")
    ).hexdigest()[:20]


def _primary_candidate(segment: dict[str, Any]) -> dict[str, Any] | None:
    group_id = str(segment.get("primary_group_id", "") or "")
    if not group_id:
        return None
    return next(
        (
            item for item in _as_list(segment.get("candidates"))
            if isinstance(item, dict) and str(item.get("group_id", "") or "") == group_id
        ),
        None,
    )


def _angle_choice(candidate: dict[str, Any]) -> dict[str, Any]:
    angles = [item for item in _as_list(candidate.get("angles")) if isinstance(item, dict)]
    preferred = str(_as_dict(candidate.get("script_supervisor")).get("preferred_clip_id", "") or "")
    if preferred:
        match = next((item for item in angles if str(item.get("clip_id", "") or "") == preferred), None)
        if match:
            return {
                "status": "manual_preferred",
                "clip_id": preferred,
                "camera": str(match.get("camera", "") or ""),
                "shot_type": str(match.get("shot_type", "unknown") or "unknown"),
                "coverage_role": str(match.get("coverage_role", "unknown") or "unknown"),
                "candidates": [],
            }
    if len(angles) == 1:
        angle = angles[0]
        return {
            "status": "single_angle",
            "clip_id": str(angle.get("clip_id", "") or ""),
            "camera": str(angle.get("camera", "") or ""),
            "shot_type": str(angle.get("shot_type", "unknown") or "unknown"),
            "coverage_role": str(angle.get("coverage_role", "unknown") or "unknown"),
            "candidates": [],
        }
    return {
        "status": "pending" if angles else "missing",
        "clip_id": "",
        "camera": "",
        "shot_type": "unknown",
        "coverage_role": "unknown",
        "candidates": [
            {
                "clip_id": str(item.get("clip_id", "") or ""),
                "camera": str(item.get("camera", "") or ""),
                "shot_type": str(item.get("shot_type", "unknown") or "unknown"),
                "coverage_role": str(item.get("coverage_role", "unknown") or "unknown"),
            }
            for item in angles
        ],
    }


def _range_choice(candidate: dict[str, Any]) -> dict[str, Any]:
    duration = max(0.0, _float(candidate.get("duration"), 0.0))
    supervisor = _as_dict(candidate.get("script_supervisor"))
    manual = _as_dict(supervisor.get("usable_range"))
    status = str(supervisor.get("status", "unmarked") or "unmarked")
    issues: list[dict[str, Any]] = []
    if manual:
        start = max(0.0, _float(manual.get("start"), 0.0))
        end = _float(manual.get("end"), 0.0)
        if end <= start or (duration > 0 and end > duration + 0.001):
            issues.append(
                {
                    "code": "supervisor_range_out_of_bounds",
                    "severity": "warning",
                    "label": "场记可用范围超出当前逻辑 Take，需要重新核对",
                }
            )
            return {"status": "invalid", "start": start, "end": end, "duration": 0.0, "issues": issues}
        return {
            "status": "manual",
            "start": start,
            "end": end,
            "duration": max(0.0, end - start),
            "issues": issues,
        }
    if status == "partial":
        issues.append(
            {
                "code": "partial_range_pending",
                "severity": "info",
                "label": "场记标记为部分可用，建议补精确可用范围后再生成正式组接",
            }
        )
        return {
            "status": "pending",
            "start": 0.0,
            "end": duration,
            "duration": duration,
            "issues": issues,
        }
    return {
        "status": "full_take",
        "start": 0.0,
        "end": duration,
        "duration": duration,
        "issues": issues,
    }


def _segment_entry(segment: dict[str, Any]) -> dict[str, Any]:
    script = _as_dict(segment.get("script"))
    status = str(segment.get("selection_status", "needs_editorial_choice") or "needs_editorial_choice")
    candidate = _primary_candidate(segment) if status == "explicit_best" else None
    if candidate is None:
        return {
            "script_segment_id": str(script.get("segment_id", "") or ""),
            "order": script.get("order"),
            "speaker": str(script.get("speaker", "") or ""),
            "text": str(script.get("text", "") or ""),
            "selection_status": status,
            "group_id": "",
            "angle": {},
            "usable_range": {},
            "issues": list(_as_list(segment.get("issues"))),
        }
    angle = _angle_choice(candidate)
    usable_range = _range_choice(candidate)
    return {
        "script_segment_id": str(script.get("segment_id", "") or ""),
        "order": script.get("order"),
        "speaker": str(script.get("speaker", "") or ""),
        "text": str(script.get("text", "") or ""),
        "selection_status": status,
        "group_id": str(candidate.get("group_id", "") or ""),
        "angle": angle,
        "usable_range": usable_range,
        "script_supervisor": dict(_as_dict(candidate.get("script_supervisor"))),
        "continuity_risk": str(candidate.get("continuity_risk", "unknown") or "unknown"),
        "issues": [*list(_as_list(segment.get("issues"))), *list(_as_list(usable_range.get("issues")))],
    }


def _merge_scene_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge consecutive script segments using the same primary Take.

    A logical Take may cover several dialogue segments. Repeating its full source
    range once per script line would duplicate media, so assembly preview groups
    consecutive segments with the same primary group into one source block.
    """

    blocks: list[dict[str, Any]] = []
    for entry in entries:
        group_id = str(entry.get("group_id", "") or "")
        if not group_id:
            blocks.append(
                {
                    "kind": "unresolved",
                    "script_segment_ids": [str(entry.get("script_segment_id", "") or "")],
                    "selection_status": str(entry.get("selection_status", "") or ""),
                    "group_id": "",
                    "angle": {},
                    "usable_range": {},
                    "issues": list(_as_list(entry.get("issues"))),
                }
            )
            continue
        previous = blocks[-1] if blocks else None
        if (
            previous
            and previous.get("kind") == "source"
            and str(previous.get("group_id", "") or "") == group_id
            and _as_dict(previous.get("usable_range")) == _as_dict(entry.get("usable_range"))
            and _as_dict(previous.get("angle")) == _as_dict(entry.get("angle"))
        ):
            previous["script_segment_ids"].append(str(entry.get("script_segment_id", "") or ""))
            previous["issues"].extend(_as_list(entry.get("issues")))
            continue
        blocks.append(
            {
                "kind": "source",
                "script_segment_ids": [str(entry.get("script_segment_id", "") or "")],
                "selection_status": str(entry.get("selection_status", "") or ""),
                "group_id": group_id,
                "angle": dict(_as_dict(entry.get("angle"))),
                "usable_range": dict(_as_dict(entry.get("usable_range"))),
                "script_supervisor": dict(_as_dict(entry.get("script_supervisor"))),
                "continuity_risk": str(entry.get("continuity_risk", "unknown") or "unknown"),
                "issues": list(_as_list(entry.get("issues"))),
            }
        )
    return blocks


def build_assembly_timeline(
    project: Any,
    *,
    scene_id: str | None = None,
    episode: int | None = None,
) -> dict[str, Any]:
    """Build a read-only assembly preview from explicit Best decisions.

    The preview never writes FCPXML or Selection Manifest. It refuses to invent a
    creative Take selection and refuses to choose between multiple camera angles
    unless the script-supervisor board explicitly marks a preferred clip or the
    Take only has one angle.
    """

    plan = build_rough_cut_plan(project, scene_id=scene_id, episode=episode)
    scenes: list[dict[str, Any]] = []
    status_counts: Counter[str] = Counter()
    total_duration = 0.0

    for scene in _as_list(plan.get("scenes")):
        if not isinstance(scene, dict):
            continue
        entries = [_segment_entry(item) for item in _as_list(scene.get("segments")) if isinstance(item, dict)]
        blocks = _merge_scene_entries(entries)
        scene_duration = 0.0
        blockers = 0
        attention = 0
        cursor = 0.0
        for block in blocks:
            if block.get("kind") != "source":
                block["assembly_status"] = "selection_pending"
                block["timeline_start"] = cursor
                block["timeline_end"] = cursor
                attention += 1
                status_counts["selection_pending"] += 1
                continue
            usable_range = _as_dict(block.get("usable_range"))
            angle = _as_dict(block.get("angle"))
            duration = max(0.0, _float(usable_range.get("duration"), 0.0))
            range_status = str(usable_range.get("status", "full_take") or "full_take")
            angle_status = str(angle.get("status", "missing") or "missing")
            if range_status == "invalid":
                assembly_status = "blocked"
                blockers += 1
            elif angle_status in {"pending", "missing"} or range_status == "pending":
                assembly_status = "needs_review"
                attention += 1
            else:
                assembly_status = "ready"
            block["assembly_status"] = assembly_status
            block["timeline_start"] = cursor
            block["timeline_end"] = cursor + duration
            block["duration"] = duration
            cursor += duration
            scene_duration += duration
            status_counts[assembly_status] += 1

        if blockers:
            readiness = "blocked"
        elif attention:
            readiness = "needs_review"
        else:
            readiness = "ready"
        total_duration += scene_duration
        scenes.append(
            {
                "scene_id": str(scene.get("scene_id", "") or ""),
                "episode": scene.get("episode"),
                "heading": str(scene.get("heading", "") or ""),
                "readiness": readiness,
                "duration": round(scene_duration, 4),
                "summary": {
                    "blocks": len(blocks),
                    "source_blocks": sum(1 for block in blocks if block.get("kind") == "source"),
                    "unresolved_blocks": sum(1 for block in blocks if block.get("kind") != "source"),
                    "attention": attention,
                    "blocked": blockers,
                },
                "blocks": blocks,
            }
        )

    if status_counts.get("blocked", 0):
        readiness = "blocked"
    elif status_counts.get("selection_pending", 0) or status_counts.get("needs_review", 0):
        readiness = "needs_review"
    else:
        readiness = "ready"

    return {
        "contract": ASSEMBLY_CONTRACT,
        "revision": _revision(str(plan.get("revision", "") or "")),
        "rough_cut_plan_revision": str(plan.get("revision", "") or ""),
        "coverage_revision": str(plan.get("coverage_revision", "") or ""),
        "project_id": str(plan.get("project_id", "") or ""),
        "filters": dict(_as_dict(plan.get("filters"))),
        "readiness": readiness,
        "duration": round(total_duration, 4),
        "summary": {
            "scenes": len(scenes),
            "blocks": sum(len(scene["blocks"]) for scene in scenes),
            "statuses": dict(sorted(status_counts.items())),
        },
        "scenes": scenes,
        "semantics": {
            "preview_only": True,
            "explicit_best_required": True,
            "automatic_mapping_selects_take": False,
            "keep_selects_take": False,
            "angle_auto_choice": False,
            "script_supervisor_preferred_angle_allowed": True,
            "script_supervisor_usable_range_allowed": True,
            "writes_selection_manifest": False,
            "writes_fcpxml": False,
            "modifies_source_media": False,
        },
    }
