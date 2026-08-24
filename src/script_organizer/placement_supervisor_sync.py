from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from .script_supervisor_store import ScriptSupervisorConflictError, ScriptSupervisorStore


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _group(project: Any, group_id: str) -> dict[str, Any]:
    groups = getattr(project, "groups", {})
    return _as_dict(groups.get(group_id)) if isinstance(groups, dict) else {}


def _segment(project: Any, segment_id: str) -> dict[str, Any]:
    segments = getattr(project, "segments", {})
    return _as_dict(segments.get(segment_id)) if isinstance(segments, dict) else {}


def _attachments(group: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for member in _as_list(group.get("members")):
        if not isinstance(member, dict):
            continue
        clip_id = str(member.get("clip_id", "") or "")[:160]
        media_id = str(member.get("media_id", "") or "")[:160]
        if not clip_id and not media_id:
            continue
        source = str(member.get("source_media_path", "") or member.get("media_path", "") or "")
        name = str(member.get("name", "") or "") or Path(source).name or clip_id or media_id
        result.append(
            {
                "clip_id": clip_id,
                "media_id": media_id,
                "camera": str(member.get("camera", "") or "")[:40],
                "display_name": Path(name).name[:300],
                "shot_type": "unknown",
                "source_role": "sync_camera",
                "note": "",
            }
        )
    return result[:32]


def _record_for_group(board: dict[str, Any], group_id: str) -> tuple[str, dict[str, Any]]:
    for record_id, record in _as_dict(board.get("records")).items():
        row = _as_dict(record)
        if str(row.get("source_group_id", "") or "") == group_id:
            return str(record_id), row
    return f"placement-{group_id}", {}


def _attachment_key(row: dict[str, Any]) -> tuple[str, str]:
    return str(row.get("clip_id", "") or ""), str(row.get("media_id", "") or "")


def _merged_attachments(group: dict[str, Any], existing: dict[str, Any]) -> list[dict[str, Any]]:
    """Refresh Take identity without erasing human per-angle slate facts."""

    current = {
        _attachment_key(row): dict(row)
        for row in _as_list(existing.get("attachments"))
        if isinstance(row, dict) and any(_attachment_key(row))
    }
    refreshed: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for generated in _attachments(group):
        key = _attachment_key(generated)
        human = current.get(key, {})
        row = dict(generated)
        for field in ("shot_type", "source_role", "note"):
            value = human.get(field)
            if value not in {None, ""}:
                row[field] = value
        refreshed.append(row)
        seen.add(key)

    # Standalone or auxiliary attachments are human production evidence and may
    # not exist in the synchronized Take members. Preserve them verbatim.
    for key, row in current.items():
        if key not in seen:
            refreshed.append(row)
    return refreshed[:32]


def _has_human_slate_detail(record: dict[str, Any]) -> bool:
    if (
        str(record.get("shot", "") or "").strip()
        or record.get("take_number") not in {None, ""}
        or str(record.get("status", "unmarked") or "unmarked") != "unmarked"
        or str(record.get("note", "") or "").strip()
        or isinstance(record.get("usable_range"), dict)
        or str(record.get("preferred_clip_id", "") or "").strip()
    ):
        return True
    for attachment in _as_list(record.get("attachments")):
        if not isinstance(attachment, dict):
            continue
        if (
            str(attachment.get("shot_type", "unknown") or "unknown") != "unknown"
            or str(attachment.get("note", "") or "").strip()
            or str(attachment.get("source_role", "sync_camera") or "sync_camera") != "sync_camera"
        ):
            return True
    return False


def _episode_from_action(action: dict[str, Any]) -> int | None:
    for value in _as_list(action.get("episode_ids")):
        try:
            episode = int(value)
        except (TypeError, ValueError):
            continue
        if episode > 0:
            return episode
    return None


def mirror_manual_placement_to_supervisor(project: Any, action: dict[str, Any]) -> None:
    """Project explicit human placement into the production slate overview.

    review.json remains the mapping authority. The slate is a production-evidence
    projection only. Episode-only placement is first-class: it updates the
    episode column while leaving scene/script ids empty, so rough handwritten
    notes remain rough until a human later refines them.
    """

    action_type = str(action.get("action", "") or "")
    if action_type not in {"set_group_placement", "clear_group_placement"}:
        return
    group_id = str(action.get("group_id", "") or "").strip()
    actor = str(action.get("actor", "") or "").strip()[:80]
    if not group_id or not actor:
        return

    group = _group(project, group_id)
    if not group:
        return

    store = ScriptSupervisorStore(project.config.output_dir)
    for _attempt in range(2):
        board = store.load()
        record_id, existing = _record_for_group(board, group_id)
        revision = int(board.get("revision", 0) or 0)
        try:
            if action_type == "clear_group_placement":
                if not existing:
                    return
                if not _has_human_slate_detail(existing) and record_id.startswith("placement-"):
                    store.apply_record(
                        {
                            "record_id": record_id,
                            "expected_revision": revision,
                            "actor": actor,
                            "delete": True,
                        }
                    )
                    return
                record: dict[str, Any] = {
                    "source_group_id": group_id,
                    "script_scene_id": "",
                    "attachments": _merged_attachments(group, existing),
                    "episode": None,
                }
                # Clear scene text only when it is plainly our generated scene
                # and no independent human slate detail exists.
                if (
                    record_id.startswith("placement-")
                    and not _has_human_slate_detail(existing)
                    and str(existing.get("scene", "") or "") == str(existing.get("script_scene_id", "") or "")
                ):
                    record["scene"] = ""
                store.apply_record(
                    {
                        "record_id": record_id,
                        "expected_revision": revision,
                        "actor": actor,
                        "record": record,
                    }
                )
                return

            segment_ids = [str(value) for value in _as_list(action.get("script_segment_ids")) if str(value)]
            segment = next(
                (_segment(project, segment_id) for segment_id in segment_ids if _segment(project, segment_id)),
                {},
            )
            scene_id = str(segment.get("scene_id", "") or "")[:160]
            episode: Any = segment.get("episode")
            if episode in {None, ""}:
                episode = _episode_from_action(action)

            record = {
                "source_group_id": group_id,
                "script_scene_id": scene_id,
                "attachments": _merged_attachments(group, existing),
            }
            if episode not in {None, ""}:
                record["episode"] = episode

            if segment_ids:
                if not existing and scene_id:
                    record["scene"] = scene_id
            else:
                # Exact -> rough must not leave a stale generated scene, but an
                # actual human slate field always wins over the projection.
                record["script_scene_id"] = ""
                if (
                    record_id.startswith("placement-")
                    and not _has_human_slate_detail(existing)
                    and str(existing.get("scene", "") or "") == str(existing.get("script_scene_id", "") or "")
                ):
                    record["scene"] = ""

            store.apply_record(
                {
                    "record_id": record_id,
                    "expected_revision": revision,
                    "actor": actor,
                    "record": record,
                }
            )
            return
        except ScriptSupervisorConflictError:
            continue
        except ValueError:
            return


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def mirror_review_action_to_supervisor(output_dir: str | Path, action: dict[str, Any]) -> None:
    """Host-level adapter used by ReviewStore without a live ProjectService."""

    output = Path(output_dir)
    material = _read_json(output / "material_index.json")
    script = _read_json(output / "script.json")
    groups = {
        str(row.get("group_id", "") or ""): row
        for row in _as_list(material.get("groups"))
        if isinstance(row, dict) and str(row.get("group_id", "") or "")
    }
    segments = {
        str(row.get("segment_id", "") or ""): row
        for row in _as_list(script.get("segments"))
        if isinstance(row, dict) and str(row.get("segment_id", "") or "")
    }
    if not groups:
        return
    project = SimpleNamespace(
        groups=groups,
        segments=segments,
        config=SimpleNamespace(output_dir=output),
    )
    mirror_manual_placement_to_supervisor(project, action)


__all__ = ["mirror_manual_placement_to_supervisor", "mirror_review_action_to_supervisor"]
