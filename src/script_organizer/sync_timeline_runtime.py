from __future__ import annotations

import csv
import json
import math
import os
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
        # Portable projects intentionally omit device-local task history.
        # A versioned completed sync report and materialized XML/index still
        # describe a saved master; track rows are validated below.
        if (
            _text(report.get("sync_task_id"))
            and _text(report.get("status")) == "completed"
            and _as_dict(report.get("camera_detection")).get("contract_version") == "camera_detection.v2"
            and sync_file.is_file()
            and media_index_ready
        ):
            return ("completed", True, "已读取项目保存的多机位同步母版。")
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
    candidates = []
    for value in _as_list(inventory.get("candidates")):
        row = _as_dict(value)
        media_id = _text(row.get("media_id"))
        if not re.fullmatch(r"M_[0-9a-f]{24}", media_id):
            continue
        candidate = {
            "media_id": media_id,
            "name": Path(_text(row.get("name")).replace(chr(92), "/")).name or media_id,
            "status": _text(row.get("status")) or "unsupported_or_unreadable_audio",
            "sample_rate": row.get("sample_rate"),
            "sample_count": row.get("sample_count"),
            "channels": row.get("channels"),
            "audio_role_hint": _as_dict(row.get("audio_role_hint")),
            "clock_hint": _as_dict(row.get("clock_hint")),
        }
        candidates.append(candidate)
    known = {row["media_id"] for row in placements}
    return {
        "candidate_count": len(candidates),
        "unplaced_count": sum(row.get("media_id") not in known for row in candidates),
        "invalid_count": sum(row.get("status") != "unverified_candidate" for row in candidates),
        "candidates": candidates,
        "placements": placements,
        "alignment_revision": int(_number(_as_dict(report.get("recording_alignment")).get("revision"), 0)),
    }


def sync_recording_summary(report: dict[str, Any], task_id: str) -> dict[str, Any]:
    """Expose whether independent audio has evidence in this sync revision."""
    inventory = _as_dict(report.get("recording_inventory"))
    if not inventory:
        return {
            "status": "not_scanned",
            "candidate_count": 0,
            "placed_count": 0,
            "unplaced_count": 0,
            "invalid_count": 0,
        }

    recordings = sync_recordings(report, task_id) or {
        "candidate_count": 0,
        "unplaced_count": 0,
        "invalid_count": 0,
        "placements": [],
    }
    candidate_count = int(recordings.get("candidate_count", 0) or 0)
    placed_count = len(_as_list(recordings.get("placements")))
    unplaced_count = int(recordings.get("unplaced_count", 0) or 0)
    invalid_count = int(recordings.get("invalid_count", 0) or 0)
    alignment = _as_dict(report.get("recording_alignment"))
    alignment_current = (
        alignment.get("status") == "confirmed"
        and bool(task_id)
        and _text(alignment.get("sync_task_id")) == task_id
    )
    if candidate_count == 0:
        status = "no_candidates"
    elif alignment_current and unplaced_count == 0 and invalid_count == 0:
        status = "confirmed"
    elif alignment_current:
        status = "partial"
    else:
        status = "unconfirmed"
    return {
        "status": status,
        "candidate_count": candidate_count,
        "placed_count": placed_count,
        "unplaced_count": unplaced_count,
        "invalid_count": invalid_count,
        "sync_task_id": _text(alignment.get("sync_task_id")),
        "alignment_revision": int(_number(alignment.get("revision"), 0)),
    }


