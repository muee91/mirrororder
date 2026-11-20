from __future__ import annotations

import csv
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterable
from .timebase import fcpxml_project_timebase, first_frame_at_or_after


CONTRACT_VERSION = "multicam_sync_timeline.v1"
_MAX_EXACT_FRAME = 2**53 - 1


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _text(value: object) -> str:
    return str(value or "").strip()


def _number(value: object, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def _timestamp(task: dict[str, Any]) -> float:
    for key in ("completed_at", "started_at", "created_at"):
        value = _text(task.get(key))
        if not value:
            continue
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
    return 0.0


def _latest_sync_task(tasks: Iterable[object]) -> dict[str, Any] | None:
    candidates = [
        task
        for task in tasks
        if isinstance(task, dict) and _text(task.get("type")) in {"multicam_sync", "prepare_project"}
    ]
    if not candidates:
        return None
    return max(candidates, key=_timestamp)


def _safe_task(task: dict[str, Any] | None) -> dict[str, Any] | None:
    if not task:
        return None
    return {
        "task_id": _text(task.get("task_id")),
        "status": _text(task.get("status")),
        "cancel_requested": bool(task.get("cancel_requested")),
        "stage": _text(task.get("stage")),
        "message": _text(task.get("message")),
        "progress": _as_dict(task.get("progress")),
        "created_at": _text(task.get("created_at")),
        "started_at": _text(task.get("started_at")),
        "completed_at": _text(task.get("completed_at")),
        "updated_at": _text(task.get("updated_at")),
        "error": _text(task.get("error")),
    }


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _media_index_ready(config: Any) -> bool:
    index = _read_json(Path(config.output_dir) / "material_index.json")
    return bool(index.get("clips") or index.get("groups"))


def _status_for(
    task: dict[str, Any] | None,
    report: dict[str, Any],
    sync_file: Path,
    media_index_ready: bool,
) -> tuple[str, bool, str]:
    if task is None:
        return (
            "required",
            False,
            "同步任务尚未开始。可先在素材库检查源文件，再从「同步任务」开始同步。",
        )
    status = _text(task.get("status"))
    if status in {"queued", "running"}:
        return ("running", False, _text(task.get("message")) or "正在进行多机位同步。完成后可打开同步核对和工程交付。")
    if status == "completed":
        if report.get("sync_task_id") and report["sync_task_id"] != task.get("task_id"):
            return "invalid", False, "当前任务与已保存母版的版本不一致。"
        if _as_dict(report.get("camera_detection")).get("contract_version") != "camera_detection.v2":
            return ("invalid", False, "此同步结果使用旧机位识别规则；请重新同步，补齐 D/E/F 等机位并排除静态图片。")
        if _text(report.get("status")) == "completed" and sync_file.is_file() and media_index_ready:
            return ("completed", True, "多机位同步已完成；下面显示全部机位的同步排列。")
        if _text(report.get("status")) == "completed" and sync_file.is_file():
            return ("invalid", False, "同步位置表已生成，但媒体身份索引未发布；请重新执行多机位同步。")
        return ("invalid", False, "同步任务记录已完成，但同步产物不可用；请重新执行多机位同步。")
    if status == "cancelled":
        return ("cancelled", False, "上一次多机位同步已取消。可在「同步任务」重新开始。")
    if status == "interrupted":
        return ("interrupted", False, "上一次多机位同步被中断。可在「同步任务」重新开始。")
    if status == "failed":
        return ("failed", False, "上一次多机位同步失败。可在状态中心查看详情，在「同步任务」重试。")
    return ("required", False, "尚未完成多机位同步。可在「同步任务」查看进度。")



def _indexed_media_clips(index: dict[str, Any]) -> dict[str, str]:
    """Map sync FCPXML asset IDs to *indexed* playback clip IDs.

    The vendor positions file uses temporary v2_* identifiers, not Host
    clip_id. Never send those identifiers to /media. The FCPXML builder assigns
    day_{day}_asset_{row_number}, which survives into the material index as
    source_asset_id. Different occurrences of the same asset may yield several
    clip IDs; only one unambiguous content identity is safe to preview.
    """
    by_asset: dict[str, list[tuple[str, str]]] = {}
    for item in _as_list(index.get("clips")):
        if not isinstance(item, dict):
            continue
        asset = _text(item.get("source_asset_id"))
        clip_id = _text(item.get("clip_id"))
        media_id = _text(item.get("media_id"))
        if asset.startswith("day_") and "_asset_" in asset and clip_id and media_id.startswith("M_"):
            by_asset.setdefault(asset, []).append((media_id, clip_id))
    result: dict[str, str] = {}
    for asset, refs in by_asset.items():
        if len({media_id for media_id, _clip_id in refs}) == 1:
            result[asset] = min(clip_id for _media_id, clip_id in refs)
    return result


def _read_tracks(work: Path, days: list[str], media_clips: dict[str, str] | None = None) -> tuple[list[dict[str, Any]], float, list[str]]:
    rows_by_day: list[tuple[str, list[dict[str, str]]]] = []
    for day in days:
        path = work / f"positions_{day}_compressed.tsv"
        try:
            with path.open(encoding="utf-8", newline="") as handle:
                rows = [dict(row) for row in csv.DictReader(handle, delimiter="\t")]
            # The first-party FCPXML builder does sort_values(["cam", "pos"])
            # before allocating day_{day}_asset_{row_number}.  Indexing the
            # un-sorted TSV silently links a playable preview to the wrong
            # physical file when bad camera TC changes the order.
            rows.sort(key=lambda row: (_text(row.get("cam")) or "?", _number(row.get("pos"))))
        except (OSError, UnicodeError, csv.Error):
            return [], 0.0, []
        rows_by_day.append((day, rows))

    tracks: dict[str, list[dict[str, Any]]] = {}
    track_order: list[str] = []
    shift = 0.0
    max_end = 0.0
    for day, rows in rows_by_day:
        valid_rows: list[tuple[int, dict[str, str], float, float]] = []
        for row_number, row in enumerate(rows):
            camera = _text(row.get("cam")) or "?"
            position = _number(row.get("pos"))
            duration = _number(row.get("dur"))
            if duration <= 0:
                continue
            valid_rows.append((row_number, row, position, duration))
            if camera not in tracks:
                tracks[camera] = []
                track_order.append(camera)
        if not valid_rows:
            return [], 0.0, []
        day_start = min(position for _index, _row, position, _duration in valid_rows)
        day_end = max(position + duration for _index, _row, position, duration in valid_rows)
        for row_number, row, position, duration in valid_rows:
            start = max(0.0, position - day_start + shift)
            tracks[_text(row.get("cam")) or "?"].append(
                {
                    "clip_id": _text(row.get("id")),
                    "day": day,
                    "camera": _text(row.get("cam")) or "?",
                    "name": _text(row.get("file")) or "未命名素材",
                    "timeline_start": start,
                    "duration": duration,
                    "timecode": _text(row.get("tc")),
                    "clip_number": _text(row.get("clipn")),
                    "media_clip_id": (media_clips or {}).get(f"day_{day}_asset_{row_number}", ""),
                }
            )
            max_end = max(max_end, start + duration)
        shift += max(0.0, day_end - day_start)

    ordered_tracks = []
    for camera in sorted(track_order, key=lambda value: (value == "?", value)):
        if camera not in tracks or any(item.get("camera") == camera for item in ordered_tracks):
            continue
        clips = sorted(tracks[camera], key=lambda item: (float(item["timeline_start"]), item["day"], item["name"]))
        ordered_tracks.append({
            "track_id": f"video:{camera}",
            "kind": "video",
            "camera": camera,
            "label": f"{camera} 机位" if camera != "?" else "未分类机位",
            "clip_count": len(clips),
            "clips": clips,
        })
    return ordered_tracks, max_end, [str(item["camera"]) for item in ordered_tracks if item["camera"] != "?"]


def _review_gaps(tracks: list[dict[str, Any]], timebase: dict[str, Any]) -> list[dict[str, int]]:
    """Find whole empty frames between spans of video coverage on the master."""
    if timebase["status"] != "confirmed":
        return []
    numerator, denominator = timebase["numerator"], timebase["denominator"]
    if max(numerator, denominator) > _MAX_EXACT_FRAME:
        return []
    fps = numerator / denominator

    spans = []
    for track in tracks:
        if track["kind"] != "video":
            continue
        for clip in track["clips"]:
            start = clip["timeline_start"]
            end = start + clip["duration"]
            if not 0 <= start < end or not end * fps < _MAX_EXACT_FRAME:
                return []
            # The monitor samples each frame at its start, inside [clip start, clip end).
            begin = first_frame_at_or_after(start, numerator, denominator)
            finish = first_frame_at_or_after(end, numerator, denominator)
            spans.append((begin, max(begin + 1, finish)))

    gaps = []
    covered_until = None
    for start, end in sorted(spans):
        if covered_until is not None and start > covered_until:
            gaps.append({"start_frame": covered_until, "end_frame": start})
        covered_until = max(covered_until or 0, end)
    return gaps


def sync_recordings(report: dict[str, Any], task_id: str) -> dict[str, Any] | None:
    inventory = _as_dict(report.get("recording_inventory"))
    alignment = _as_dict(report.get("recording_alignment"))
    if not inventory and not alignment:
        return None
    placements = []
    if task_id and alignment.get("sync_task_id") == task_id and alignment.get("status") == "confirmed":
        for value in _as_list(alignment.get("placements")):
            row = _as_dict(value)
            media_id = _text(row.get("media_id"))
            if not re.fullmatch(r"M_[0-9a-f]{24}", media_id):
                continue
            at, source, frames = (row.get(key) for key in ("at", "source", "frames"))
            if any(type(frame) is not int or frame < 0 for frame in (at, source, frames)) or frames == 0:
                continue
            placements.append({
                "media_id": media_id,
                "name": Path(_text(row.get("name")).replace(chr(92), "/")).name or media_id,
                "at": at, "source": source, "frames": frames,
            })
    candidates = [_as_dict(row) for row in _as_list(inventory.get("candidates"))]
    known = {row["media_id"] for row in placements}
    return {
        "candidate_count": len(candidates),
        "unplaced_count": sum(row.get("media_id") not in known for row in candidates),
        "invalid_count": sum(row.get("status") != "unverified_candidate" for row in candidates),
        "placements": placements,
    }


def _snapshot_path(config: Any, task_id: str) -> Path | None:
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,96}", task_id):
        return None
    return config.output_dir / "sync" / "masters" / f"{task_id}.json"


