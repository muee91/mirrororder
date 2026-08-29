from __future__ import annotations

import copy
import json
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from .config import ProjectConfig
from .timeline_delivery import (
    TIMELINE_FCPXML_NAME,
    TIMELINE_REPORT_NAME,
    UnsafeTimelineDelivery,
    _active_sequence,
    _asset_bounds,
    _format_time,
    _frame_duration,
    _list,
    _material_clip_map,
    _non_negative_int,
    _object,
    _parse_time,
    _positive_int,
    _source_assets,
    _source_map,
    _tag,
    _write_json_atomic,
    _write_xml_atomic,
    export_timeline_snapshot,
)


def _enabled_audio_tracks(sequence: dict[str, Any]) -> list[dict[str, Any]]:
    tracks = [_object(item, "timeline track") for item in _list(sequence.get("tracks"), "sequence.tracks")]
    return [
        track
        for track in tracks
        if str(track.get("kind", "")) == "audio" and _list(track.get("clips", []), "track.clips")
    ]


def _video_only_request(request: dict[str, Any]) -> dict[str, Any]:
    payload = copy.deepcopy(request)
    timeline = _object(payload.get("timeline"), "timeline")
    sequence = _active_sequence(timeline)
    for track in _list(sequence.get("tracks"), "sequence.tracks"):
        item = _object(track, "timeline track")
        if str(item.get("kind", "")) == "audio":
            item["clips"] = []
    return payload


def _timeline_audio_clips(
    sequence: dict[str, Any],
    sources: dict[str, dict[str, Any]],
    material_clips: dict[str, dict[str, Any]],
    assets: dict[str, ET.Element],
    frame_duration,
) -> tuple[list[dict[str, Any]], int]:
    result: list[dict[str, Any]] = []
    tracks = _enabled_audio_tracks(sequence)
    for lane_index, track in enumerate(tracks, start=1):
        track_id = str(track.get("track_id", "") or f"audio-{lane_index}")
        clips: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        for raw in _list(track.get("clips", []), "audio track clips"):
            clip = _object(raw, "timeline audio clip")
            clip_id = str(clip.get("clip_id", "") or "")
            if not clip_id or clip_id in seen_ids:
                raise UnsafeTimelineDelivery(f"invalid or duplicate Timeline audio clip_id: {clip_id or '<empty>'}")
            seen_ids.add(clip_id)
            if clip.get("enabled") is False:
                continue
            if clip.get("multicam_group_id") or clip.get("selected_angle_source_id"):
                raise UnsafeTimelineDelivery(
                    f"independent audio clip must reference one explicit source without multicam switching: {clip_id}"
                )
            source_id = str(clip.get("source_id", "") or "")
            source = sources.get(source_id)
            if source is None:
                raise UnsafeTimelineDelivery(f"Timeline audio clip references unknown source: {clip_id} -> {source_id}")
            source_clip_id = str(source.get("clip_id", "") or "")
            material = material_clips.get(source_clip_id)
            if material is None:
                raise UnsafeTimelineDelivery(
                    f"Timeline audio source has no material-index FCPXML asset mapping: {source_clip_id}"
                )
            asset_id = str(material.get("source_asset_id", "") or "")
            asset = assets.get(asset_id)
            if asset is None:
                raise UnsafeTimelineDelivery(f"Timeline audio source asset is missing from source FCPXML resources: {asset_id}")
            if str(asset.get("hasAudio", "") or "").strip() == "0":
                raise UnsafeTimelineDelivery(f"Timeline audio source asset declares no audio component: {asset_id}")

            timeline_start = _non_negative_int(clip.get("timeline_start"), f"audio clip {clip_id} timeline_start")
            source_in = _non_negative_int(clip.get("source_in"), f"audio clip {clip_id} source_in")
            duration = _positive_int(clip.get("duration"), f"audio clip {clip_id} duration")
            duration_frames = source.get("duration_frames")
            if duration_frames is not None:
                total_frames = _positive_int(duration_frames, f"source {source_id} duration_frames")
                if source_in + duration > total_frames:
                    raise UnsafeTimelineDelivery(f"Timeline audio clip exceeds TimelineSource duration: {clip_id}")

            source_start = source_in * frame_duration
            source_duration = duration * frame_duration
            occurrence_end = _parse_time(material.get("source_end"))
            if occurrence_end is not None and source_start + source_duration > occurrence_end:
                raise UnsafeTimelineDelivery(f"Timeline audio clip exceeds material occurrence: {clip_id}")
            asset_start, asset_end = _asset_bounds(asset)
            if source_start < asset_start:
                raise UnsafeTimelineDelivery(f"Timeline audio clip source_in precedes asset start: {clip_id}")
            if asset_end is not None and source_start + source_duration > asset_end:
                raise UnsafeTimelineDelivery(f"Timeline audio clip exceeds asset duration: {clip_id}")

            metadata = clip.get("metadata") if isinstance(clip.get("metadata"), dict) else {}
            role = str(metadata.get("audio_role", "") or "").strip()
            clips.append(
                {
                    "clip_id": clip_id,
                    "track_id": track_id,
                    "lane": -lane_index,
                    "name": str(source.get("name", "") or source_clip_id),
                    "asset_id": asset_id,
                    "timeline_start": timeline_start,
                    "source_start": source_start,
                    "duration": source_duration,
                    "duration_frames": duration,
                    "audio_role": role,
                }
            )

        clips.sort(key=lambda item: (item["timeline_start"], item["clip_id"]))
        previous_end = 0
        for clip in clips:
            start = int(clip["timeline_start"])
            if start < previous_end:
                raise UnsafeTimelineDelivery(
                    f"Timeline audio clips overlap on track {track_id} around {clip['clip_id']}"
                )
            previous_end = start + int(clip["duration_frames"])
        result.extend(clips)
    return result, len(tracks)