def confirm_sync_recording_placement(project: Any, tasks: Iterable[object], body: object = None) -> dict[str, Any]:
    """Promote one human-confirmed original WAV placement into this sync revision.

    The only input that becomes shared sync authority is the media identity and
    the master playhead location confirmed by the operator. Device creation
    time, filename timestamps and another NLE project remain evidence hints.
    """
    from .media_identity import DeviceMediaStore, _atomic_json

    if not isinstance(body, dict):
        raise ValueError("录音确认参数必须是对象")
    timeline = build_sync_timeline(project, tasks)
    if not timeline.get("ready"):
        raise ValueError("同步母版尚未就绪，无法确认录音摆位")
    task_id = _text(_as_dict(timeline.get("task")).get("task_id"))
    if not task_id:
        raise ValueError("缺少当前同步母版版本标识")
    report_path = Path(project.config.output_dir) / "sync" / "sync_report.json"
    report = _read_json(report_path)
    inventory = _as_dict(report.get("recording_inventory"))
    candidates = {
        _text(row.get("media_id")): _as_dict(row)
        for row in _as_list(inventory.get("candidates"))
        if _text(row.get("media_id"))
    }
    media_id = _text(body.get("media_id"))
    if not re.fullmatch(r"M_[0-9a-f]{24}", media_id):
        raise ValueError("录音 media_id 无效")
    candidate = candidates.get(media_id)
    if not candidate or candidate.get("status") != "unverified_candidate":
        raise ValueError("该 WAV 不是当前同步版本的可确认候选")
    role = _as_dict(candidate.get("audio_role_hint"))
    if role and role.get("sync_eligible") is False:
        raise ValueError("该音频已标记为音乐或音效，不能放入同期声轨")

    at = body.get("at")
    source = body.get("source", 0)
    if type(at) is not int or at < 0 or type(source) is not int or source < 0:
        raise ValueError("录音摆位必须使用非负整数帧")
    sample_rate = candidate.get("sample_rate")
    sample_count = candidate.get("sample_count")
    if type(sample_rate) is not int or sample_rate <= 0 or type(sample_count) is not int or sample_count <= 0:
        raise ValueError("当前 WAV 缺少可用时长")
    timebase = _as_dict(timeline.get("timebase"))
    if timebase.get("status") != "confirmed":
        raise ValueError("同步母版时间基尚未确认")
    numerator = int(timebase.get("numerator", 0) or 0)
    denominator = int(timebase.get("denominator", 0) or 0)
    if numerator <= 0 or denominator <= 0:
        raise ValueError("同步母版时间基无效")
    from fractions import Fraction

    frames = int(round(float(Fraction(sample_count, sample_rate) * Fraction(numerator, denominator))))
    if body.get("frames") is not None and body.get("frames") != frames:
        raise ValueError("录音时长与源文件不一致")
    source_samples = int(round(float(Fraction(source, 1) * sample_rate * Fraction(denominator, numerator))))
    if frames <= 0 or source_samples < 0 or source_samples >= sample_count:
        raise ValueError("录音源内位置无效")
    master_frames = int(round(max(0.0, _number(timeline.get("duration_seconds"))) * numerator / denominator))
    if master_frames <= 0 or at + frames > master_frames:
        raise ValueError("录音摆位超出同步母版范围")

    alignment = _as_dict(report.get("recording_alignment"))
    current_task = _text(alignment.get("sync_task_id"))
    if current_task and current_task != task_id:
        alignment = {}
    expected = body.get("expected_revision")
    revision = int(_number(alignment.get("revision"), 0))
    if expected is not None and int(expected) != revision:
        raise ValueError(f"录音摆位版本冲突（期望 r{expected}，当前 r{revision}），请刷新后重试")
    name = Path(_text(candidate.get("name")).replace(chr(92), "/")).name or media_id
    placements = []
    replaced = False
    for value in _as_list(alignment.get("placements")):
        row = _as_dict(value)
        if _text(row.get("media_id")) == media_id:
            if not replaced:
                placements.append({
                    "media_id": media_id, "name": name, "track": "原录音_" + media_id,
                    "at": at, "source": source, "frames": frames,
                    "source_kind": "original", "timing_basis": "original_unretimed",
                    "source_rate_ratio": [1, 1],
                })
                replaced = True
            continue
        if re.fullmatch(r"M_[0-9a-f]{24}", _text(row.get("media_id"))):
            placements.append(row)
    if not replaced:
        placements.append({
            "media_id": media_id, "name": name, "track": "原录音_" + media_id,
            "at": at, "source": source, "frames": frames,
            "source_kind": "original", "timing_basis": "original_unretimed",
            "source_rate_ratio": [1, 1],
        })
    revision += 1
    unresolved = sorted(set(_text(value) for value in _as_list(alignment.get("unresolved_media_ids")) if _text(value)) - {media_id})
    confirmed_at = datetime.now(timezone.utc).isoformat()
    next_alignment = {
        "status": "confirmed",
        "sync_task_id": task_id,
        "confirmation_source": "human_confirmation.v1",
        "method": "master_playhead_confirmation",
        "revision": revision,
        "placements": placements,
        "unresolved_media_ids": unresolved,
        "coverage": "partial" if len(placements) < len(candidates) else "discovered_candidates_only",
        "evidence": [
            *[value for value in _as_list(alignment.get("evidence")) if isinstance(value, dict)][-49:],
            {
                "media_id": media_id,
                "confirmed_at": confirmed_at,
                "at": at,
                "source": source,
                "frames": frames,
                "device_clock_used": False,
                "basis": "operator_master_playhead",
            },
        ],
    }
    workspace_id = _text(getattr(project, "workspace_id", ""))
    if not workspace_id:
        raise ValueError("缺少本机 workspace_id，无法绑定录音")
    roots = tuple(getattr(project.config, "media_roots", ()) or ())
    if not roots and getattr(project.config, "media_root", None):
        roots = (project.config.media_root,)
    if not roots:
        raise ValueError("本机素材目录未登记")
    store = DeviceMediaStore()
    bound = store.resolve(workspace_id, _text(getattr(project, "project_id", "")), {"media_id": media_id, "name": name})
    if not bound:
        try:
            store.bind_named_media(workspace_id, _text(getattr(project, "project_id", "")), media_id, name, roots)
        except ValueError as error:
            raise ValueError(f"无法在本机素材目录绑定该 WAV：{error}") from error
    report["recording_alignment"] = next_alignment
    _atomic_json(report_path, report)
    return build_sync_timeline(project, tasks)


