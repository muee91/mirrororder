from __future__ import annotations

from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from .automation_store import AutomationStore, COMPLETED_STATUSES
from .identity_library import IdentityLibrary
from .review_store import effective_group_entry, effective_group_state
from .workspace_db import WorkspaceDatabase

CONTRACT_VERSION = "review.v1"
_INSTALLED = False


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _candidate_ids(candidate: dict[str, Any]) -> list[str]:
    values = candidate.get("script_segment_ids") or (
        [candidate.get("script_segment_id")] if candidate.get("script_segment_id") else []
    )
    return list(dict.fromkeys(str(value) for value in values if str(value)))


def _episode_ids(segment_ids: list[str], segments: dict[str, dict[str, Any]]) -> list[int]:
    values: set[int] = set()
    for segment_id in segment_ids:
        episode = _int(segments.get(segment_id, {}).get("episode"), 0)
        if episode > 0:
            values.add(episode)
    return sorted(values)


def _safe_review_entry(value: object) -> dict[str, Any]:
    entry = _as_dict(value)
    if not entry:
        return {}
    result = {
        "state": str(entry.get("state", "") or ""),
        "method": str(entry.get("method", "") or ""),
        "updated_at": str(entry.get("updated_at", "") or ""),
    }
    actor = str(entry.get("actor", "") or "")
    if actor:
        result["actor"] = actor
    return {key: value for key, value in result.items() if value not in {"", None}}


def _safe_placement(value: object) -> dict[str, Any]:
    entry = _as_dict(value)
    if not entry:
        return {}
    result: dict[str, Any] = {
        "episode_ids": sorted({_int(item) for item in _as_list(entry.get("episode_ids")) if _int(item) > 0}),
        "script_segment_ids": list(
            dict.fromkeys(str(item) for item in _as_list(entry.get("script_segment_ids")) if str(item))
        ),
        "method": str(entry.get("method", "") or ""),
        "updated_at": str(entry.get("updated_at", "") or ""),
    }
    actor = str(entry.get("actor", "") or "")
    if actor:
        result["actor"] = actor
    return result


