from __future__ import annotations

import csv
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


CONTRACT_VERSION = "multicam_sync_timeline.v1"


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
    return result if result >= 0 else default


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
        if isinstance(task, dict) and _text(task.get("type")) == "multicam_sync"
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
            "导入素材必须先完成多机位同步；完成后才能进入剧本、素材和审阅工作区。",
        )
    status = _text(task.get("status"))
    if status in {"queued", "running"}:
        return ("running", False, _text(task.get("message")) or "正在进行多机位同步；完成后时间线会自动解锁。")
    if status == "completed":
        if _as_dict(report.get("camera_detection")).get("contract_version") != "camera_detection.v2":
            return ("invalid", False, "此同步结果使用旧机位识别规则；请重新同步，补齐 D/E/F 等机位并排除静态图片。")
        if _text(report.get("status")) == "completed" and sync_file.is_file() and media_index_ready:
            return ("completed", True, "多机位同步已完成；下面显示全部机位的同步排列。")
        if _text(report.get("status")) == "completed" and sync_file.is_file():
            return ("invalid", False, "同步位置表已生成，但媒体身份索引未发布；请重新执行多机位同步。")
        return ("invalid", False, "同步任务记录已完成，但同步产物不可用；请重新执行多机位同步。")
    if status == "cancelled":
        return ("cancelled", False, "上一次多机位同步已取消；请在时间线中重新开始。")
    if status == "interrupted":
        return ("interrupted", False, "上一次多机位同步被中断；请在时间线中重新开始。")
    if status == "failed":
        return ("failed", False, "上一次多机位同步失败；请在时间线中重试并查看状态中心详情。")
    return ("required", False, "尚未完成多机位同步；请先从时间线开始。")



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
        if not path.is_file():
            continue
        try:
            with path.open(encoding="utf-8", newline="") as handle:
                rows = [dict(row) for row in csv.DictReader(handle, delimiter="\t")]
        except (OSError, UnicodeError, csv.Error):
            continue
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
            continue
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

    latest_task = _latest_sync_task(tasks)
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
                "同步产物缺少可读的轨道位置表；请重新执行多机位同步。",
            )

    return {
        "contract_version": CONTRACT_VERSION,
        "project_id": project_id,
        "phase": phase,
        "ready": ready,
        "message": message,
        "task": _safe_task(latest_task),
        "tracks": tracks,
        "cameras": cameras,
        "clip_count": sum(int(track.get("clip_count", 0) or 0) for track in tracks),
        "duration_seconds": duration_seconds,
    }


__all__ = ["CONTRACT_VERSION", "build_sync_timeline"]
