from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from fractions import Fraction
from typing import Any

from ..timeline_delivery import UnsafeTimelineDelivery, _format_time, _object
from .fcpxml_resources import non_negative_int, positive_int, validate_source_range


def primary_video_item(
    spine: ET.Element,
    clip: dict[str, Any],
    *,
    bindings: dict[str, dict[str, Any]],
    multicams: dict[str, dict[str, Any]],
    frame_duration: Fraction,
    q,
) -> dict[str, Any]:
    clip_id = str(clip.get("clip_id", "") or "<unknown>")
    source_id = str(clip.get("source_id", "") or "")
    binding = bindings.get(source_id)
    if binding is None:
        raise UnsafeTimelineDelivery(f"NLE video clip references unknown source binding: {clip_id} -> {source_id}")
    timeline_start = non_negative_int(clip.get("timeline_start"), f"clip {clip_id} timeline_start")
    source_in = non_negative_int(clip.get("source_in"), f"clip {clip_id} source_in")
    duration_frames = positive_int(clip.get("duration"), f"clip {clip_id} duration")
    enabled = bool(clip.get("enabled", True))
    group_id = clip.get("multicam_group_id")

    if group_id is None:
        source_start, source_duration = validate_source_range(
            binding,
            start_frame=source_in,
            duration_frames=duration_frames,
            frame_duration=frame_duration,
            label=f"video clip {clip_id}",
        )
        attrs = {
            "name": str(binding["source"].get("name", "") or source_id),
            "ref": str(binding["asset_id"]),
            "offset": _format_time(timeline_start * frame_duration),
            "start": _format_time(source_start),
            "duration": _format_time(source_duration),
        }
        if not enabled:
            attrs["enabled"] = "0"
        element = ET.SubElement(spine, q("asset-clip"), attrs)
        return {
            "element": element,
            "timeline_start": timeline_start,
            "timeline_end": timeline_start + duration_frames,
            "local_start": source_in,
        }

    group_id = str(group_id or "")
    multicam = multicams.get(group_id)
    if multicam is None:
        raise UnsafeTimelineDelivery(f"NLE video clip references unknown exported multicam group: {clip_id} -> {group_id}")
    selected_source_id = str(clip.get("selected_angle_source_id", "") or "")
    if not selected_source_id:
        raise UnsafeTimelineDelivery(f"FCPXML delivery requires an explicit selected multicam angle: {clip_id}")
    angle_ranges = multicam["angle_ranges"]
    base_range = angle_ranges.get(source_id)
    selected_range = angle_ranges.get(selected_source_id)
    if base_range is None:
        raise UnsafeTimelineDelivery(f"multicam base source lacks typed sync range: {clip_id} -> {source_id}")
    if selected_range is None:
        raise UnsafeTimelineDelivery(f"multicam selected angle lacks typed sync range: {clip_id} -> {selected_source_id}")
    local_start = source_in - int(base_range[0])
    if local_start < 0 or local_start + duration_frames > int(base_range[1]) - int(base_range[0]):
        raise UnsafeTimelineDelivery(f"Timeline clip exceeds base multicam typed sync range: {clip_id}")
    if local_start + duration_frames > int(selected_range[1]) - int(selected_range[0]):
        raise UnsafeTimelineDelivery(f"Timeline clip exceeds selected multicam typed sync range: {clip_id}")

    attrs = {
        "name": f"MirrorOrder {group_id}",
        "ref": str(multicam["media_id"]),
        "offset": _format_time(timeline_start * frame_duration),
        "start": _format_time(local_start * frame_duration),
        "duration": _format_time(duration_frames * frame_duration),
    }
    if not enabled:
        attrs["enabled"] = "0"
    element = ET.SubElement(spine, q("mc-clip"), attrs)
    selected_angle_id = str(multicam["angle_ids"][selected_source_id])
    audio_source_id = multicam.get("audio_source_id")
    if audio_source_id and audio_source_id != selected_source_id:
        ET.SubElement(element, q("mc-source"), {"angleID": selected_angle_id, "srcEnable": "video"})
        ET.SubElement(
            element,
            q("mc-source"),
            {"angleID": str(multicam["angle_ids"][audio_source_id]), "srcEnable": "audio"},
        )
    else:
        ET.SubElement(element, q("mc-source"), {"angleID": selected_angle_id, "srcEnable": "all"})
    return {
        "element": element,
        "timeline_start": timeline_start,
        "timeline_end": timeline_start + duration_frames,
        "local_start": local_start,
    }