def _fraction_frames(value, frame_duration, label: str) -> int:
    parsed = _parse_time(value)
    if parsed is None or parsed < 0:
        raise UnsafeTimelineDelivery(f"invalid generated FCPXML time for {label}")
    frames = parsed / frame_duration
    if frames.denominator != 1:
        raise UnsafeTimelineDelivery(f"generated FCPXML {label} is not frame-aligned")
    return int(frames)


def _primary_segments(spine: ET.Element, frame_duration) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    for element in list(spine):
        if _tag(element) not in {"asset-clip", "gap"}:
            continue
        start_frame = _fraction_frames(element.get("offset", "0s"), frame_duration, "primary offset")
        duration_frames = _fraction_frames(element.get("duration"), frame_duration, "primary duration")
        local_start = _parse_time(element.get("start")) or 0 * frame_duration
        segments.append(
            {
                "element": element,
                "timeline_start": start_frame,
                "timeline_end": start_frame + duration_frames,
                "local_start": local_start,
            }
        )
    return segments


def _ensure_trailing_primary_gap(
    spine: ET.Element,
    *,
    current_end: int,
    required_end: int,
    frame_duration,
    q,
) -> None:
    if required_end <= current_end:
        return
    children = list(spine)
    last = children[-1] if children else None
    if last is not None and _tag(last) == "gap":
        last_start = _fraction_frames(last.get("offset", "0s"), frame_duration, "trailing gap offset")
        last_end = last_start + _fraction_frames(last.get("duration"), frame_duration, "trailing gap duration")
        if last_end == current_end:
            last.set("duration", _format_time((required_end - last_start) * frame_duration))
            return
    ET.SubElement(
        spine,
        q("gap"),
        {
            "name": "MirrorOrder Audio Anchor Gap",
            "offset": _format_time(current_end * frame_duration),
            "duration": _format_time((required_end - current_end) * frame_duration),
        },
    )


def _attach_audio_clips(
    spine: ET.Element,
    audio_clips: list[dict[str, Any]],
    *,
    frame_duration,
    q,
) -> None:
    segments = _primary_segments(spine, frame_duration)
    for clip in audio_clips:
        timeline_start = int(clip["timeline_start"])
        anchor = next(
            (
                segment
                for segment in segments
                if int(segment["timeline_start"]) <= timeline_start < int(segment["timeline_end"])
            ),
            None,
        )
        if anchor is None:
            raise UnsafeTimelineDelivery(f"cannot anchor independent audio clip in primary storyline: {clip['clip_id']}")
        relative = (timeline_start - int(anchor["timeline_start"])) * frame_duration
        anchor_offset = anchor["local_start"] + relative
        attrs = {
            "name": str(clip["name"]),
            "ref": str(clip["asset_id"]),
            "lane": str(clip["lane"]),
            "offset": _format_time(anchor_offset),
            "start": _format_time(clip["source_start"]),
            "duration": _format_time(clip["duration"]),
            "srcEnable": "audio",
        }
        if clip["audio_role"]:
            attrs["audioRole"] = str(clip["audio_role"])
        ET.SubElement(anchor["element"], q("asset-clip"), attrs)


