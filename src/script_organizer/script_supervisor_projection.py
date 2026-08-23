from __future__ import annotations

import hashlib
from collections import Counter
from typing import Any

from .media_role_store import MediaRoleStore
from .script_supervisor_store import ScriptSupervisorStore


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _safe_attachment(record: dict[str, Any], attachment: dict[str, Any]) -> dict[str, Any]:
    return {
        "record_id": str(record.get("record_id", "") or ""),
        "media_id": str(attachment.get("media_id", "") or ""),
        "clip_id": str(attachment.get("clip_id", "") or ""),
        "display_name": str(attachment.get("display_name", "") or "")[:300],
        "camera": str(attachment.get("camera", "") or "")[:40],
        "source_role": str(attachment.get("source_role", "custom") or "custom")[:40],
        "shot_type": str(attachment.get("shot_type", "unknown") or "unknown")[:40],
        "attachment_note": str(attachment.get("note", "") or "")[:500],
        "slate": {
            "episode": record.get("episode"),
            "scene": str(record.get("scene", "") or "")[:80],
            "shot": str(record.get("shot", "") or "")[:80],
            "take_number": record.get("take_number"),
            "status": str(record.get("status", "unmarked") or "unmarked"),
            "note": str(record.get("note", "") or "")[:2000],
            "actor": str(record.get("actor", "") or "")[:80],
            "updated_at": str(record.get("updated_at", "") or "")[:80],
        },
    }


def _record_scene(record: dict[str, Any], media_roles: dict[str, Any]) -> str:
    explicit = str(record.get("script_scene_id", "") or "")
    if explicit:
        return explicit
    # A media-role scene_id is also an explicit human production fact. Reuse it
    # only when all attached materials with a scene assignment agree. Human
    # display text such as “24场” is deliberately not interpreted here.
    scene_ids = {
        str(_as_dict(media_roles.get(str(attachment.get("media_id", "") or ""))).get("scene_id", "") or "")
        for attachment in _as_list(record.get("attachments"))
        if isinstance(attachment, dict) and attachment.get("media_id")
    }
    scene_ids.discard("")
    return next(iter(scene_ids)) if len(scene_ids) == 1 else ""


def _scene_pool(project: Any) -> tuple[dict[str, list[dict[str, Any]]], int]:
    board = ScriptSupervisorStore(project.config.output_dir).load()
    records = board.get("records", {}) if isinstance(board.get("records"), dict) else {}
    roles_payload = MediaRoleStore(project.config.output_dir).load()
    media_roles = roles_payload.get("media", {}) if isinstance(roles_payload.get("media"), dict) else {}
    by_scene: dict[str, list[dict[str, Any]]] = {}
    for raw in records.values():
        record = _as_dict(raw)
        if record.get("source_group_id"):
            continue
        scene_id = _record_scene(record, media_roles)
        if not scene_id:
            continue
        for raw_attachment in _as_list(record.get("attachments")):
            attachment = _as_dict(raw_attachment)
            if not attachment.get("media_id") and not attachment.get("clip_id"):
                continue
            by_scene.setdefault(scene_id, []).append(_safe_attachment(record, attachment))
    for rows in by_scene.values():
        rows.sort(key=lambda row: (row["record_id"], row["camera"], row["display_name"], row["media_id"]))
    return by_scene, int(board.get("revision", 0) or 0)


def _revision(base: str, supervisor_revision: int) -> str:
    return hashlib.sha1(f"{base}|slate-standalone:{supervisor_revision}".encode("utf-8")).hexdigest()[:20]


def enrich_coverage_with_standalone_slate(project: Any, graph: dict[str, Any]) -> dict[str, Any]:
    by_scene, supervisor_revision = _scene_pool(project)
    total = 0
    statuses: Counter[str] = Counter()
    roles: Counter[str] = Counter()
    for scene in _as_list(graph.get("scenes")):
        if not isinstance(scene, dict):
            continue
        rows = by_scene.get(str(scene.get("scene_id", "") or ""), [])
        scene["slate_auxiliary_media"] = rows
        scene.setdefault("summary", {})["slate_auxiliary_media"] = len(rows)
        total += len(rows)
        for row in rows:
            statuses[str(_as_dict(row.get("slate")).get("status", "unmarked") or "unmarked")] += 1
            roles[str(row.get("source_role", "custom") or "custom")] += 1
    graph["revision"] = _revision(str(graph.get("revision", "") or ""), supervisor_revision)
    graph.setdefault("revisions", {})["script_supervisor"] = supervisor_revision
    graph.setdefault("summary", {})["slate_auxiliary_media"] = total
    graph["summary"]["slate_auxiliary_status"] = dict(sorted(statuses.items()))
    graph["summary"]["slate_auxiliary_roles"] = dict(sorted(roles.items()))
    graph.setdefault("semantics", {}).update(
        {
            "standalone_slate_media_supported": True,
            "standalone_slate_requires_explicit_scene_link": True,
            "media_role_scene_is_explicit_link": True,
            "human_scene_text_is_not_guessed_into_script_scene": True,
            "standalone_slate_media_is_take": False,
            "standalone_slate_media_is_editorial_authority": False,
        }
    )
    return graph


def enrich_rough_cut_with_standalone_slate(project: Any, plan: dict[str, Any]) -> dict[str, Any]:
    by_scene, supervisor_revision = _scene_pool(project)
    total = 0
    for scene in _as_list(plan.get("scenes")):
        if not isinstance(scene, dict):
            continue
        rows = by_scene.get(str(scene.get("scene_id", "") or ""), [])
        scene["slate_auxiliary_media"] = rows
        scene.setdefault("summary", {})["slate_auxiliary_media"] = len(rows)
        total += len(rows)
    plan.setdefault("revisions", {})["script_supervisor"] = supervisor_revision
    plan.setdefault("summary", {})["slate_auxiliary_media"] = total
    plan.setdefault("semantics", {}).update(
        {
            "consumes_script_supervisor_v2": True,
            "standalone_slate_media_is_optional_coverage": True,
            "standalone_slate_media_can_become_primary_take": False,
            "standalone_slate_media_can_replace_best": False,
            "standalone_slate_media_is_editorial_authority": False,
        }
    )
    return plan