def append_gap(spine: ET.Element, *, start: int, duration: int, frame_duration: Fraction, q) -> dict[str, Any]:
    element = ET.SubElement(
        spine,
        q("gap"),
        {
            "name": "MirrorOrder Gap",
            "offset": _format_time(start * frame_duration),
            "start": "0s",
            "duration": _format_time(duration * frame_duration),
        },
    )
    return {"element": element, "timeline_start": start, "timeline_end": start + duration, "local_start": 0}


def _anchor_for(segments: list[dict[str, Any]], position: int, label: str) -> dict[str, Any]:
    for segment in segments:
        if int(segment["timeline_start"]) <= position < int(segment["timeline_end"]):
            return segment
    raise UnsafeTimelineDelivery(f"cannot anchor {label} in Final Cut primary storyline")


def attach_audio(
    segments: list[dict[str, Any]],
    audio_tracks: list[dict[str, Any]],
    *,
    bindings: dict[str, dict[str, Any]],
    frame_duration: Fraction,
    q,
) -> tuple[int, int, int]:
    clip_count = 0
    disabled_count = 0
    for lane_index, track in enumerate(audio_tracks, start=1):
        for raw in track.get("clips", []):
            clip = _object(raw, "nle audio clip")
            clip_id = str(clip.get("clip_id", "") or "<unknown>")
            if clip.get("multicam_group_id") is not None or clip.get("selected_angle_source_id") is not None:
                raise UnsafeTimelineDelivery(
                    f"independent audio clip must reference one explicit source without multicam switching: {clip_id}"
                )
            source_id = str(clip.get("source_id", "") or "")
            binding = bindings.get(source_id)
            if binding is None:
                raise UnsafeTimelineDelivery(f"NLE audio clip references unknown source binding: {clip_id} -> {source_id}")
            asset = binding["asset"]
            if str(asset.get("hasAudio", "") or "").strip() == "0":
                raise UnsafeTimelineDelivery(f"Timeline audio source asset declares no audio component: {binding['asset_id']}")
            timeline_start = non_negative_int(clip.get("timeline_start"), f"audio clip {clip_id} timeline_start")
            source_in = non_negative_int(clip.get("source_in"), f"audio clip {clip_id} source_in")
            duration_frames = positive_int(clip.get("duration"), f"audio clip {clip_id} duration")
            source_start, source_duration = validate_source_range(
                binding,
                start_frame=source_in,
                duration_frames=duration_frames,
                frame_duration=frame_duration,
                label=f"audio clip {clip_id}",
            )
            anchor = _anchor_for(segments, timeline_start, f"audio clip {clip_id}")
            local_offset = int(anchor["local_start"]) + timeline_start - int(anchor["timeline_start"])
            attrs = {
                "name": str(binding["source"].get("name", "") or source_id),
                "ref": str(binding["asset_id"]),
                "lane": str(-lane_index),
                "offset": _format_time(local_offset * frame_duration),
                "start": _format_time(source_start),
                "duration": _format_time(source_duration),
                "srcEnable": "audio",
            }
            metadata = clip.get("metadata") if isinstance(clip.get("metadata"), dict) else {}
            audio_role = str(metadata.get("audio_role", "") or "").strip()
            if audio_role:
                attrs["audioRole"] = audio_role
            if clip.get("enabled") is False:
                attrs["enabled"] = "0"
                disabled_count += 1
            ET.SubElement(anchor["element"], q("asset-clip"), attrs)
            clip_count += 1
    return len(audio_tracks), clip_count, disabled_count


def attach_markers(
    segments: list[dict[str, Any]],
    markers: list[dict[str, Any]],
    *,
    frame_duration: Fraction,
    q,
) -> int:
    for marker in markers:
        marker_id = str(marker.get("marker_id", "") or "")
        position = non_negative_int(marker.get("position"), f"marker {marker_id} position")
        original_duration = non_negative_int(marker.get("duration", 0), f"marker {marker_id} duration")
        anchor = _anchor_for(segments, position, f"marker {marker_id}")
        local_start = int(anchor["local_start"]) + position - int(anchor["timeline_start"])
        note = json.dumps(
            {
                "mirrororder_marker_id": marker_id,
                "kind": str(marker.get("kind", "standard") or "standard"),
                "duration_frames": original_duration,
                "metadata": marker.get("metadata") if isinstance(marker.get("metadata"), dict) else {},
            },
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        ET.SubElement(
            anchor["element"],
            q("marker"),
            {
                "start": _format_time(local_start * frame_duration),
                "duration": _format_time(max(1, original_duration) * frame_duration),
                "value": str(marker.get("label", "") or marker_id or "MirrorOrder Marker"),
                "note": note,
            },
        )
    return len(markers)