def export_timeline_snapshot_with_audio(
    config: ProjectConfig,
    request: dict[str, Any],
    *,
    expected_project_id: str,
) -> dict[str, Any]:
    timeline = _object(request.get("timeline"), "timeline")
    sequence = _active_sequence(timeline)
    frame_duration = _frame_duration(sequence)
    audio_tracks = _enabled_audio_tracks(sequence)
    if not audio_tracks:
        return export_timeline_snapshot(config, request, expected_project_id=expected_project_id)

    # Let the proven Stage 14 converter validate and export the authoritative
    # video storyline, then add independent audio as connected audio-only clips.
    report = export_timeline_snapshot(
        config,
        _video_only_request(request),
        expected_project_id=expected_project_id,
    )

    try:
        tree = ET.parse(config.output_dir / TIMELINE_FCPXML_NAME)
        source_tree = ET.parse(config.fcpxml) if config.fcpxml else None
    except (OSError, ET.ParseError) as error:
        raise UnsafeTimelineDelivery(f"cannot reopen Timeline FCPXML for audio delivery: {error}") from error
    if source_tree is None:
        raise UnsafeTimelineDelivery("Timeline audio delivery requires the original source FCPXML")

    root = tree.getroot()
    source_root = source_tree.getroot()
    _, assets, _ = _source_assets(source_root)
    sources = _source_map(timeline)
    material_clips = _material_clip_map(config)
    audio_clips, audio_track_count = _timeline_audio_clips(
        sequence,
        sources,
        material_clips,
        assets,
        frame_duration,
    )
    if not audio_clips:
        report["audio_track_count"] = audio_track_count
        report["audio_clip_count"] = 0
        report["semantics"]["independent_audio_tracks_supported"] = True
        _write_json_atomic(config.output_dir / TIMELINE_REPORT_NAME, report)
        return report

    sequence_element = next((item for item in root.iter() if _tag(item) == "sequence"), None)
    if sequence_element is None:
        raise UnsafeTimelineDelivery("generated Timeline FCPXML has no sequence")
    spine = next((item for item in sequence_element if _tag(item) == "spine"), None)
    if spine is None:
        raise UnsafeTimelineDelivery("generated Timeline FCPXML has no spine")

    namespace_prefix = root.tag[:-len("fcpxml")] if root.tag.endswith("fcpxml") else ""

    def q(tag: str) -> str:
        return f"{namespace_prefix}{tag}" if namespace_prefix else tag

    current_end = _fraction_frames(sequence_element.get("duration"), frame_duration, "sequence duration")
    audio_end = max(int(clip["timeline_start"]) + int(clip["duration_frames"]) for clip in audio_clips)
    sequence_end = max(current_end, audio_end)
    _ensure_trailing_primary_gap(
        spine,
        current_end=current_end,
        required_end=sequence_end,
        frame_duration=frame_duration,
        q=q,
    )
    if sequence_end != current_end:
        sequence_element.set("duration", _format_time(sequence_end * frame_duration))
    _attach_audio_clips(spine, audio_clips, frame_duration=frame_duration, q=q)

    _write_xml_atomic(config.output_dir / TIMELINE_FCPXML_NAME, tree)
    report["audio_track_count"] = audio_track_count
    report["audio_clip_count"] = len(audio_clips)
    report["semantics"]["independent_audio_tracks_supported"] = True
    report["semantics"]["independent_audio_exported_as_connected_audio_only_assets"] = True
    report["semantics"]["embedded_asset_audio_preserved"] = True
    _write_json_atomic(config.output_dir / TIMELINE_REPORT_NAME, report)
    return report


__all__ = ["export_timeline_snapshot_with_audio"]