def build_sync_timeline(project: Any, tasks: Iterable[object]) -> dict[str, Any]:
    config = project.config
    project_id = _text(getattr(project, "project_id", ""))
    if not bool(getattr(config, "is_media_directory", False)):
        return {
            "contract_version": CONTRACT_VERSION,
            "project_id": project_id,
            "phase": "not-required",
            "ready": True,
            "message": "FCPXML 项目已有时间线，不需要再做多机位同步。",
            "task": None,
            "tracks": [],
            "cameras": [],
            "clip_count": 0,
            "duration_seconds": 0,
        }

    task_history = list(tasks)
    latest_task = _latest_sync_task(task_history)
    report_path = config.output_dir / "sync" / "sync_report.json"
    sync_file = config.output_dir / "sync" / "synchronized.fcpxml"
    report = _read_json(report_path)
    media_index = _read_json(Path(config.output_dir) / "material_index.json")
    phase, ready, message = _status_for(latest_task, report, sync_file, bool(media_index.get("clips") or media_index.get("groups")))
    tracks: list[dict[str, Any]] = []
    duration_seconds = 0.0
    cameras: list[str] = []
    if ready:
        days = [str(item) for item in _as_list(report.get("days")) if str(item)]
        tracks, duration_seconds, cameras = _read_tracks(
            config.output_dir / ".multicam-sync" / "work", days,
            _indexed_media_clips(media_index),
        )
        if not tracks:
            phase, ready, message = (
                "invalid",
                False,
                "同步产物缺少一个或多个拍摄日的可读轨道位置表；请重新执行多机位同步。",
            )

    if ready and report.get("recording_inventory"):
        message += " " + " ".join(str(row.get("message", "")) for row in report.get("diagnostics", []) if isinstance(row, dict))

    timebase = fcpxml_project_timebase(sync_file) if ready else {
        "status": "unknown", "source": "fcpxml_sequence", "reason": "sync_not_ready",
    }
    previous = None
    if not ready:
        completed = _latest_sync_task(row for row in task_history if isinstance(row, dict) and row.get("status") == "completed")
        completed_id = _text(completed.get("task_id")) if completed else ""
        snapshot_path = _snapshot_path(config, completed_id)
        cached = _read_json(snapshot_path) if snapshot_path else {}
        cached_timeline = _as_dict(cached.get("timeline"))
        if (cached_timeline.get("ready") is True and cached_timeline.get("project_id") == project_id
                and _as_dict(cached_timeline.get("task")).get("task_id") == completed_id):
            previous = cached
    return {
        "contract_version": CONTRACT_VERSION,
        "project_id": project_id,
        "phase": phase,
        "ready": ready,
        "message": message,
        "task": _safe_task(latest_task),
        "recordings": sync_recordings(report, _text(latest_task.get("task_id"))) if ready and latest_task else None,
        "tracks": tracks,
        "cameras": cameras,
        "clip_count": sum(int(track.get("clip_count", 0) or 0) for track in tracks),
        "duration_seconds": duration_seconds,
        "timebase": timebase,
        "review_gaps": _review_gaps(tracks, timebase),
        "previous_master": previous,
    }


