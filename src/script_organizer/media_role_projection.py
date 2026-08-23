from __future__ import annotations

import hashlib
from collections import Counter
from typing import Any

from .media_role_store import MediaRoleStore


ROLE_LABELS = {
    "sync_camera": "同步机位",
    "aerial": "航拍",
    "broll": "空镜",
    "gopro": "GoPro",
    "insert": "细节",
    "custom": "自定义",
}


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _safe_role(media_id: str, raw: object) -> dict[str, Any]:
    row = _as_dict(raw)
    source_role = str(row.get("source_role", "sync_camera") or "sync_camera")
    return {
        "media_id": str(media_id or row.get("media_id", "") or ""),
        "display_name": str(row.get("display_name", "") or "")[:300],
        "camera": str(row.get("camera_override", "") or "")[:40],
        "source_role": source_role,
        "role_label": str(row.get("role_label", "") or ROLE_LABELS.get(source_role, source_role))[:80],
        "sync_policy": str(row.get("sync_policy", "auto") or "auto"),
        "scene_id": str(row.get("scene_id", "") or "")[:160],
        "note": str(row.get("note", "") or "")[:1200],
        "actor": str(row.get("actor", "") or "")[:80],
        "updated_at": str(row.get("updated_at", "") or "")[:80],
    }


def _is_auxiliary(row: dict[str, Any]) -> bool:
    return str(row.get("source_role", "sync_camera")) != "sync_camera" or str(row.get("sync_policy", "auto")) == "exclude"


def _role_payload(project: Any) -> tuple[dict[str, dict[str, Any]], int]:
    payload = MediaRoleStore(project.config.output_dir).load()
    media = payload.get("media", {}) if isinstance(payload.get("media"), dict) else {}
    rows = {
        str(media_id): _safe_role(str(media_id), raw)
        for media_id, raw in media.items()
        if isinstance(raw, dict)
    }
    return rows, int(payload.get("revision", 0) or 0)


def _auxiliary_for_scenes(rows: dict[str, dict[str, Any]], visible_scene_ids: set[str]) -> tuple[dict[str, list[dict[str, Any]]], list[dict[str, Any]]]:
    by_scene: dict[str, list[dict[str, Any]]] = {scene_id: [] for scene_id in visible_scene_ids}
    unplaced: list[dict[str, Any]] = []
    for row in rows.values():
        if not _is_auxiliary(row):
            continue
        scene_id = str(row.get("scene_id", "") or "")
        if scene_id and scene_id in by_scene:
            by_scene[scene_id].append(dict(row))
        elif not scene_id:
            unplaced.append(dict(row))
    for scene_rows in by_scene.values():
        scene_rows.sort(key=lambda item: (str(item.get("source_role", "")), str(item.get("display_name", "")).casefold(), str(item.get("media_id", ""))))
    unplaced.sort(key=lambda item: (str(item.get("source_role", "")), str(item.get("display_name", "")).casefold(), str(item.get("media_id", ""))))
    return by_scene, unplaced


def revision_with_media_roles(base_revision: str, role_revision: int) -> str:
    return hashlib.sha1(f"{base_revision}|media_roles:{int(role_revision)}".encode("utf-8")).hexdigest()[:20]