def _effective_placement(review: dict[str, Any], group: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    group_id = str(group.get("group_id", "") or "")
    parent = str(group.get("parent_group_id", "") or "")
    direct = _safe_placement(_as_dict(review.get("placements")).get(group_id))
    if direct:
        return direct, False
    if parent:
        inherited = _safe_placement(_as_dict(review.get("placements")).get(parent))
        if inherited:
            return inherited, True
    return {}, False


def _assignment_rows(review: dict[str, Any], group: dict[str, Any]) -> list[dict[str, Any]]:
    group_id = str(group.get("group_id", "") or "")
    parent = str(group.get("parent_group_id", "") or "")
    rows: list[dict[str, Any]] = []
    for segment_id, assignments in _as_dict(review.get("assignments")).items():
        assignment_map = _as_dict(assignments)
        entry = assignment_map.get(group_id)
        inherited = False
        if not entry and parent:
            entry = assignment_map.get(parent)
            inherited = bool(entry)
        safe = _safe_review_entry(entry)
        if not safe:
            continue
        rows.append({"segment_id": str(segment_id), "inherited": inherited, **safe})
    return rows


def _manual_mapping(
    review: dict[str, Any],
    group: dict[str, Any],
    segments: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    placement, inherited = _effective_placement(review, group)
    assignment_rows = _assignment_rows(review, group)
    segment_ids = list(placement.get("script_segment_ids", []))
    segment_ids.extend(row["segment_id"] for row in assignment_rows)
    segment_ids = list(dict.fromkeys(value for value in segment_ids if value in segments))
    episode_ids = sorted(
        set(placement.get("episode_ids", [])) | set(_episode_ids(segment_ids, segments))
    )
    if not segment_ids and not episode_ids:
        return None
    return {
        "source": "human",
        "mapping_status": "confirmed" if segment_ids else "episode_only",
        "script_segment_ids": segment_ids,
        "episode_ids": episode_ids,
        "inherited": inherited,
    }


def _safe_automation(value: object) -> dict[str, Any]:
    entry = _as_dict(value)
    if not entry:
        return {"available": False}
    result: dict[str, Any] = {
        "available": True,
        "status": str(entry.get("status", "") or ""),
        "mapping_status": str(entry.get("mapping_status", "") or ""),
        "mapping_source": str(entry.get("mapping_source", "") or ""),
        "candidate_id": str(entry.get("candidate_id", "") or ""),
        "script_segment_ids": list(
            dict.fromkeys(str(item) for item in _as_list(entry.get("script_segment_ids")) if str(item))
        ),
        "episode_ids": sorted({_int(item) for item in _as_list(entry.get("episode_ids")) if _int(item) > 0}),
        "confidence": _float(entry.get("confidence"), 0.0),
        "reason": str(entry.get("reason", "") or ""),
    }
    evidence = _as_dict(entry.get("evidence"))
    if evidence:
        safe_evidence: dict[str, Any] = {}
        for key in (
            "total_score",
            "dialogue_score",
            "margin",
            "model_confidence",
            "local_total_score",
            "local_dialogue_score",
            "sequence_consistent",
            "visual_summary",
            "camera",
        ):
            if key in evidence:
                safe_evidence[key] = evidence[key]
        if safe_evidence:
            result["evidence"] = safe_evidence
    return result


def _safe_candidate(
    candidate: dict[str, Any],
    segments: dict[str, dict[str, Any]],
    index: int,
) -> dict[str, Any]:
    segment_ids = _candidate_ids(candidate)
    result: dict[str, Any] = {
        "candidate_id": str(candidate.get("candidate_id", "") or f"candidate_{index}"),
        "group_id": str(candidate.get("group_id", "") or ""),
        "script_segment_id": str(candidate.get("script_segment_id", "") or ""),
        "script_segment_ids": segment_ids,
        "episode_ids": _episode_ids(segment_ids, segments),
        "confidence": str(candidate.get("confidence", "") or ""),
        "total_score": _float(candidate.get("total_score"), 0.0),
        "dialogue_score": _float(candidate.get("dialogue_score"), 0.0),
        "sequence_score": _float(candidate.get("sequence_score"), 0.0),
        "context_score": _float(candidate.get("context_score"), 0.0),
        "margin": _float(candidate.get("margin"), 0.0),
        "method": str(candidate.get("method", "") or ""),
        "transcript_text": str(candidate.get("transcript_text", "") or ""),
        "evidence": [str(item) for item in _as_list(candidate.get("evidence")) if str(item)],
        "context_episodes": sorted(
            {_int(item) for item in _as_list(candidate.get("context_episodes")) if _int(item) > 0}
        ),
    }
    for key in ("relative_start", "relative_end"):
        if candidate.get(key) is not None:
            result[key] = _float(candidate.get(key), 0.0)
    return result


def _script_block(segment: dict[str, Any], gap_codes: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    segment_id = str(segment.get("segment_id", "") or "")
    return {
        "segment_id": segment_id,
        "episode": _int(segment.get("episode"), 0),
        "scene_id": str(segment.get("scene_id", "") or ""),
        "order": _int(segment.get("order"), 0),
        "type": str(segment.get("type", "") or ""),
        "speaker": str(segment.get("speaker", "") or ""),
        "text": str(segment.get("text", "") or ""),
        "raw_text": str(segment.get("raw_text", "") or ""),
        "issues": list(gap_codes.get(segment_id, [])),
    }


def _media_endpoint(workspace_id: str, project_id: str, clip_id: str) -> str:
    project = quote(project_id, safe="")
    clip = quote(clip_id, safe="")
    if workspace_id:
        workspace = quote(workspace_id, safe="")
        return f"/api/v1/workspaces/{workspace}/projects/{project}/media/{clip}"
    return f"/api/v1/projects/{project}/media/{clip}"


def _safe_angle(workspace_id: str, project_id: str, member: dict[str, Any]) -> dict[str, Any]:
    raw_name = str(member.get("name", "") or "")
    source = str(member.get("source_media_path", "") or member.get("media_path", "") or "")
    name = raw_name or Path(source).name or str(member.get("clip_id", "") or "未命名素材")
    local_exists = member.get("local_exists")
    available = bool(local_exists) if isinstance(local_exists, bool) else None
    playback: dict[str, Any] = {
        "url": _media_endpoint(workspace_id, project_id, str(member.get("clip_id", "") or "")),
        "source_start": _float(member.get("source_start"), 0.0),
        "source_end": (
            _float(member.get("source_end"), 0.0) if member.get("source_end") is not None else None
        ),
    }
    if available is not None:
        playback["available"] = available
    return {
        "clip_id": str(member.get("clip_id", "") or ""),
        "media_id": str(member.get("media_id", "") or ""),
        "camera": str(member.get("camera", "") or ""),
        "name": name,
        "timeline_start": _float(member.get("timeline_start"), 0.0),
        "timeline_end": _float(member.get("timeline_end"), 0.0),
        "duration": _float(member.get("duration"), 0.0),
        "source_start": _float(member.get("source_start"), 0.0),
        "source_end": (
            _float(member.get("source_end"), 0.0) if member.get("source_end") is not None else None
        ),
        "playback": playback,
    }


def _legacy_manual_state(review: dict[str, Any], group: dict[str, Any]) -> dict[str, Any]:
    group_id = str(group.get("group_id", "") or "")
    parent = str(group.get("parent_group_id", "") or "")
    members = [item for item in _as_list(group.get("members")) if isinstance(item, dict)]
    clip_ids = [str(item.get("clip_id", "") or "") for item in members if item.get("clip_id")]
    group_entry, inherited = effective_group_entry(review, group_id, parent)
    placement, placement_inherited = _effective_placement(review, group)
    clips = []
    for clip_id in clip_ids:
        entry = _safe_review_entry(_as_dict(review.get("clips")).get(clip_id))
        if entry:
            clips.append({"clip_id": clip_id, **entry})
    return {
        "effective_state": effective_group_state(review, group_id, clip_ids, parent),
        "group": _safe_review_entry(group_entry),
        "group_inherited": inherited,
        "placement": placement,
        "placement_inherited": placement_inherited,
        "assignments": _assignment_rows(review, group),
        "clips": clips,
    }


def _effective_mapping(
    review: dict[str, Any],
    automation_entry: dict[str, Any],
    group: dict[str, Any],
    segments: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    manual = _manual_mapping(review, group, segments)
    if manual:
        return manual
    automatic = _safe_automation(automation_entry)
    if automatic.get("status") in COMPLETED_STATUSES:
        ids = list(automatic.get("script_segment_ids", []))
        episodes = list(automatic.get("episode_ids", [])) or _episode_ids(ids, segments)
        return {
            "source": "automatic",
            "mapping_status": str(automatic.get("mapping_status", "confirmed") or "confirmed"),
            "script_segment_ids": ids,
            "episode_ids": episodes,
        }
    return {
        "source": "none",
        "mapping_status": "unresolved",
        "script_segment_ids": [],
        "episode_ids": [],
    }


def _group_issues(
    automatic: dict[str, Any],
    angles: list[dict[str, Any]],
    *,
    automation_stale: bool,
) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    status = str(automatic.get("status", "") or "")
    if status == "needs_review":
        issues.append({"code": "needs_review", "severity": "warning", "label": "剧本归集需要人工确认"})
    elif status == "unresolved":
        issues.append({"code": "unresolved", "severity": "warning", "label": "归集证据不足"})
    if any(angle.get("playback", {}).get("available") is False for angle in angles):
        issues.append({"code": "missing_media", "severity": "error", "label": "网关主机缺少可播放媒体"})
    if automation_stale:
        issues.append({"code": "automation_stale", "severity": "warning", "label": "自动决策落后于当前分析"})
    return issues


def _people_loader(project: Any) -> Callable[[str], dict[str, list[dict[str, Any]]]]:
    workspace_id = str(getattr(project, "workspace_id", "") or "")
    if not workspace_id:
        return lambda _group_id: {"face": [], "speaker": []}
    try:
        library = IdentityLibrary(WorkspaceDatabase(workspace_id), project.project_id)
    except Exception:
        return lambda _group_id: {"face": [], "speaker": []}

    def load(group_id: str) -> dict[str, list[dict[str, Any]]]:
        try:
            return library.group_identities(group_id)
        except Exception:
            return {"face": [], "speaker": []}

    return load


def build_review_read_model(
    project: Any,
    *,
    workspace_id: str | None = None,
    people_for_group: Callable[[str], dict[str, list[dict[str, Any]]]] | None = None,
    automation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the versioned, read-only Web Review projection.

    The projection intentionally omits Host filesystem paths, model/runtime
    settings, raw embeddings and production task controls. It combines
    canonical project facts, automatic mapping state and the current legacy
    manual review without becoming a new write authority.
    """

    project.reload_if_changed()
    workspace = str(workspace_id if workspace_id is not None else getattr(project, "workspace_id", "") or "")
    project_id = str(project.project_id)
    script = _as_dict(project.script)
    index = _as_dict(project.index)
    matches = _as_dict(project.matches)
    review = project.review.load()
    automation_payload = automation if isinstance(automation, dict) else AutomationStore(project.config.output_dir).load()
    automation_groups = _as_dict(automation_payload.get("groups"))
    segments_list = [item for item in _as_list(script.get("segments")) if isinstance(item, dict)]
    segments_list.sort(key=lambda item: (_int(item.get("episode"), 0), _int(item.get("order"), 0), str(item.get("segment_id", ""))))
    segments = {str(item.get("segment_id", "")): item for item in segments_list if item.get("segment_id")}
    groups = [item for item in _as_list(index.get("groups")) if isinstance(item, dict) and item.get("group_id")]
    groups.sort(key=lambda item: (_float(item.get("start"), 0.0), str(item.get("group_id", ""))))
    group_matches = _as_dict(matches.get("groups"))
    people = people_for_group or _people_loader(project)

    gap_codes: dict[str, list[dict[str, Any]]] = {}
    script_gaps: list[dict[str, Any]] = []
    for raw_gap in _as_list(matches.get("script_gaps")):
        if not isinstance(raw_gap, dict):
            continue
        gap = {
            "episode": _int(raw_gap.get("episode"), 0),
            "scene_id": str(raw_gap.get("scene_id", "") or ""),
            "start_order": _int(raw_gap.get("start_order"), 0),
            "end_order": _int(raw_gap.get("end_order"), 0),
            "segment_ids": [str(item) for item in _as_list(raw_gap.get("segment_ids")) if str(item)],
            "reason": str(raw_gap.get("reason", "") or ""),
        }
        script_gaps.append(gap)
        issue = {"code": "script_gap", "severity": "warning", "label": "剧本段尚无可靠素材对应"}
        for segment_id in gap["segment_ids"]:
            gap_codes.setdefault(segment_id, []).append(issue)

    episode_map: OrderedDict[int, OrderedDict[str, dict[str, Any]]] = OrderedDict()
    segment_scene: dict[str, tuple[int, str]] = {}
    for segment in segments_list:
        episode = _int(segment.get("episode"), 0)
        scene_id = str(segment.get("scene_id", "") or f"episode-{episode}-ungrouped")
        scenes = episode_map.setdefault(episode, OrderedDict())
        scene = scenes.setdefault(
            scene_id,
            {
                "scene_id": scene_id,
                "heading": "",
                "script_blocks": [],
                "take_group_ids": [],
            },
        )
        block = _script_block(segment, gap_codes)
        scene["script_blocks"].append(block)
        segment_scene[block["segment_id"]] = (episode, scene_id)
        if block["type"] == "scene_heading" and block["raw_text"]:
            scene["heading"] = block["raw_text"]

    analysis_revision = str(getattr(project, "analysis_revision", "") or "")
    automation_revision = str(automation_payload.get("analysis_revision", "") or "")
    automation_stale = bool(automation_revision and analysis_revision and automation_revision != analysis_revision)
    take_groups: list[dict[str, Any]] = []

    for group in groups:
        group_id = str(group.get("group_id", "") or "")
        row = _as_dict(group_matches.get(group_id))
        candidates = [
            _safe_candidate(candidate, segments, index_value)
            for index_value, candidate in enumerate(_as_list(row.get("candidates")))
            if isinstance(candidate, dict)
        ]
        automatic = _safe_automation(automation_groups.get(group_id))
        effective_mapping = _effective_mapping(review, _as_dict(automation_groups.get(group_id)), group, segments)
        angles = [
            _safe_angle(workspace, project_id, member)
            for member in _as_list(group.get("members"))
            if isinstance(member, dict)
        ]
        angles.sort(key=lambda item: (str(item.get("camera", "")), _float(item.get("timeline_start"), 0.0)))
        candidate_segment_ids = list(
            dict.fromkeys(
                segment_id
                for candidate in candidates
                for segment_id in candidate.get("script_segment_ids", [])
                if segment_id in segments
            )
        )
        context_segment_ids = [
            str(item) for item in _as_list(row.get("context_segment_ids")) if str(item) in segments
        ]
        context_episode_ids = sorted(
            {_int(item) for item in _as_list(row.get("context_episodes")) if _int(item) > 0}
            | {
                episode
                for candidate in candidates
                for episode in candidate.get("context_episodes", [])
                if _int(episode) > 0
            }
        )
        mapping_ids = [
            item for item in effective_mapping.get("script_segment_ids", []) if item in segments
        ]
        associated_ids = list(dict.fromkeys([*mapping_ids, *candidate_segment_ids, *context_segment_ids]))
        associated_scenes = list(
            dict.fromkeys(segment_scene[item] for item in associated_ids if item in segment_scene)
        )
        for episode, scene_id in associated_scenes:
            scene = episode_map.get(episode, {}).get(scene_id)
            if scene is not None and group_id not in scene["take_group_ids"]:
                scene["take_group_ids"].append(group_id)

        transcript = next(
            (candidate.get("transcript_text", "") for candidate in candidates if candidate.get("transcript_text")),
            "",
        )
        identity = people(group_id)
        take_groups.append(
            {
                "group_id": group_id,
                "parent_group_id": str(group.get("parent_group_id", "") or ""),
                "kind": str(group.get("kind", "multicam") or "multicam"),
                "take_index": _int(group.get("take_index"), 1),
                "split_reason": str(group.get("split_reason", "") or ""),
                "start": _float(group.get("start"), 0.0),
                "end": _float(group.get("end"), 0.0),
                "duration": _float(group.get("duration"), 0.0),
                "cameras": [str(item) for item in _as_list(group.get("cameras")) if str(item)],
                "angles": angles,
                "transcript": {"text": transcript, "source": "candidate" if transcript else "none"},
                "people": {
                    "faces": list(_as_list(_as_dict(identity).get("face"))),
                    "speakers": list(_as_list(_as_dict(identity).get("speaker"))),
                },
                "candidates": candidates,
                "context": {
                    "episode_ids": context_episode_ids,
                    "script_segment_ids": context_segment_ids,
                },
                "automatic_state": automatic,
                "editorial_state": {
                    "legacy_manual": _legacy_manual_state(review, group),
                    "individual_opinion": None,
                    "editorial_decision": None,
                },
                "effective_mapping": effective_mapping,
                "issues": _group_issues(automatic, angles, automation_stale=automation_stale),
            }
        )

    episodes = [
        {
            "episode": episode,
            "scenes": list(scenes.values()),
        }
        for episode, scenes in episode_map.items()
    ]
    review_payload = {
        "version": _int(review.get("version"), 2),
        "revision": _int(review.get("revision"), 0),
        "updated_at": str(review.get("updated_at", "") or ""),
        "assignments": _as_dict(review.get("assignments")),
        "groups": _as_dict(review.get("groups")),
        "clips": _as_dict(review.get("clips")),
        "placements": _as_dict(review.get("placements")),
    }
    stats = {
        str(key): value
        for key, value in _as_dict(index.get("stats")).items()
        if isinstance(value, (int, float, bool))
    }
    local_media = _as_dict(project.project_payload().get("local_media"))
    safe_local_media = {
        key: _int(local_media.get(key), 0)
        for key in ("total", "resolved", "missing")
        if key in local_media
    }
    project_issues: list[dict[str, Any]] = []
    if automation_stale:
        project_issues.append(
            {"code": "automation_stale", "severity": "warning", "label": "自动决策需要按当前分析刷新"}
        )

    return {
        "contract_version": CONTRACT_VERSION,
        "project": {
            "project_id": project_id,
            "name": str(project.config.name),
            "input_kind": str(project.config.input_kind),
            "stats": stats,
            "local_media": safe_local_media,
            "issues": project_issues,
        },
        "revisions": {
            "analysis": analysis_revision,
            "automation_analysis": automation_revision,
            "automation_updated_at": str(automation_payload.get("updated_at", "") or ""),
            "review": _int(review.get("revision"), 0),
        },
        "capabilities": {
            "legacy_review_v2": True,
            "individual_opinions": False,
            "editorial_decision": False,
            "production_controls": False,
            "host_paths": False,
        },
        "summary": {
            "automation": _as_dict(automation_payload.get("summary")),
            "script_gaps": len(script_gaps),
            "take_groups": len(take_groups),
            "episodes": len(episodes),
        },
        "episodes": episodes,
        "take_groups": take_groups,
        "script_gaps": script_gaps,
        "review_state": {
            "legacy_review": review_payload,
            "individual_opinions": [],
            "editorial_decisions": {},
        },
    }


def install_review_read_model_runtime() -> None:
    """Expose review.v1 without changing the existing review write authority."""

    global _INSTALLED
    if _INSTALLED:
        return
    from . import web_server

    original_make_handler = web_server.make_handler

    def make_handler_with_review_model(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "review-model"
                ):
                    project_id = parts[3]
                    project = service.project(project_id)
                    self._send_json(build_review_read_model(project))
                    return
                return super()._app_get(parsed)

        return Handler

    web_server.make_handler = make_handler_with_review_model
    _INSTALLED = True