SYNC_DELIVERY_CONTRACT = "sync_delivery_artifacts.v1"


def cache_previous_sync_timeline(config: Any, project_id: str, tasks: Iterable[dict[str, Any]]) -> None:
    """Keep the last verified read model before the engine starts replacing working inputs."""
    from .media_identity import _atomic_json

    previous = _latest_sync_task(task for task in tasks if task.get("status") == "completed")
    if previous is None:
        return
    path = _snapshot_path(config, _text(previous.get("task_id")))
    if path is None or path.is_file():
        return
    result = build_sync_timeline(SimpleNamespace(config=config, project_id=project_id), [previous])
    if result["ready"]:
        result.pop("previous_master", None)
        _atomic_json(path, {
            "timeline": result,
            "read_at_ms": int(datetime.now(timezone.utc).timestamp() * 1000),
        })


def build_sync_delivery_artifacts(project: Any, tasks: Iterable[object]) -> dict[str, Any]:
    """Local-only *read* of files the sync worker already generated.

    Do not generate new material from a GET, and do not expose device paths
    through the agent-facing sync-timeline read model. Even a compromised
    sync_report.json cannot point the UI at arbitrary files: the candidate must
    match a known filename within this project's local media export folder.
    """
    config = project.config
    output = Path(config.output_dir)
    report = _read_json(output / "sync" / "sync_report.json")
    task = _latest_sync_task(tasks)
    index_ready = _media_index_ready(config)
    synced_file = output / "sync" / "synchronized.fcpxml"
    phase, ready, _message = _status_for(task, report, synced_file, index_ready)
    ready = bool(getattr(config, "is_media_directory", False)) and ready and phase == "completed"

    roots = tuple(getattr(config, "media_roots", ()) or ())
    if not roots and getattr(config, "media_root", None):
        roots = (config.media_root,)
    version = _text(report.get("delivery_version"))
    export_dirs = {Path(root).resolve() / "交付" for root in roots}
    if version:
        export_dirs = {directory / f"同步-{version}" for directory in export_dirs} if re.fullmatch(r"[0-9a-f]{32}", version) else set()

    def safe_file(field: str, expected_name: str) -> tuple[str, str]:
        if not ready:
            return "", "sync_not_ready"
        raw = _text(report.get(field))
        if not raw:
            return "", "not_generated"
        if not roots:
            return "", "media_roots_unbound"
        try:
            candidate = Path(raw).resolve()
            if candidate.name != expected_name or candidate.parent not in export_dirs:
                return "", "unexpected_location"
            if candidate.is_file():
                return str(candidate), ""
        except (OSError, RuntimeError, ValueError):
            return "", "unexpected_location"
        return "", "file_missing"

    kinds = (
        ("premiere", "Premiere Pro", "premiere_xml", "synchronized_premiere.xml", "FCP7 XML"),
        ("final-cut", "Final Cut Pro", "fcpxml", "synchronized.fcpxml", "FCPXML"),
        ("jianying", "剪映专业版", "capcut_fcpxml", "synchronized_capcut.fcpxml", "FCPXML"),
    )
    from .nle_delivery.resolve_delivery import resolve_artifact

    files = [resolve_artifact(project, task, ready)]
    for target, label, key, filename, format_name in kinds:
        local_path, unavailable_reason = safe_file(key, filename)
        files.append({
            "target": target,
            "label": label,
            "format": format_name + (" · 视频/机内参考声，未写入独立录音" if report.get("recording_inventory") else ""),
            "filename": filename,
            "available": bool(local_path),
            "local_path": local_path,
            "unavailable_reason": unavailable_reason,
        })
    return {
        "contract": SYNC_DELIVERY_CONTRACT,
        "project_id": _text(getattr(project, "project_id", "")),
        "ready": ready,
        "paths_scope": "localhost_response_only",
        "artifacts": files,
        "sync_version": version,
        "validation": "generated_files_only_nle_round_trip_not_verified",
    }


__all__ = ["CONTRACT_VERSION", "build_sync_timeline", "build_sync_delivery_artifacts"]
