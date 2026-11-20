"""Resolve a Desktop question against the current project's published read models."""
from __future__ import annotations

from math import ceil
from pathlib import PurePosixPath, PureWindowsPath
from typing import Any

from .media_identity import DeviceMediaStore
from .media_inventory_task_runtime import inventory_payload
from .media_role_store import MediaRoleStore
from .sync_timeline_runtime import build_sync_delivery_artifacts, build_sync_timeline


def _name(value: object) -> str:
    return PurePosixPath(str(value or "").replace("\\", "/")).name[:300]


def _detail(value: object) -> str:
    # Task logs may contain device paths. Leave those details in the local task view.
    text = str(value or "").strip()
    return text[:240] if "/" not in text and "\\" not in text else ""


def _diagnosis(timeline: dict, delivery: dict) -> dict[str, str]:
    if not timeline["ready"]:
        task = timeline.get("task") or {}
        notes = [_detail(timeline["message"]) if timeline["phase"] == "running" else timeline["message"]]
        for key in ("stage", "error", "message"):
            value = _detail(task.get(key))
            if value and value not in notes:
                notes.append(value)
        return {"summary": " ".join(filter(None, notes)) or "请查看同步任务的最近记录。",
                "destination": "sync-task"}
    reasons = {
        "media_roots_unbound": "本机素材目录未登记",
        "unexpected_location": "交付文件的位置待确认",
        "file_missing": "登记的交付文件未找到",
        "not_generated": "尚未生成交换文件",
    }
    by_reason: dict[str, list[str]] = {}
    for item in delivery.get("artifacts", []):
        if not item["available"]:
            by_reason.setdefault(item["unavailable_reason"], []).append(item["label"])
    notes = [f"同步母版已就绪，共 {timeline['clip_count']} 条视频。"]
    for reason, labels in by_reason.items():
        notes.append(f"{'、'.join(labels)}：{reasons.get(reason, '交换文件暂不可用')}。")
    if not by_reason:
        notes.append("交付清单中的交换文件可在本机打开。")
    return {"summary": "".join(notes),
            "destination": "media-binding" if "media_roots_unbound" in by_reason else "sync-delivery"}


def _requested(raw: dict, key: str) -> str:
    value = raw.get(key)
    if value is None or value == "":
        return ""
    if not isinstance(value, str) or len(value) > 512 or value.startswith(("/", "\\")) or PureWindowsPath(value).is_absolute():
        raise ValueError("选区标识无效，请重新选择素材。")
    return value


def _read_sync_position(timeline: dict, raw: dict, clip_id: str, selection: dict, facts: dict) -> str:
    camera = _requested(raw, "camera")
    track = next((track for track in timeline.get("tracks", []) if track["camera"] == camera), None)
    task_id = (timeline.get("task") or {}).get("task_id")
    requested_task = _requested(raw, "sync_task_id")
    if track is None or (requested_task and requested_task != task_id):
        raise ValueError("同步结果已变化，请在当前母版重新选择机位。")
    selection["camera"] = camera
    if task_id:
        selection["sync_task_id"] = task_id
    frame = raw.get("playhead_frame")
    rate = timeline.get("timebase") or {}
    seconds = None
    if frame is not None:
        if type(frame) is not int or frame < 0 or rate.get("status") != "confirmed":
            raise ValueError("当前母版无法确认提问位置的帧数。")
        if frame >= ceil(timeline["duration_seconds"] * rate["numerator"] / rate["denominator"]):
            raise ValueError("提问位置超出当前母版。")
        seconds = frame * rate["denominator"] / rate["numerator"]
        selection.update(playhead_frame=frame, timebase=[rate["numerator"], rate["denominator"]])
    sync_id = _requested(raw, "sync_clip_id")
    candidates = [item for item in track["clips"] if seconds is None or
                  item["timeline_start"] <= seconds < item["timeline_start"] + item["duration"]]
    if sync_id:
        matches = [item for item in candidates if item["clip_id"] == sync_id]
        if len(matches) != 1 or (clip_id and matches[0]["media_clip_id"] != clip_id):
            raise ValueError("当前母版无法确认所选片段，请重新定位。")
        item = matches[0]
        selection["sync_clip_id"] = sync_id
        clip_id = item["media_clip_id"]
        facts.update(name=_name(item["name"]), source_timecode=item["timecode"])
    elif clip_id or (seconds is not None and candidates):
        raise ValueError("提问位置的机位素材已变化，请重新定位。")
    else:
        facts["position_note"] = ("当前机位在所选位置没有片段。" if seconds is not None
                                  else "当前选区没有源片段，母版时间基待确认。")
    return clip_id


