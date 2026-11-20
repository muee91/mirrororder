from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from ..sync_timeline_runtime import build_sync_timeline


ENRICHED_DELIVERY_CONTRACT = "sync_enriched_delivery.v1"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _rational_seconds(seconds: float, num: int, den: int) -> str:
    frames = max(0, int(round(max(0.0, seconds) * num / den)))
    return f"{frames * den}/{num}s"


def _srt_timestamp(seconds: float) -> str:
    ms_total = max(0, int(round(max(0.0, seconds) * 1000)))
    hours, rem = divmod(ms_total, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def _safe_slug(value: str) -> str:
    cleaned = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff_-]+", "_", value.strip()).strip("_")
    return cleaned[:48] or "unassigned"


def _collect_slate_and_speech(output_dir: Path) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    """Map clip_id/media_id -> slate metadata and clip_id -> speech snippet."""
    slate_by_clip: dict[str, dict[str, Any]] = {}
    board = _read_json(output_dir / "script_supervisor_v2.json")
    if not board:
        board = _read_json(output_dir / "slate" / "script_supervisor.json")
    records = board.get("records", {}) if isinstance(board.get("records"), dict) else {}
    for rec in records.values():
        if not isinstance(rec, dict):
            continue
        for att in rec.get("attachments", []) if isinstance(rec.get("attachments"), list) else []:
            if not isinstance(att, dict):
                continue
            cid = str(att.get("clip_id", "") or "").strip()
            if cid:
                slate_by_clip[cid] = rec

    speech_by_clip: dict[str, str] = {}
    mat_index = _read_json(output_dir / "material_index.json")
    for item in mat_index.get("clips", []) if isinstance(mat_index.get("clips"), list) else []:
        if not isinstance(item, dict):
            continue
        cid = str(item.get("clip_id", "") or "").strip()
        transcript = str(item.get("transcript_text", "") or item.get("transcript", "") or "").strip()
        if cid and transcript:
            speech_by_clip[cid] = transcript
    return slate_by_clip, speech_by_clip


def _marker_for_clip(
    clip: dict[str, Any],
    slate: dict[str, Any] | None,
    speech: str,
) -> tuple[str, str, bool]:
    """Build concise editor-ready marker (label, note, is_issue)."""
    parts: list[str] = []
    status = str((slate or {}).get("status", "") or "").strip().lower()
    note = str((slate or {}).get("note", "") or "").strip()
    is_circle = "保条" in note or "★" in note
    is_issue = status == "ng" or bool(clip.get("manual_offset_frames"))

    if slate:
        ep = slate.get("episode")
        sc = str(slate.get("scene", "") or slate.get("script_scene_id", "") or "").strip()
        sh = str(slate.get("shot", "") or "").strip()
        tk = slate.get("take_number")
        code = "-".join(
            p for p in (f"EP{ep}" if ep else "", sc, sh, f"T{tk}" if tk else "") if p
        )
        if code:
            parts.append(code)
    if is_circle:
        parts.append("[保条 ★]")
    elif status == "usable":
        parts.append("[可用]")
    elif status == "partial":
        parts.append("[部分可用]")
    elif status == "ng":
        parts.append("[NG]")

    offset_frames = int(clip.get("manual_offset_frames", 0) or 0)
    if offset_frames:
        sign = "+" if offset_frames > 0 else ""
        parts.append(f"[微调 {sign}{offset_frames}f]")

    label = " ".join(parts) or f"{clip.get('camera', '?')} · {clip.get('name', '')}"
    detail_parts = [p for p in (note, speech[:120] if speech else "") if p]
    return label[:140], " | ".join(detail_parts)[:360], is_issue