def _offsets_path(config: Any) -> Path:
    return Path(config.output_dir) / "sync" / "manual_offsets.json"


def _load_manual_offsets(config: Any, sync_task_id: str) -> dict[str, Any]:
    raw = _read_json(_offsets_path(config))
    if not raw or raw.get("contract") != "sync_manual_offsets.v1":
        return {"revision": 0, "sync_task_id": sync_task_id, "clip_offsets": {}, "recording_offsets": {}, "history": []}
    if sync_task_id and _text(raw.get("sync_task_id")) != sync_task_id:
        return {
            "revision": 0,
            "sync_task_id": sync_task_id,
            "clip_offsets": {},
            "recording_offsets": {},
            "history": [],
            "stale_revision": max(0, int(raw.get("revision", 0) or 0)),
            "stale_sync_task_id": _text(raw.get("sync_task_id")),
        }
    clip_offsets: dict[str, int] = {}
    for k, v in _as_dict(raw.get("clip_offsets")).items():
        if isinstance(v, int) and not isinstance(v, bool) and -15000 <= v <= 15000:
            clip_offsets[str(k)] = v
    rec_offsets: dict[str, int] = {}
    for k, v in _as_dict(raw.get("recording_offsets")).items():
        if isinstance(v, int) and not isinstance(v, bool) and -15000 <= v <= 15000:
            rec_offsets[str(k)] = v
    history = [row for row in _as_list(raw.get("history")) if isinstance(row, dict)]
    revision = int(raw.get("revision", 0) or 0)
    return {
        "revision": max(0, revision),
        "sync_task_id": sync_task_id,
        "clip_offsets": clip_offsets,
        "recording_offsets": rec_offsets,
        "history": history[-50:],
    }


def _apply_offsets_to_tracks(
    tracks: list[dict[str, Any]],
    timebase: dict[str, Any],
    clip_offsets: dict[str, int],
) -> tuple[list[dict[str, Any]], float]:
    fps = (
        float(timebase["numerator"]) / float(timebase["denominator"])
        if timebase.get("status") == "confirmed" and timebase.get("numerator") and timebase.get("denominator")
        else 25.0
    )
    max_end = 0.0
    for track in tracks:
        for clip in track.get("clips", []):
            cid = _text(clip.get("clip_id"))
            delta_frames = int(clip_offsets.get(cid, 0) or 0)
            if delta_frames:
                shifted = max(0.0, float(clip.get("timeline_start", 0.0)) + delta_frames / fps)
                clip["timeline_start"] = shifted
                clip["manual_offset_frames"] = delta_frames
            max_end = max(max_end, float(clip.get("timeline_start", 0.0)) + float(clip.get("duration", 0.0)))
        track["clips"].sort(key=lambda item: (float(item["timeline_start"]), item.get("day", ""), item.get("name", "")))
    return tracks, max_end