def _read_selected_material(project: Any, page: str, group_id: str, clip_id: str, media_id: str,
                            selection: dict, facts: dict) -> None:
    members = []
    if group_id:
        group = project.groups.get(group_id)
        if group is None:
            raise ValueError("当前项目中已找不到所选 Take。")
        selection["group_id"] = group_id
        members = group.get("members") or []
        facts["cameras"] = group.get("cameras") or []
    inventory_item = None
    if media_id:
        inventory = inventory_payload(project, DeviceMediaStore(create=False), MediaRoleStore(project.config.output_dir))
        inventory_item = next((row for row in inventory["items"] if row["media_id"] == media_id), None)
        if inventory_item is None or (page == "media-library" and clip_id and clip_id != inventory_item.get("clip_id")):
            raise ValueError("当前素材清单与选区不一致，请刷新素材库。")
        selection["media_id"] = media_id
        facts.update(
            name=_name(inventory_item["display_name"]),
            camera=inventory_item["label"].get("camera_override") or inventory_item["inferred_camera"],
            media_state=inventory_item.get("state"),
        )
        if page == "media-library":
            clip_id = clip_id or inventory_item.get("clip_id", "")
    if group_id and media_id and not clip_id and not any(item.get("media_id") == media_id for item in members):
        raise ValueError("当前 Take 中找不到所选媒体。")
    if clip_id:
        member = next((item for item in members if item.get("clip_id") == clip_id), None)
        clip = member or project.clips.get(clip_id)
        inventory_match = inventory_item and inventory_item.get("clip_id") == clip_id
        if clip is None and inventory_match:
            clip = inventory_item
        if clip is None or (group_id and not member):
            raise ValueError("当前项目无法确认所选 Take 与片段的关联。")
        if media_id and not inventory_match and clip.get("media_id") != media_id:
            raise ValueError("所选片段的媒体身份已变化，请重新选择。")
        selection["clip_id"] = clip_id
        facts.setdefault("name", _name(clip.get("name")))
        facts.setdefault("camera", clip.get("camera"))


def resolve_question_context(project: Any, tasks: list, raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict) or raw.get("project_id") != project.project_id:
        raise ValueError("提问的项目已切换，请在当前项目重新提问。")
    page = raw.get("page")
    if page not in ("sync-task", "sync-inspect", "sync-delivery", "media-library", "media-binding",
                    "takes", "slate", "identity", "script", "timeline", "watch"):
        raise ValueError("提问的页面不可用。")
    project.reload_if_changed()
    selection: dict[str, Any] = {}
    facts: dict[str, Any] = {}
    result = {"project_id": project.project_id, "page": page, "selection": selection,
              "facts": facts, "label": project.config.name or project.project_id,
              "analysis_revision": project.analysis_revision}
    if project.config.is_media_directory:
        timeline = build_sync_timeline(project, tasks)
        delivery = build_sync_delivery_artifacts(project, tasks) if timeline["ready"] else {}
        result["diagnosis"] = _diagnosis(timeline, delivery)
    else:
        timeline = {}

    group_id, clip_id, media_id = (_requested(raw, key) for key in ("group_id", "clip_id", "media_id"))
    if page == "sync-inspect" and _requested(raw, "camera"):
        clip_id = _read_sync_position(timeline, raw, clip_id, selection, facts)
    _read_selected_material(project, page, group_id, clip_id, media_id, selection, facts)
    segment_id = _requested(raw, "script_segment_id")
    if segment_id:
        segment = project.segments.get(segment_id)
        if segment is None:
            raise ValueError("当前剧本中已找不到所选段落。")
        selection["script_segment_id"] = segment_id
        facts["script_text"] = str(segment.get("raw_text") or segment.get("text") or "")[:600]

    camera = selection.get("camera") or facts.get("camera")
    labels = [facts.get("name") or clip_id or media_id or (f"Take {group_id}" if group_id else ""),
              f"{camera} 机位" if camera else ""]
    if "playhead_frame" in selection:
        labels.append(f"母版第 {selection['playhead_frame']} 帧（从 0 计）")
    if segment_id:
        labels.append(segment_id)
    result["label"] = " · ".join(filter(None, labels)) or result["label"]
    return result