def _build_fcpxml_document(
    *,
    event_name: str,
    project_name: str,
    tracks: list[dict[str, Any]],
    recordings: list[dict[str, Any]],
    markers: list[dict[str, Any]],
    duration_seconds: float,
    num: int,
    den: int,
) -> str:
    root = ET.Element("fcpxml", {"version": "1.10"})
    resources = ET.SubElement(root, "resources")
    ET.SubElement(
        resources,
        "format",
        {
            "id": "r1",
            "name": f"FFVideoFormat1080p{round(num / den)}",
            "frameDuration": f"{den}/{num}s",
            "width": "1920",
            "height": "1080",
        },
    )

    asset_ids: dict[str, str] = {}
    next_id = 2
    for track in tracks:
        for clip in track.get("clips", []):
            key = f"{clip.get('camera')}:{clip.get('clip_id')}:{clip.get('name')}"
            if key in asset_ids:
                continue
            rid = f"r{next_id}"
            next_id += 1
            asset_ids[key] = rid
            ET.SubElement(
                resources,
                "asset",
                {
                    "id": rid,
                    "name": str(clip.get("name", "clip")),
                    "start": "0s",
                    "duration": _rational_seconds(float(clip.get("duration", 0.1)), num, den),
                    "hasVideo": "1",
                    "hasAudio": "1",
                    "format": "r1",
                },
            )
    for rec in recordings:
        key = f"wav:{rec.get('media_id')}"
        if key in asset_ids:
            continue
        rid = f"r{next_id}"
        next_id += 1
        asset_ids[key] = rid
        ET.SubElement(
            resources,
            "asset",
            {
                "id": rid,
                "name": str(rec.get("name", rec.get("media_id", "sync.wav"))),
                "start": "0s",
                "duration": f"{max(1, int(rec.get('frames', 1))) * den}/{num}s",
                "hasVideo": "0",
                "hasAudio": "1",
            },
        )

    library = ET.SubElement(root, "library")
    event = ET.SubElement(library, "event", {"name": event_name})
    project = ET.SubElement(event, "project", {"name": project_name})
    sequence = ET.SubElement(
        project,
        "sequence",
        {
            "format": "r1",
            "duration": _rational_seconds(max(duration_seconds, 0.1), num, den),
            "tcStart": "0s",
            "tcFormat": "NDF",
        },
    )
    spine = ET.SubElement(sequence, "spine")
    gap = ET.SubElement(
        spine,
        "gap",
        {
            "name": "MirrorOrder Sync Master",
            "offset": "0s",
            "start": "0s",
            "duration": _rational_seconds(max(duration_seconds, 0.1), num, den),
        },
    )

    for lane_idx, track in enumerate(tracks, start=1):
        cam = str(track.get("camera", "?"))
        for clip in track.get("clips", []):
            key = f"{clip.get('camera')}:{clip.get('clip_id')}:{clip.get('name')}"
            ET.SubElement(
                gap,
                "asset-clip",
                {
                    "ref": asset_ids[key],
                    "lane": str(lane_idx),
                    "offset": _rational_seconds(float(clip.get("timeline_start", 0.0)), num, den),
                    "name": str(clip.get("name", "clip")),
                    "start": "0s",
                    "duration": _rational_seconds(float(clip.get("duration", 0.1)), num, den),
                    "role": f"video.cam-{cam}",
                },
            )

    for rec in recordings:
        key = f"wav:{rec.get('media_id')}"
        ET.SubElement(
            gap,
            "asset-clip",
            {
                "ref": asset_ids[key],
                "lane": "-1",
                "offset": f"{max(0, int(rec.get('at', 0))) * den}/{num}s",
                "name": str(rec.get("name", "sync.wav")),
                "start": f"{max(0, int(rec.get('source', 0))) * den}/{num}s",
                "duration": f"{max(1, int(rec.get('frames', 1))) * den}/{num}s",
                "role": "dialogue.sync-wav",
            },
        )

    for mk in markers:
        attrs = {
            "start": _rational_seconds(float(mk["start"]), num, den),
            "duration": f"{den}/{num}s",
            "value": str(mk["value"]),
        }
        if mk.get("note"):
            attrs["note"] = str(mk["note"])
        if mk.get("is_issue"):
            attrs["completed"] = "0"
        ET.SubElement(gap, "marker", attrs)

    ET.indent(root, space="  ")
    return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n' + ET.tostring(root, encoding="unicode")


