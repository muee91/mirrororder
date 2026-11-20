from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from bisect import bisect_right
from pathlib import Path
from typing import Any, Callable

from ..fcpxml_reader import fcpxml_asset_locator, is_generated_sync_asset_id
from ..media_identity import DeviceMediaStore
from ..resource_scheduler import ResourceCancelled
from ..sync_timeline_runtime import build_sync_timeline
from ..timebase import first_frame_at_or_after


def _video_blocks(gaps: list[dict[str, int]], end: int) -> list[tuple[int, int, int]]:
    blocks = []
    start = compact = 0
    for gap in gaps:
        stop = gap["start_frame"]
        blocks.append((start, stop, compact))
        compact += stop - start
        start = gap["end_frame"]
    blocks.append((start, end, compact))
    return blocks


def build_resolve_plan(
    project: Any,
    tasks: list[dict[str, Any]],
    store: DeviceMediaStore,
    cancelled: Callable[[], bool],
) -> dict[str, Any]:
    """Snapshot one completed sync and resolve verified media on this device."""
    timeline = build_sync_timeline(project, tasks)
    timebase = timeline.get("timebase", {})
    if timeline["phase"] != "completed" or timebase.get("status") != "confirmed":
        raise ValueError("请先完成多机位同步并确认母版帧率")
    if len(timeline["cameras"]) < 2 or len(timeline["tracks"]) != len(timeline["cameras"]):
        raise ValueError("多轨同步交付需要至少两个已确认机位；请先归类未识别的机位")

    numerator, denominator = timebase["numerator"], timebase["denominator"]
    end = first_frame_at_or_after(timeline["duration_seconds"], numerator, denominator)
    blocks = _video_blocks(timeline["review_gaps"], end)
    block_ends = [stop for _, stop, _ in blocks]
    snapshot = store.project_snapshot(project.workspace_id, project.project_id)
    output = Path(project.config.output_dir)
    master_path = output / "sync" / "synchronized.fcpxml"
    index = json.loads((output / "material_index.json").read_text(encoding="utf-8"))
    media_clips = {item["clip_id"]: item for item in index["clips"] if isinstance(item, dict) and item.get("clip_id")}
    paths: dict[str, str] = {}

    def bind(item: dict[str, Any], label: str) -> str:
        if cancelled():
            raise ResourceCancelled("Resolve 工程生成已取消")
        media_id = str(item.get("media_id", "") or "")
        if not media_id.startswith("M_"):
            raise ValueError(f"素材身份待核实：{label}")
        if media_id not in paths:
            asset = str(item.get("source_asset_id", "") or "")
            lookup = item
            if is_generated_sync_asset_id(asset) and not (item.get("media_path") or item.get("source_media_path")):
                lookup = {**item, "source_media_path": fcpxml_asset_locator(master_path, asset)}
            path = store.resolve_from_snapshot(snapshot, lookup)
            if not path:
                raise ValueError(f"素材身份或位置无法验证：{label}")
            paths[media_id] = str(Path(path).resolve(strict=True))
        return paths[media_id]

    tracks = []
    for track in timeline["tracks"]:
        clips = []
        previous_end = 0
        for clip in track["clips"]:
            start = first_frame_at_or_after(clip["timeline_start"], numerator, denominator)
            stop = first_frame_at_or_after(clip["timeline_start"] + clip["duration"], numerator, denominator)
            if start < previous_end or stop <= start:
                raise ValueError(f"{track['label']}的片段范围重叠或不足一帧：{clip['name']}")
            previous_end = stop
            left, right, compact = blocks[bisect_right(block_ends, start)]
            if not left <= start < stop <= right:
                raise ValueError(f"视频跨越共同停拍区间：{clip['name']}")
            clips.append({
                "path": bind(media_clips.get(clip.get("media_clip_id"), {}), clip["name"]),
                "source_kind": "original", "media_id": media_clips.get(clip.get("media_clip_id"), {}).get("media_id"),
                "name": clip["name"], "at": compact + start - left,
                "frames": stop - start, "source": 0,
            })
        tracks.append({"camera": track["camera"], "clips": clips})

    # A placement has authority only for the sync revision it was confirmed on.
    # Its coordinates use the master grid before the common gaps are removed.
    recordings = []
    diagnostics = []
    report = json.loads((output / "sync" / "sync_report.json").read_text(encoding="utf-8"))
    alignment = report.get("recording_alignment", {})
    if alignment.get("status") == "confirmed" and alignment.get("sync_task_id") == timeline["task"]["task_id"]:
        for entry in alignment.get("placements", []):
            track = str(entry["track"]).strip()
            name = str(entry["name"])
            start, source, length = (entry[key] for key in ("at", "source", "frames"))
            if not track or track in timeline["cameras"] or Path(name).suffix.lower() != ".wav":
                raise ValueError("同期录音需使用独立具名音轨与 WAV 文件")
            if any(type(value) is not int for value in (start, source, length)) or source < 0 or length <= 0:
                raise ValueError(f"同期录音的范围无效：{name}")
            if (entry.get("source_kind") != "original" or entry.get("timing_basis") != "original_unretimed"
                    or entry.get("source_rate_ratio") != [1, 1]):
                raise ValueError(f"录音来源/时间映射待确认：{name}；需原 WAV、原始未变速坐标及 1:1 速率。校正文件不能直接替换，非 1:1 漂移需原生重定时验证")
            path = bind({"media_id": entry["media_id"]}, name)
            if any(part.casefold().replace("_", " ") == "corrected audio" for part in Path(path).parts):
                raise ValueError(f"录音仍引用 Corrected Audio 派生文件：{name}，请确认原 WAV 映射")
            if Path(path).suffix.lower() != ".wav":
                raise ValueError(f"同期录音绑定的文件类型不符：{name}")
            for lo, hi, compact in blocks[bisect_right(block_ends, start):]:
                if lo >= start + length:
                    break
                left, right = max(lo, start), min(hi, start + length)
                if right > left:
                    recordings.append({"track": track, "path": path, "name": name,
                                       "media_id": entry["media_id"], "source_kind": "original",
                                       "timing_basis": "original_unretimed", "source_rate_ratio": [1, 1],
                                       "at": compact + left - lo, "frames": right - left, "source": source + left - start})
    if not recordings:
        diagnostics.append({"code": "original_recordings_not_exported", "message": "未导出独立原 WAV：缺少同一同步版本确认的录音摆位，或录音均在画面范围外。机内参考声不等于独立录音交付。"})
    inventory = report.get("recording_inventory", {})
    required_ids = {row.get("media_id") for row in inventory.get("candidates", []) if row.get("media_id")}
    exported_ids = {row["media_id"] for row in recordings}
    if required_ids - exported_ids or inventory.get("unreadable_entries") or inventory.get("derived_candidates_excluded"):
        raise ValueError("独立录音交付不完整：原 WAV 候选缺少当前同步版本的可信摆位或素材无法读取；保留现有同步结果，不用机内声冒充完整录音交付")
    recordings.sort(key=lambda item: (item["track"], item["at"]))
    for prior, entry in zip(recordings, recordings[1:]):
        if prior["track"] == entry["track"] and prior["at"] + prior["frames"] > entry["at"]:
            raise ValueError(f"同期录音轨 {entry['track']} 有重叠片段，请先核对")

    edges = sorted((value, delta) for lane in tracks for clip in lane["clips"]
                   for value, delta in ((clip["at"], 1), (clip["at"] + clip["frames"], -1)))
    visible = most = opening_frame = 0
    for at, delta in edges:
        visible += delta
        if visible > most:
            most, opening_frame = visible, at
            if most == len(tracks):
                break

    master = ET.parse(master_path)
    active_format = next((fmt for fmt in master.iter("format") if fmt.get("id") == timebase["format_id"]), None)
    size = [int(active_format.get(axis, "0")) for axis in ("width", "height")] if active_format is not None else [0, 0]
    last_start, last_end, compact = blocks[-1]
    return {
        "contract_version": "resolve_sync_originals.v1", "diagnostics": diagnostics,
        "rate": [numerator, denominator], "size": size, "frames": compact + last_end - last_start,
        "gaps": len(blocks) - 1, "tracks": tracks, "recordings": recordings,
        "opening_frame": opening_frame, "sync_task_id": timeline["task"]["task_id"],
    }
