from __future__ import annotations

from pathlib import Path
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


def _has_human_slate_detail(record: dict[str, Any]) -> bool:
    return bool(
        str(record.get("shot", "") or "").strip()
        or record.get("take_number") not in {None, ""}
        or str(record.get("status", "unmarked") or "unmarked") != "unmarked"
        or str(record.get("note", "") or "").strip()
        or isinstance(record.get("usable_range"), dict)
        or str(record.get("preferred_clip_id", "") or "").strip()
    )


def mirror_manual_placement_to_supervisor(project: Any, action: dict[str, Any]) -> None:
    """Mirror explicit human placement into the slate overview without changing editorial state.

    review.json remains the mapping authority. The script-supervisor row is a
    production overview projection: it receives only the explicit script link,
    episode and Take/media identity. Human shot/take/status/I-O/note fields are
    preserved. A clear-placement action removes an auto-created empty overview
    row, but never deletes a row that already contains human slate detail.
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
    # Concurrent slate edits should win. Retrying with a fresh revision is safe
    # because we merge only the mapping projection fields listed below.
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
                store.apply_record(
                    {
                        "record_id": record_id,
                        "expected_revision": revision,
                        "actor": actor,
                        "record": {
                            "source_group_id": group_id,
                            "script_scene_id": "",
                        },
                    }
                )
                return

            segment_ids = [str(value) for value in _as_list(action.get("script_segment_ids")) if str(value)]
            segment = next((_segment(project, segment_id) for segment_id in segment_ids if _segment(project, segment_id)), {})
            episode = segment.get("episode")
            scene_id = str(segment.get("scene_id", "") or "")[:160]
            record: dict[str, Any] = {
                "source_group_id": group_id,
                "script_scene_id": scene_id,
                "attachments": _attachments(group),
            }
            if episode not in {None, ""}:
                record["episode"] = episode
            if not existing and scene_id:
                # New rows need an immediately readable scene column. Existing
                # human scene text is never overwritten by a placement action.
                record["scene"] = scene_id
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