def _apply_offsets_to_recordings(
    recordings: dict[str, Any] | None,
    recording_offsets: dict[str, int],
) -> dict[str, Any] | None:
    if not recordings or not recording_offsets:
        return recordings
    for row in recordings.get("placements", []):
        mid = _text(row.get("media_id"))
        delta_frames = int(recording_offsets.get(mid, 0) or 0)
        if delta_frames:
            row["at"] = max(0, int(row.get("at", 0)) + delta_frames)
            row["manual_offset_frames"] = delta_frames
    return recordings


def apply_sync_manual_offset(project: Any, tasks: Iterable[object], body: object) -> dict[str, Any]:
    """Persist a human-confirmed, versioned frame offset without touching delivered artifacts."""
    from .media_identity import _atomic_json

    if not isinstance(body, dict):
        raise ValueError("偏移修正参数必须是对象")
    timeline = build_sync_timeline(project, tasks)
    if not timeline.get("ready"):
        raise ValueError("同步母版尚未就绪，无法写入人工偏移修正")
    task_id = _text(_as_dict(timeline.get("task")).get("task_id"))
    if not task_id:
        raise ValueError("缺少当前同步母版版本标识")

    delta = body.get("delta_frames")
    if type(delta) is not int or delta == 0 or not (-2500 <= delta <= 2500):
        raise ValueError("delta_frames 必须为非零整数（范围 -2500 至 +2500 帧）")
    target_kind = _text(body.get("target_kind") or "clip").lower()
    if target_kind not in {"clip", "recording"}:
        raise ValueError("target_kind 必须是 clip 或 recording")
    scope = _text(body.get("scope") or "single").lower()
    if scope not in {"single", "following", "track"}:
        raise ValueError("scope 必须是 single、following 或 track")

    state = _load_manual_offsets(project.config, task_id)
    expected = body.get("expected_revision")
    if expected is not None and int(expected) != state["revision"]:
        raise ValueError(f"偏移版本冲突（期望 r{expected}，当前 r{state['revision']}），请刷新后重试")

    applied_clip_ids: list[str] = []
    applied_recording_ids: list[str] = []

    if target_kind == "clip":
        track_id = _text(body.get("track_id"))
        clip_id = _text(body.get("clip_id"))
        track = next((t for t in timeline.get("tracks", []) if t.get("track_id") == track_id), None)
        if track is None:
            raise ValueError("未找到目标机位轨道")
        clips = list(track.get("clips", []))
        anchor = next((c for c in clips if c.get("clip_id") == clip_id), None)
        if scope in {"single", "following"} and anchor is None:
            raise ValueError("未找到目标片段")
        anchor_start = float(anchor["timeline_start"]) if anchor else 0.0
        for c in clips:
            cid = _text(c.get("clip_id"))
            if not cid:
                continue
            if scope == "single" and cid != clip_id:
                continue
            if scope == "following" and float(c.get("timeline_start", 0.0)) + 1e-6 < anchor_start:
                continue
            state["clip_offsets"][cid] = max(-15000, min(15000, int(state["clip_offsets"].get(cid, 0)) + delta))
            if state["clip_offsets"][cid] == 0:
                state["clip_offsets"].pop(cid, None)
            applied_clip_ids.append(cid)
        if not applied_clip_ids:
            raise ValueError("没有匹配到可修正的片段")
    else:
        recordings = _as_dict(timeline.get("recordings"))
        placements = list(_as_list(recordings.get("placements")))
        media_id = _text(body.get("media_id"))
        anchor = next((p for p in placements if _text(p.get("media_id")) == media_id), None)
        if scope in {"single", "following"} and anchor is None:
            raise ValueError("未找到目标同期录音片段")
        anchor_at = int(anchor["at"]) if anchor else 0
        seen: set[str] = set()
        for p in placements:
            mid = _text(p.get("media_id"))
            if not mid or mid in seen:
                continue
            if scope == "single" and mid != media_id:
                continue
            if scope == "following" and int(p.get("at", 0)) < anchor_at:
                continue
            seen.add(mid)
            state["recording_offsets"][mid] = max(-15000, min(15000, int(state["recording_offsets"].get(mid, 0)) + delta))
            if state["recording_offsets"][mid] == 0:
                state["recording_offsets"].pop(mid, None)
            applied_recording_ids.append(mid)
        if not applied_recording_ids:
            raise ValueError("没有匹配到可修正的同期录音")

    next_revision = state["revision"] + 1
    entry = {
        "revision": next_revision,
        "at": datetime.now(timezone.utc).isoformat(),
        "actor": _text(body.get("actor"))[:80] or "desktop-editor",
        "target_kind": target_kind,
        "scope": scope,
        "delta_frames": delta,
        "clip_ids": applied_clip_ids,
        "recording_ids": applied_recording_ids,
        "note": _text(body.get("note"))[:240],
    }
    state["revision"] = next_revision
    state["history"].append(entry)
    _atomic_json(
        _offsets_path(project.config),
        {
            "contract": "sync_manual_offsets.v1",
            "sync_task_id": task_id,
            "revision": state["revision"],
            "clip_offsets": state["clip_offsets"],
            "recording_offsets": state["recording_offsets"],
            "history": state["history"][-50:],
        },
    )
    return build_sync_timeline(project, tasks)