def enrich_coverage_graph(project: Any, graph: dict[str, Any]) -> dict[str, Any]:
    """Add media_roles.v1 to a freshly built coverage graph in place.

    Auxiliary footage remains a separate scene pool. It never becomes a Take,
    never satisfies dialogue coverage, and never inherits Editorial authority.
    """
    rows, role_revision = _role_payload(project)
    scenes = [item for item in _as_list(graph.get("scenes")) if isinstance(item, dict)]
    visible_scene_ids = {str(scene.get("scene_id", "") or "") for scene in scenes if str(scene.get("scene_id", "") or "")}
    auxiliary_by_scene, unplaced = _auxiliary_for_scenes(rows, visible_scene_ids)

    auxiliary_count = 0
    auxiliary_roles: Counter[str] = Counter()
    overridden_angles = 0
    for scene in scenes:
        for take in _as_list(scene.get("take_groups")):
            if not isinstance(take, dict):
                continue
            for angle in _as_list(take.get("angles")):
                if not isinstance(angle, dict):
                    continue
                media_id = str(angle.get("media_id", "") or "")
                role = rows.get(media_id)
                if not role:
                    continue
                detected_camera = str(angle.get("camera", "") or "")
                override = str(role.get("camera", "") or "")
                angle["detected_camera"] = detected_camera
                if override:
                    angle["camera"] = override
                    overridden_angles += 1
                angle["media_role"] = {
                    "source_role": role["source_role"],
                    "role_label": role["role_label"],
                    "sync_policy": role["sync_policy"],
                    "note": role["note"],
                    "actor": role["actor"],
                    "updated_at": role["updated_at"],
                }

        scene_id = str(scene.get("scene_id", "") or "")
        auxiliary = auxiliary_by_scene.get(scene_id, [])
        scene["auxiliary_media"] = auxiliary
        summary = scene.setdefault("summary", {})
        summary["auxiliary_media"] = len(auxiliary)
        summary["auxiliary_roles"] = dict(sorted(Counter(str(row.get("source_role", "custom")) for row in auxiliary).items()))
        auxiliary_count += len(auxiliary)
        auxiliary_roles.update(str(row.get("source_role", "custom")) for row in auxiliary)

    base_revision = str(graph.get("revision", "") or "")
    graph["revision"] = revision_with_media_roles(base_revision, role_revision)
    graph.setdefault("revisions", {})["media_roles"] = role_revision
    summary = graph.setdefault("summary", {})
    summary["auxiliary_media"] = auxiliary_count
    summary["unplaced_auxiliary_media"] = len(unplaced)
    summary["auxiliary_roles"] = dict(sorted(auxiliary_roles.items()))
    summary["camera_overrides"] = overridden_angles
    graph["unplaced_auxiliary_media"] = unplaced
    graph.setdefault("semantics", {}).update(
        {
            "consumes_media_roles_v1": True,
            "auxiliary_media_is_sync_failure": False,
            "auxiliary_media_is_take": False,
            "auxiliary_media_is_editorial_authority": False,
            "auxiliary_media_satisfies_dialogue_coverage": False,
            "camera_override_is_human_production_fact": True,
        }
    )
    return graph


def enrich_rough_cut_plan(project: Any, plan: dict[str, Any]) -> dict[str, Any]:
    """Expose scene-level auxiliary pools without promoting them to Best."""
    rows, role_revision = _role_payload(project)
    scenes = [item for item in _as_list(plan.get("scenes")) if isinstance(item, dict)]
    visible_scene_ids = {str(scene.get("scene_id", "") or "") for scene in scenes if str(scene.get("scene_id", "") or "")}
    auxiliary_by_scene, unplaced = _auxiliary_for_scenes(rows, visible_scene_ids)
    total = 0
    roles: Counter[str] = Counter()
    for scene in scenes:
        scene_id = str(scene.get("scene_id", "") or "")
        auxiliary = auxiliary_by_scene.get(scene_id, [])
        scene["auxiliary_media"] = auxiliary
        pools: dict[str, list[dict[str, Any]]] = {}
        for row in auxiliary:
            key = str(row.get("source_role", "custom") or "custom")
            pools.setdefault(key, []).append(row)
            roles[key] += 1
        scene["auxiliary_pools"] = pools
        scene.setdefault("summary", {})["auxiliary_media"] = len(auxiliary)
        total += len(auxiliary)

    plan.setdefault("revisions", {})["media_roles"] = role_revision
    summary = plan.setdefault("summary", {})
    summary["auxiliary_media"] = total
    summary["unplaced_auxiliary_media"] = len(unplaced)
    summary["auxiliary_roles"] = dict(sorted(roles.items()))
    plan["unplaced_auxiliary_media"] = unplaced
    plan.setdefault("semantics", {}).update(
        {
            "consumes_media_roles_v1": True,
            "auxiliary_media_is_optional_coverage": True,
            "auxiliary_media_can_replace_best": False,
            "auxiliary_media_can_become_primary_take": False,
            "auxiliary_media_is_editorial_authority": False,
        }
    )
    return plan