def build_enriched_sync_fcpxml_bundle(
    project: Any,
    tasks: Iterable[object],
    options: object = None,
) -> dict[str, Any]:
    """Generate a non-destructive enriched NLE delivery pack (markers + per-scene FCPXML + dialogue SRT)."""
    opts = options if isinstance(options, dict) else {}
    include_markers = bool(opts.get("include_markers", True))
    split_by_scene = bool(opts.get("split_by_scene", True))
    export_srt = bool(opts.get("export_srt", True))

    timeline = build_sync_timeline(project, tasks)
    if not timeline.get("ready"):
        raise ValueError("同步母版尚未就绪，请先完成多机位同步")

    timebase = timeline.get("timebase", {}) if isinstance(timeline.get("timebase"), dict) else {}
    num = int(timebase.get("numerator") or 25)
    den = int(timebase.get("denominator") or 1)
    tracks = list(timeline.get("tracks", []))
    recordings = list((timeline.get("recordings") or {}).get("placements", []))
    duration_seconds = float(timeline.get("duration_seconds", 0.0) or 0.0)
    task_id = str((timeline.get("task") or {}).get("task_id", "") or "master")[:16]
    offset_rev = int(timeline.get("offset_revision", 0) or 0)

    output_dir = Path(project.config.output_dir)
    slate_by_clip, speech_by_clip = _collect_slate_and_speech(output_dir)

    markers: list[dict[str, Any]] = []
    srt_cues: list[tuple[float, float, str]] = []
    scene_groups: dict[str, list[dict[str, Any]]] = {}

    for track in tracks:
        for clip in track.get("clips", []):
            cid = str(clip.get("media_clip_id") or clip.get("clip_id") or "")
            slate = slate_by_clip.get(cid) or slate_by_clip.get(str(clip.get("clip_id", "")))
            speech = speech_by_clip.get(cid, "")
            start = float(clip.get("timeline_start", 0.0))
            dur = float(clip.get("duration", 0.0))

            if include_markers and (slate or speech or clip.get("manual_offset_frames")):
                value, note, is_issue = _marker_for_clip(clip, slate, speech)
                markers.append({"start": start, "value": value, "note": note, "is_issue": is_issue})

            if export_srt and speech:
                srt_cues.append((start, start + max(0.5, dur), speech))

            if slate and (slate.get("scene") or slate.get("script_scene_id")):
                ep = slate.get("episode")
                sc = str(slate.get("scene") or slate.get("script_scene_id"))
                scene_key = f"EP{ep}_{sc}" if ep else f"Scene_{sc}"
            else:
                scene_key = f"Day_{clip.get('day') or '01'}"
            scene_groups.setdefault(scene_key, []).append({"track": track, "clip": clip})

    bundle_dir = output_dir / "sync" / "enriched_delivery" / f"{_safe_slug(task_id)}_r{offset_rev}"
    bundle_dir.mkdir(parents=True, exist_ok=True)

    master_path = bundle_dir / "synchronized_markers_master.fcpxml"
    master_xml = _build_fcpxml_document(
        event_name=f"MirrorOrder_{project.project_id}",
        project_name=f"SyncMaster_{task_id}_r{offset_rev}",
        tracks=tracks,
        recordings=recordings,
        markers=markers,
        duration_seconds=duration_seconds,
        num=num,
        den=den,
    )
    master_path.write_text(master_xml, encoding="utf-8")

    scene_files: list[dict[str, str]] = []
    if split_by_scene and scene_groups:
        scenes_dir = bundle_dir / "scenes"
        scenes_dir.mkdir(parents=True, exist_ok=True)
        for scene_label, entries in sorted(scene_groups.items()):
            min_start = min(float(e["clip"]["timeline_start"]) for e in entries)
            max_end = max(float(e["clip"]["timeline_start"]) + float(e["clip"]["duration"]) for e in entries)
            by_cam: dict[str, dict[str, Any]] = {}
            for e in entries:
                tr = e["track"]
                cam = str(tr.get("camera", "?"))
                if cam not in by_cam:
                    by_cam[cam] = {**tr, "clips": []}
                shifted = {**e["clip"], "timeline_start": max(0.0, float(e["clip"]["timeline_start"]) - min_start)}
                by_cam[cam]["clips"].append(shifted)
            sub_markers = [
                {**m, "start": max(0.0, float(m["start"]) - min_start)}
                for m in markers
                if min_start - 0.05 <= float(m["start"]) <= max_end + 0.05
            ]
            sub_recs = [
                {**r, "at": max(0, int(r["at"]) - int(round(min_start * num / den)))}
                for r in recordings
                if int(r["at"]) + int(r["frames"]) > int(round(min_start * num / den))
                and int(r["at"]) < int(round(max_end * num / den))
            ]
            sub_path = scenes_dir / f"{_safe_slug(scene_label)}.fcpxml"
            sub_xml = _build_fcpxml_document(
                event_name=f"MirrorOrder_{scene_label}",
                project_name=scene_label,
                tracks=list(by_cam.values()),
                recordings=sub_recs,
                markers=sub_markers,
                duration_seconds=max(0.1, max_end - min_start),
                num=num,
                den=den,
            )
            sub_path.write_text(sub_xml, encoding="utf-8")
            scene_files.append({"scene": scene_label, "filename": sub_path.name, "local_path": str(sub_path.resolve())})

    srt_path_str = ""
    if export_srt and srt_cues:
        srt_cues.sort(key=lambda item: item[0])
        srt_lines: list[str] = []
        for idx, (s_start, s_end, text) in enumerate(srt_cues, start=1):
            srt_lines.append(f"{idx}\n{_srt_timestamp(s_start)} --> {_srt_timestamp(s_end)}\n{text}\n")
        srt_path = bundle_dir / "synchronized_dialogue.srt"
        srt_path.write_text("\n".join(srt_lines), encoding="utf-8")
        srt_path_str = str(srt_path.resolve())

    return {
        "contract": ENRICHED_DELIVERY_CONTRACT,
        "project_id": project.project_id,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "sync_task_id": task_id,
        "offset_revision": offset_rev,
        "bundle_dir": str(bundle_dir.resolve()),
        "master_fcpxml": str(master_path.resolve()),
        "marker_count": len(markers),
        "scene_sequences": scene_files,
        "dialogue_srt": srt_path_str,
        "srt_cue_count": len(srt_cues),
    }


__all__ = ["ENRICHED_DELIVERY_CONTRACT", "build_enriched_sync_fcpxml_bundle"]