def undo_sync_manual_offset(project: Any, tasks: Iterable[object], body: object = None) -> dict[str, Any]:
    """Revert the latest manual offset revision safely."""
    from .media_identity import _atomic_json

    timeline = build_sync_timeline(project, tasks)
    if not timeline.get("ready"):
        raise ValueError("同步母版尚未就绪")
    task_id = _text(_as_dict(timeline.get("task")).get("task_id"))
    state = _load_manual_offsets(project.config, task_id)
    if not state["history"]:
        raise ValueError("当前没有可撤销的人工偏移记录")
    if isinstance(body, dict) and body.get("expected_revision") is not None:
        if int(body["expected_revision"]) != state["revision"]:
            raise ValueError("偏移版本已变更，请刷新后重试")

    last = state["history"].pop()
    delta = int(last.get("delta_frames", 0) or 0)
    for cid in _as_list(last.get("clip_ids")):
        key = _text(cid)
        if not key:
            continue
        updated = int(state["clip_offsets"].get(key, 0)) - delta
        if updated == 0:
            state["clip_offsets"].pop(key, None)
        else:
            state["clip_offsets"][key] = updated
    for mid in _as_list(last.get("recording_ids")):
        key = _text(mid)
        if not key:
            continue
        updated = int(state["recording_offsets"].get(key, 0)) - delta
        if updated == 0:
            state["recording_offsets"].pop(key, None)
        else:
            state["recording_offsets"][key] = updated
    state["revision"] = max(0, state["revision"] - 1)
    _atomic_json(
        _offsets_path(project.config),
        {
            "contract": "sync_manual_offsets.v1",
            "sync_task_id": task_id,
            "revision": state["revision"],
            "clip_offsets": state["clip_offsets"],
            "recording_offsets": state["recording_offsets"],
            "history": state["history"][-50:],
        },
    )
    return build_sync_timeline(project, tasks)


def rebase_sync_manual_offsets(project: Any, tasks: Iterable[object], body: object = None) -> dict[str, Any]:
    """Carry the previous sync revision forward only when every target identity remains present."""
    from .media_identity import _atomic_json

    task_history = list(tasks)
    timeline = build_sync_timeline(project, task_history)
    if not timeline.get("ready"):
        raise ValueError("当前同步母版尚未就绪，无法重应用人工偏移")
    current_task_id = _text(_as_dict(timeline.get("task")).get("task_id"))
    raw = _read_json(_offsets_path(project.config))
    if not raw or raw.get("contract") != "sync_manual_offsets.v1":
        raise ValueError("没有可重应用的上一版人工偏移")
    source_task_id = _text(raw.get("sync_task_id"))
    if not source_task_id or source_task_id == current_task_id:
        raise ValueError("当前同步版本没有待重应用的人工偏移")

    clip_offsets = {
        str(key): int(value)
        for key, value in _as_dict(raw.get("clip_offsets")).items()
        if isinstance(value, int) and not isinstance(value, bool) and value
    }
    recording_offsets = {
        str(key): int(value)
        for key, value in _as_dict(raw.get("recording_offsets")).items()
        if isinstance(value, int) and not isinstance(value, bool) and value
    }
    current_clip_ids = {
        _text(clip.get("clip_id"))
        for track in _as_list(timeline.get("tracks"))
        for clip in _as_list(_as_dict(track).get("clips"))
        if _text(_as_dict(clip).get("clip_id"))
    }
    current_recording_ids = {
        _text(row.get("media_id"))
        for row in _as_list(_as_dict(timeline.get("recordings")).get("placements"))
        if _text(_as_dict(row).get("media_id"))
    }
    missing_clips = sorted(set(clip_offsets) - current_clip_ids)
    missing_recordings = sorted(set(recording_offsets) - current_recording_ids)
    if missing_clips or missing_recordings:
        missing = [f"片段 {value}" for value in missing_clips[:5]] + [f"录音 {value}" for value in missing_recordings[:5]]
        raise ValueError("上一版人工偏移无法安全对应当前同步版本：" + "、".join(missing))

    expected = body.get("expected_stale_revision") if isinstance(body, dict) else None
    stale_revision = max(0, int(raw.get("revision", 0) or 0))
    if expected is not None and int(expected) != stale_revision:
        raise ValueError("上一版人工偏移已变化，请刷新后重试")
    _atomic_json(
        _offsets_path(project.config),
        {
            "contract": "sync_manual_offsets.v1",
            "sync_task_id": current_task_id,
            "revision": stale_revision,
            "clip_offsets": clip_offsets,
            "recording_offsets": recording_offsets,
            "history": _as_list(raw.get("history"))[-50:],
        },
    )
    return build_sync_timeline(project, task_history)


