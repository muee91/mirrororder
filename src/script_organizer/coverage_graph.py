from __future__ import annotations

import hashlib
import json
from collections import Counter, OrderedDict
from typing import Any

from .audit_engine import _analysis_revision, _mapping_for_group
from .audit_store import AuditStore
from .automation_store import AutomationStore
from .editorial_store import EditorialStore
from .review_store import ReviewStore


COVERAGE_CONTRACT = "coverage.v1"


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _source_revision(
    analysis_revision: str,
    review: dict[str, Any],
    editorial: dict[str, Any],
    audit: dict[str, Any],
    automation: dict[str, Any],
) -> str:
    raw = {
        "analysis": analysis_revision,
        "review": _int(review.get("revision"), 0),
        "editorial": _int(editorial.get("revision"), 0),
        "audit": _int(audit.get("revision"), 0),
        "automation": str(automation.get("updated_at", "") or ""),
    }
    return hashlib.sha1(
        json.dumps(raw, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:20]


def _scene_index(script: dict[str, Any]) -> tuple[OrderedDict[str, dict[str, Any]], dict[str, str]]:
    scenes: OrderedDict[str, dict[str, Any]] = OrderedDict()
    segment_scene: dict[str, str] = {}
    segments = [item for item in _as_list(script.get("segments")) if isinstance(item, dict)]
    segments.sort(
        key=lambda item: (
            _int(item.get("episode"), 0),
            _int(item.get("order"), 0),
            str(item.get("segment_id", "")),
        )
    )
    for segment in segments:
        segment_id = str(segment.get("segment_id", "") or "")
        if not segment_id:
            continue
        episode = _int(segment.get("episode"), 0)
        scene_id = str(segment.get("scene_id", "") or f"episode-{episode}-ungrouped")
        scene = scenes.setdefault(
            scene_id,
            {
                "scene_id": scene_id,
                "episode": episode,
                "heading": "",
                "segment_ids": [],
                "script_orders": [],
            },
        )
        scene["segment_ids"].append(segment_id)
        scene["script_orders"].append(_int(segment.get("order"), 0))
        if str(segment.get("type", "") or "") == "scene_heading":
            heading = str(segment.get("raw_text", "") or segment.get("text", "") or "").strip()
            if heading:
                scene["heading"] = heading
        segment_scene[segment_id] = scene_id
    return scenes, segment_scene


def _audit_freshness(
    audit_row: dict[str, Any],
    analysis_revision: str,
    mapping: dict[str, Any],
) -> tuple[bool, bool]:
    visual_current = bool(
        audit_row
        and str(audit_row.get("analysis_revision", "") or "") == analysis_revision
    )
    mapping_current = bool(
        visual_current
        and _as_dict(audit_row.get("mapping")) == mapping
    )
    return visual_current, mapping_current


def _editorial_for_scene(
    editorial: EditorialStore,
    group_id: str,
    scene_segment_ids: set[str],
) -> dict[str, Any]:
    collaboration = editorial.for_group(group_id)
    decision = _as_dict(collaboration.get("decision"))
    group_decision = _as_dict(decision.get("group"))
    assignments = [
        item
        for item in _as_list(decision.get("assignments"))
        if isinstance(item, dict)
        and str(_as_dict(item.get("target")).get("segment_id", "")) in scene_segment_ids
    ]
    states = [str(item.get("state", "") or "") for item in assignments if item.get("state")]
    if assignments:
        resolved = states[0] if states and all(value == states[0] for value in states) else "mixed"
        source = "assignment"
    elif group_decision:
        resolved = str(group_decision.get("state", "") or "unreviewed")
        source = "group"
    else:
        resolved = "unreviewed"
        source = "none"
    return {
        "state": resolved,
        "source": source,
        "group": {
            "state": str(group_decision.get("state", "") or ""),
            "actor": str(group_decision.get("actor", "") or ""),
            "updated_at": str(group_decision.get("updated_at", "") or ""),
        } if group_decision else {},
        "assignments": [
            {
                "segment_id": str(_as_dict(item.get("target")).get("segment_id", "") or ""),
                "state": str(item.get("state", "") or ""),
                "actor": str(item.get("actor", "") or ""),
                "updated_at": str(item.get("updated_at", "") or ""),
            }
            for item in assignments
        ],
    }


def _safe_angle(member: dict[str, Any], intelligence: dict[str, Any]) -> dict[str, Any]:
    return {
        "clip_id": str(member.get("clip_id", "") or ""),
        "media_id": str(member.get("media_id", "") or ""),
        "camera": str(member.get("camera", "") or ""),
        "name": str(member.get("name", "") or ""),
        "duration": _float(member.get("duration"), 0.0),
        "source_start": _float(member.get("source_start"), 0.0),
        "source_end": (
            _float(member.get("source_end"), 0.0)
            if member.get("source_end") is not None
            else None
        ),
        "shot_type": str(intelligence.get("shot_type", "unknown") or "unknown"),
        "coverage_role": str(intelligence.get("coverage_role", "unknown") or "unknown"),
        "visible_people": [
            str(value) for value in _as_list(intelligence.get("visible_people")) if str(value)
        ],
        "technical_issues": [
            str(value) for value in _as_list(intelligence.get("technical_issues")) if str(value)
        ],
    }


def build_coverage_graph(
    project: Any,
    *,
    scene_id: str | None = None,
    episode: int | None = None,
) -> dict[str, Any]:
    """Build a scene-centric, read-only coverage graph for production planning.

    The graph does not infer missing shots and does not turn Editorial Decision
    into delivery authority. It only organizes existing mapping, shot evidence,
    continuity evidence and explicit final editorial annotations.
    """

    project.reload_if_changed()
    script = _as_dict(project.script)
    index = _as_dict(project.index)
    review = ReviewStore(project.config.output_dir / "review.json").load()
    automation = AutomationStore(project.config.output_dir).load()
    automation_groups = _as_dict(automation.get("groups"))
    audit = AuditStore(project.config.output_dir).load()
    audit_groups = _as_dict(audit.get("groups"))
    editorial_store = EditorialStore(project.config.output_dir)
    editorial = editorial_store.load()
    analysis_revision = _analysis_revision(project.config.output_dir)

    scenes, segment_scene = _scene_index(script)
    requested_scene = str(scene_id or "").strip()
    requested_episode = _int(episode, 0) if episode is not None else 0
    selected_scene_ids = {
        key
        for key, value in scenes.items()
        if (not requested_scene or key == requested_scene)
        and (not requested_episode or _int(value.get("episode"), 0) == requested_episode)
    }

    scene_groups: dict[str, list[dict[str, Any]]] = {key: [] for key in selected_scene_ids}
    unplaced_group_ids: list[str] = []
    episode_only_groups: list[dict[str, Any]] = []

    groups = [item for item in _as_list(index.get("groups")) if isinstance(item, dict) and item.get("group_id")]
    groups.sort(key=lambda item: (_float(item.get("start"), 0.0), str(item.get("group_id", ""))))

    for group in groups:
        group_id = str(group.get("group_id", "") or "")
        automatic = _as_dict(automation_groups.get(group_id))
        mapping = _mapping_for_group(review, automatic, group)
        segment_ids = [str(value) for value in _as_list(mapping.get("script_segment_ids")) if str(value)]
        mapped_scene_ids = list(dict.fromkeys(segment_scene[value] for value in segment_ids if value in segment_scene))
        if not mapped_scene_ids:
            episode_ids = [_int(value) for value in _as_list(mapping.get("episode_ids")) if _int(value) > 0]
            if episode_ids:
                episode_only_groups.append(
                    {
                        "group_id": group_id,
                        "episode_ids": sorted(set(episode_ids)),
                        "mapping_source": str(mapping.get("source", "none") or "none"),
                    }
                )
            else:
                unplaced_group_ids.append(group_id)
            continue

        audit_row = _as_dict(audit_groups.get(group_id))
        visual_current, mapping_current = _audit_freshness(audit_row, analysis_revision, mapping)
        shot_angles = _as_dict(_as_dict(audit_row.get("shot_intelligence")).get("angles")) if visual_current else {}
        fresh_rough_cut = _as_dict(audit_row.get("rough_cut")) if mapping_current else {}
        fresh_issues = [
            item for item in _as_list(audit_row.get("issues"))
            if mapping_current and isinstance(item, dict)
        ]

        for mapped_scene_id in mapped_scene_ids:
            if mapped_scene_id not in selected_scene_ids:
                continue
            scene = scenes[mapped_scene_id]
            scene_segment_ids = set(str(value) for value in _as_list(scene.get("segment_ids")) if str(value))
            members = [item for item in _as_list(group.get("members")) if isinstance(item, dict)]
            members.sort(key=lambda item: (str(item.get("camera", "")), str(item.get("clip_id", ""))))
            angles = [
                _safe_angle(member, _as_dict(shot_angles.get(str(member.get("clip_id", "") or ""))))
                for member in members
            ]
            continuity_risk = str(fresh_rough_cut.get("continuity_risk", "unknown") or "unknown")
            continuity_issues = [
                {
                    "code": "continuity_risk",
                    "severity": str(item.get("severity", "warning") or "warning"),
                    "detail": str(item.get("detail", "") or ""),
                }
                for item in fresh_issues
                if str(item.get("code", "") or "") == "continuity_risk"
            ]
            scene_groups[mapped_scene_id].append(
                {
                    "group_id": group_id,
                    "start": _float(group.get("start"), 0.0),
                    "end": _float(group.get("end"), 0.0),
                    "duration": _float(group.get("duration"), 0.0),
                    "mapping_source": str(mapping.get("source", "none") or "none"),
                    "mapping_status": str(mapping.get("status", "") or ""),
                    "script_segment_ids": [value for value in segment_ids if value in scene_segment_ids],
                    "audit": {
                        "visual_current": visual_current,
                        "mapping_current": mapping_current,
                        "mapping_stale": bool(visual_current and not mapping_current),
                    },
                    "angles": angles,
                    "rough_cut": {
                        "technical_usability": str(fresh_rough_cut.get("technical_usability", "unknown") or "unknown"),
                        "take_completeness": str(fresh_rough_cut.get("take_completeness", "unknown") or "unknown"),
                        "coverage_role": str(fresh_rough_cut.get("coverage_role", "unknown") or "unknown"),
                        "continuity_risk": continuity_risk,
                    } if mapping_current else {},
                    "continuity_issues": continuity_issues,
                    "editorial_decision": _editorial_for_scene(
                        editorial_store,
                        group_id,
                        scene_segment_ids,
                    ),
                }
            )

    scene_rows: list[dict[str, Any]] = []
    total_groups: set[str] = set()
    total_angles = 0
    known_angles = 0
    total_continuity_risks = 0
    unobserved_scenes = 0

    for current_scene_id, scene in scenes.items():
        if current_scene_id not in selected_scene_ids:
            continue
        take_groups = scene_groups.get(current_scene_id, [])
        total_groups.update(str(item.get("group_id", "")) for item in take_groups if item.get("group_id"))
        angles = [angle for group in take_groups for angle in _as_list(group.get("angles")) if isinstance(angle, dict)]
        total_angles += len(angles)
        known = [angle for angle in angles if str(angle.get("shot_type", "unknown")) != "unknown"]
        known_angles += len(known)
        role_counts = Counter(
            str(angle.get("coverage_role", "unknown") or "unknown")
            for angle in angles
            if str(angle.get("coverage_role", "unknown") or "unknown") != "unknown"
        )
        shot_counts = Counter(
            str(angle.get("shot_type", "unknown") or "unknown")
            for angle in angles
            if str(angle.get("shot_type", "unknown") or "unknown") != "unknown"
        )
        editorial_counts = Counter(
            str(_as_dict(group.get("editorial_decision")).get("state", "unreviewed") or "unreviewed")
            for group in take_groups
        )
        continuity = [
            {
                "group_id": str(group.get("group_id", "") or ""),
                "risk": str(_as_dict(group.get("rough_cut")).get("continuity_risk", "unknown") or "unknown"),
                "issues": _as_list(group.get("continuity_issues")),
            }
            for group in take_groups
            if str(_as_dict(group.get("rough_cut")).get("continuity_risk", "unknown") or "unknown") in {"medium", "high"}
            or _as_list(group.get("continuity_issues"))
        ]
        total_continuity_risks += len(continuity)
        issues: list[dict[str, Any]] = []
        if not take_groups:
            issues.append(
                {
                    "code": "no_mapped_take",
                    "severity": "warning",
                    "label": "场景尚无已确认或已自动完成的 Take 归集",
                }
            )
        elif angles and not known:
            unobserved_scenes += 1
            issues.append(
                {
                    "code": "coverage_unobserved",
                    "severity": "info",
                    "label": "已有 Take，但尚无可复用的景别证据",
                }
            )
        elif 0 < len(known) < len(angles):
            issues.append(
                {
                    "code": "coverage_partial",
                    "severity": "info",
                    "label": "部分机位尚无景别证据",
                }
            )
        if continuity:
            issues.append(
                {
                    "code": "continuity_attention",
                    "severity": "warning",
                    "label": f"{len(continuity)} 个 Take 有连续性风险证据",
                }
            )

        orders = [_int(value) for value in _as_list(scene.get("script_orders")) if _int(value) > 0]
        scene_rows.append(
            {
                "scene_id": current_scene_id,
                "episode": _int(scene.get("episode"), 0),
                "heading": str(scene.get("heading", "") or ""),
                "script_segment_ids": [str(value) for value in _as_list(scene.get("segment_ids")) if str(value)],
                "script_order": {
                    "start": min(orders) if orders else 0,
                    "end": max(orders) if orders else 0,
                },
                "summary": {
                    "take_groups": len(take_groups),
                    "angles": len(angles),
                    "known_shots": len(known),
                    "unknown_shots": max(0, len(angles) - len(known)),
                    "coverage_roles": dict(sorted(role_counts.items())),
                    "shot_types": dict(sorted(shot_counts.items())),
                    "editorial_decisions": dict(sorted(editorial_counts.items())),
                    "continuity_risks": len(continuity),
                },
                "issues": issues,
                "continuity": continuity,
                "take_groups": take_groups,
            }
        )

    scene_rows.sort(key=lambda item: (item["episode"], item["script_order"]["start"], item["scene_id"]))
    return {
        "contract": COVERAGE_CONTRACT,
        "revision": _source_revision(analysis_revision, review, editorial, audit, automation),
        "project_id": str(getattr(project, "project_id", "") or ""),
        "revisions": {
            "analysis": analysis_revision,
            "review": _int(review.get("revision"), 0),
            "editorial": _int(editorial.get("revision"), 0),
            "audit": _int(audit.get("revision"), 0),
            "automation_updated_at": str(automation.get("updated_at", "") or ""),
        },
        "filters": {
            "scene_id": requested_scene,
            "episode": requested_episode,
        },
        "summary": {
            "scenes": len(scene_rows),
            "mapped_take_groups": len(total_groups),
            "angles": total_angles,
            "known_shots": known_angles,
            "unknown_shots": max(0, total_angles - known_angles),
            "continuity_risks": total_continuity_risks,
            "unobserved_scenes": unobserved_scenes,
            "unplaced_groups": len(unplaced_group_ids),
            "episode_only_groups": len(episode_only_groups),
        },
        "scenes": scene_rows,
        "episode_only_groups": episode_only_groups,
        "unplaced_group_ids": unplaced_group_ids,
        "semantics": {
            "editorial_decision_is_annotation_only": True,
            "individual_opinions_used": False,
            "delivery_authority_changed": False,
            "missing_shots_are_not_inferred": True,
        },
    }


def continuity_risks(graph: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for scene in _as_list(graph.get("scenes")):
        if not isinstance(scene, dict):
            continue
        for risk in _as_list(scene.get("continuity")):
            if not isinstance(risk, dict):
                continue
            rows.append(
                {
                    "scene_id": str(scene.get("scene_id", "") or ""),
                    "episode": _int(scene.get("episode"), 0),
                    "heading": str(scene.get("heading", "") or ""),
                    "group_id": str(risk.get("group_id", "") or ""),
                    "risk": str(risk.get("risk", "unknown") or "unknown"),
                    "issues": _as_list(risk.get("issues")),
                }
            )
    rank = {"high": 0, "medium": 1, "unknown": 2}
    rows.sort(key=lambda item: (rank.get(item["risk"], 3), item["episode"], item["scene_id"], item["group_id"]))
    return rows