def _snapshot_path(config: Any, task_id: str) -> Path | None:
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,96}", task_id):
        return None
    return config.output_dir / "sync" / "masters" / f"{task_id}.json"


_BOUND_READ_TRACKS = _read_tracks


def sync_timeline_cache_key(project_id: str, project: Any, tasks: list[object]) -> tuple[Any, ...] | None:
    from .web_server import _file_signature

    output = getattr(project.config, "output_dir", None)
    if _read_tracks is not _BOUND_READ_TRACKS or not isinstance(output, Path) or not output.is_dir():
        return None
    # An in-memory index without a reload contract can change without a filesystem revision.
    if getattr(project, "index", None) and not (
        callable(getattr(project, "reload_if_changed", None)) and getattr(project, "analysis_revision", "")
    ):
        return None
    latest = _latest_sync_task(tasks)
    completed = _latest_sync_task(row for row in tasks if isinstance(row, dict) and row.get("status") == "completed")
    selected_tasks = [latest] if latest is completed else [latest, completed]
    task_signature = json.dumps(
        [(_safe_task(task), task.get("result")) for task in selected_tasks if task],
        sort_keys=True, separators=(",", ":"),
    )

    sync = output / "sync"
    work = output / ".multicam-sync" / "work"
    paths = [
        output / "analysis_snapshot.json", output / "material_index.json", output / "matches.json",
        output / "script.json", output / "sync_manual_offsets.json", sync, sync / "masters", work,
        sync / "sync_report.json", sync / "synchronized.fcpxml", _offsets_path(project.config),
    ]
    if completed:
        previous = _snapshot_path(project.config, _text(completed.get("task_id")))
        if previous:
            paths.append(previous)
    try:
        entries = os.scandir(work)
    except FileNotFoundError:
        pass
    else:
        with entries:
            for entry in entries:
                if entry.name.startswith("positions_"):
                    # A nonstandard day containing separators can refer to a nested table.
                    if entry.is_dir():
                        return None
                    if entry.name.endswith("_compressed.tsv"):
                        paths.append(Path(entry.path))
    return (
        project_id, str(output), bool(getattr(project.config, "is_media_directory", False)),
        getattr(project, "analysis_revision", ""), task_signature,
        tuple((path, _file_signature(path)) for path in sorted(paths)),
    )


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
            "recording_summary": {"status": "not_scanned", "candidate_count": 0, "placed_count": 0, "unplaced_count": 0, "invalid_count": 0},
        }

    task_history = list(tasks)
    latest_task = _latest_sync_task(task_history)
    report_path = config.output_dir / "sync" / "sync_report.json"
    sync_file = config.output_dir / "sync" / "synchronized.fcpxml"
    report = _read_json(report_path)
    reload_if_changed = getattr(project, "reload_if_changed", None)
    if callable(reload_if_changed):
        reload_if_changed()
    media_index = getattr(project, "index", None)
    if not isinstance(media_index, dict) or not media_index:
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

    timebase = fcpxml_project_timebase(sync_file) if ready else {
        "status": "unknown", "source": "fcpxml_sequence", "reason": "sync_not_ready",
    }
    task_id = _text(latest_task.get("task_id")) if latest_task else _text(report.get("sync_task_id"))
    offsets = _load_manual_offsets(config, task_id) if ready and task_id else {"revision": 0, "clip_offsets": {}, "recording_offsets": {}, "history": []}
    if ready and offsets["clip_offsets"]:
        tracks, shifted_duration = _apply_offsets_to_tracks(tracks, timebase, offsets["clip_offsets"])
        duration_seconds = max(duration_seconds, shifted_duration)
    recordings = sync_recordings(report, task_id) if ready and task_id else None
    recording_summary = sync_recording_summary(report, task_id)
    if ready and recordings and offsets["recording_offsets"]:
        recordings = _apply_offsets_to_recordings(recordings, offsets["recording_offsets"])
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
        "recordings": recordings,
        "recording_summary": recording_summary,
        "tracks": tracks,
        "cameras": cameras,
        "clip_count": sum(int(track.get("clip_count", 0) or 0) for track in tracks),
        "duration_seconds": duration_seconds,
        "timebase": timebase,
        "review_gaps": _review_gaps(tracks, timebase),
        "previous_master": previous,
        "offset_revision": offsets["revision"],
        "offset_history": offsets["history"][-10:],
        "stale_offset_revision": offsets.get("stale_revision", 0),
        "stale_offset_sync_task_id": offsets.get("stale_sync_task_id", ""),
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
    task_history = list(tasks)
    report = _read_json(output / "sync" / "sync_report.json")
    task = _latest_sync_task(task_history)
    timeline = build_sync_timeline(project, task_history)
    index_ready = _media_index_ready(config)
    synced_file = output / "sync" / "synchronized.fcpxml"
    phase, ready, _message = _status_for(task, report, synced_file, index_ready)
    ready = bool(getattr(config, "is_media_directory", False)) and ready and phase == "completed"

    roots = tuple(getattr(config, "media_roots", ()) or ())
    if not roots and getattr(config, "media_root", None):
        roots = (config.media_root,)
    version = _text(report.get("delivery_version"))
    sync_task_id = _text((timeline.get("task") or {}).get("task_id")) or _text(report.get("sync_task_id"))
    offset_revision = int(timeline.get("offset_revision", 0) or 0)
    recording_inventory = _as_dict(report.get("recording_inventory"))
    recording_alignment = _as_dict(report.get("recording_alignment"))
    audio_embedded = _as_dict(report.get("audio_delivery_embedded"))
    recording_alignment_current = (
        bool(recording_inventory)
        and recording_alignment.get("status") == "confirmed"
        and _text(recording_alignment.get("sync_task_id")) == sync_task_id
    )
    auto_audio_already_embedded = (
        recording_alignment_current
        and recording_alignment.get("confirmation_source") == "automatic_waveform.v1"
        and bool(audio_embedded.get("fcpxml"))
    )
    stale_reasons: list[str] = []
    if offset_revision > 0:
        stale_reasons.append(f"manual_offset_r{offset_revision}")
    if recording_alignment_current and not auto_audio_already_embedded:
        stale_reasons.append("recording_alignment_after_sync_export")
    standard_delivery_stale = bool(stale_reasons)
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
        audio_note = ""
        if audio_embedded.get(key):
            audio_note = " · 多机位 + 已对齐原 WAV"
        elif report.get("recording_inventory"):
            audio_note = " · 视频/机内参考声，未写入独立录音"
        files.append({
            "target": target,
            "label": label,
            "format": format_name + audio_note,
            "filename": filename,
            "available": bool(local_path),
            "stale": standard_delivery_stale,
            "stale_reason": "、".join(stale_reasons),
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
        "sync_task_id": sync_task_id,
        "offset_revision": offset_revision,
        "delivery_state": "stale" if standard_delivery_stale else "current",
        "stale_reasons": stale_reasons,
        "validation": "generated_files_only_nle_round_trip_not_verified",
    }


__all__ = [
    "CONTRACT_VERSION",
    "build_sync_timeline",
    "build_sync_delivery_artifacts",
    "apply_sync_manual_offset",
    "undo_sync_manual_offset",
    "rebase_sync_manual_offsets",
]
