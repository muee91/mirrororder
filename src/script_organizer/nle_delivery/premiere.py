from __future__ import annotations

import os
import re
import urllib.parse
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from ..config import ProjectConfig
from ..fcpxml_reader import _asset_media_path
from ..nle_sequence_ir import NLE_SEQUENCE_IR_CONTRACT, UnsafeNLESequenceIR, build_nle_sequence_ir
from .delivery_support import (
    TIMELINE_DELIVERY_CONTRACT,
    UnsafeTimelineDelivery,
    _authority,
    _object,
    _sequence_attributes,
    _source_assets,
    _write_json_atomic,
)
from .fcpxml_resources import (
    binding_index,
    frame_duration,
    group_index,
    source_index,
    tracks,
    validate_source_range,
)


PREMIERE_XMEML_NAME = "timeline_premiere.xml"
PREMIERE_REPORT_NAME = "timeline_premiere_export_report.json"
PREMIERE_REPORT_CONTRACT = "premiere_timeline_delivery_report.v1"
_WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:[/\\]")


def _rate(parent: ET.Element, rate: dict[str, Any]) -> None:
    numerator = int(rate["numerator"])
    denominator = int(rate["denominator"])
    node = ET.SubElement(parent, "rate")
    ET.SubElement(node, "timebase").text = str(numerator if denominator == 1 else f"{numerator}/{denominator}")
    ET.SubElement(node, "ntsc").text = "FALSE" if denominator == 1 else "TRUE"


def _local_pathurl(path: str) -> str:
    value = str(path or "").strip()
    if not value:
        raise UnsafeTimelineDelivery("Premiere XMEML source asset has no local media path")
    normalized = value.replace("\\", "/")
    if _WINDOWS_DRIVE.match(normalized):
        normalized = "/" + normalized
    elif not normalized.startswith("/"):
        raise UnsafeTimelineDelivery(f"Premiere XMEML requires a resolved absolute local media path: {value}")
    return "file://localhost" + urllib.parse.quote(normalized, safe="/:@-._~")


def _file_duration_frames(binding: dict[str, Any], frame_seconds) -> int:
    source = _object(binding.get("source"), "premiere source")
    explicit = source.get("duration_frames")
    if explicit is not None:
        value = int(explicit)
        if value <= 0:
            raise UnsafeTimelineDelivery("Premiere source duration_frames must be positive")
        return value
    asset = binding["asset"]
    raw = str(asset.get("duration", "") or "").rstrip("s")
    if not raw:
        raise UnsafeTimelineDelivery("Premiere XMEML requires source duration evidence")
    from fractions import Fraction

    duration_seconds = Fraction(raw)
    frames = duration_seconds / frame_seconds
    if frames.denominator != 1 or frames <= 0:
        raise UnsafeTimelineDelivery("Premiere source duration must resolve to an integer frame count")
    return int(frames)


def _dimensions(root: ET.Element, format_id: str) -> tuple[str | None, str | None]:
    fmt = next(
        (
            item
            for item in root.iter()
            if item.tag.rsplit("}", 1)[-1] == "format" and str(item.get("id", "") or "") == format_id
        ),
        None,
    )
    if fmt is None:
        return None, None
    width = str(fmt.get("width", "") or "").strip() or None
    height = str(fmt.get("height", "") or "").strip() or None
    return width, height


def _bindings_with_paths(
    config: ProjectConfig,
    ir: dict[str, Any],
    assets: dict[str, ET.Element],
    frame_seconds,
) -> dict[str, dict[str, Any]]:
    result = binding_index(config, source_index(ir), assets)
    document_dir = Path(config.fcpxml).resolve().parent
    for source_id, binding in result.items():
        path = _asset_media_path(binding["asset"], document_dir)
        binding["pathurl"] = _local_pathurl(path)
        binding["file_duration_frames"] = _file_duration_frames(binding, frame_seconds)
        binding["file_id"] = f"mo_file_{len([key for key in result if key < source_id]) + 1}"
        binding["frame_seconds"] = frame_seconds
    return result


def _file_block(
    clipitem: ET.Element,
    *,
    binding: dict[str, Any],
    rate: dict[str, Any],
    width: str | None,
    height: str | None,
) -> None:
    source = binding["source"]
    asset = binding["asset"]
    file_node = ET.SubElement(clipitem, "file", {"id": str(binding["file_id"])})
    ET.SubElement(file_node, "name").text = str(source.get("name", "") or source.get("clip_id", "") or source.get("source_id", ""))
    ET.SubElement(file_node, "pathurl").text = str(binding["pathurl"])
    _rate(file_node, rate)
    ET.SubElement(file_node, "duration").text = str(binding["file_duration_frames"])
    media = ET.SubElement(file_node, "media")
    video = ET.SubElement(media, "video")
    if width or height:
        sample = ET.SubElement(video, "samplecharacteristics")
        if width:
            ET.SubElement(sample, "width").text = width
        if height:
            ET.SubElement(sample, "height").text = height
        ET.SubElement(sample, "anamorphic").text = "FALSE"
    if str(asset.get("hasAudio", "") or "").strip() != "0":
        audio = ET.SubElement(media, "audio")
        rate_value = str(asset.get("audioRate", "") or "").strip()
        channels = str(asset.get("audioChannels", "") or "").strip()
        if rate_value or channels:
            sample = ET.SubElement(audio, "samplecharacteristics")
            if rate_value:
                ET.SubElement(sample, "samplerate").text = rate_value
            if channels:
                ET.SubElement(sample, "channelcount").text = channels


def _clipitem(
    track: ET.Element,
    *,
    clip_id: str,
    binding: dict[str, Any],
    timeline_start: int,
    duration: int,
    source_in: int,
    enabled: bool,
    rate: dict[str, Any],
    width: str | None,
    height: str | None,
) -> None:
    validate_source_range(
        binding,
        start_frame=source_in,
        duration_frames=duration,
        frame_duration=binding["frame_seconds"],
        label=f"Premiere clipitem {clip_id}",
    )
    item = ET.SubElement(track, "clipitem", {"id": clip_id})
    ET.SubElement(item, "name").text = str(binding["source"].get("name", "") or binding["source"].get("clip_id", ""))
    ET.SubElement(item, "start").text = str(timeline_start)
    ET.SubElement(item, "end").text = str(timeline_start + duration)
    ET.SubElement(item, "in").text = str(source_in)
    ET.SubElement(item, "out").text = str(source_in + duration)
    _rate(item, rate)
    ET.SubElement(item, "enabled").text = "TRUE" if enabled else "FALSE"
    _file_block(item, binding=binding, rate=rate, width=width, height=height)


def _multicam_local_range(clip: dict[str, Any], group: dict[str, Any], source_id: str) -> tuple[int, int]:
    angles = {str(item.get("source_id", "") or ""): item for item in group.get("angles", [])}
    base_source_id = str(clip.get("source_id", "") or "")
    base = angles.get(base_source_id)
    target = angles.get(source_id)
    if base is None or target is None:
        raise UnsafeTimelineDelivery("Premiere multicam clip lacks typed angle evidence")
    if base.get("sync_start_frame") is None or base.get("sync_end_frame") is None:
        raise UnsafeTimelineDelivery("Premiere multicam base angle lacks typed sync range")
    if target.get("sync_start_frame") is None or target.get("sync_end_frame") is None:
        raise UnsafeTimelineDelivery("Premiere multicam target angle lacks typed sync range")
    local = int(clip["source_in"]) - int(base["sync_start_frame"])
    duration = int(clip["duration"])
    base_span = int(base["sync_end_frame"]) - int(base["sync_start_frame"])
    target_span = int(target["sync_end_frame"]) - int(target["sync_start_frame"])
    if local < 0 or local + duration > base_span or local + duration > target_span:
        raise UnsafeTimelineDelivery("Premiere multicam clip exceeds typed sync range")
    return int(target["sync_start_frame"]) + local, duration


def _append_sequence_header(
    parent: ET.Element,
    *,
    sequence_id: str,
    name: str,
    duration: int,
    rate: dict[str, Any],
    width: str | None,
    height: str | None,
) -> tuple[ET.Element, ET.Element, ET.Element]:
    sequence = ET.SubElement(parent, "sequence", {"id": sequence_id})
    ET.SubElement(sequence, "name").text = name
    ET.SubElement(sequence, "duration").text = str(duration)
    _rate(sequence, rate)
    media = ET.SubElement(sequence, "media")
    video = ET.SubElement(media, "video")
    if width or height:
        fmt = ET.SubElement(video, "format")
        sample = ET.SubElement(fmt, "samplecharacteristics")
        if width:
            ET.SubElement(sample, "width").text = width
        if height:
            ET.SubElement(sample, "height").text = height
    audio = ET.SubElement(media, "audio")
    return sequence, video, audio


def _build_edit_sequence(
    parent: ET.Element,
    *,
    ir: dict[str, Any],
    bindings: dict[str, dict[str, Any]],
    groups: dict[str, dict[str, Any]],
    video_clips: list[dict[str, Any]],
    audio_tracks: list[dict[str, Any]],
    duration: int,
    rate: dict[str, Any],
    width: str | None,
    height: str | None,
) -> None:
    _, video, audio = _append_sequence_header(
        parent,
        sequence_id="mo_edit",
        name=f"{ir.get('name', 'MirrorOrder')} · Edit",
        duration=duration,
        rate=rate,
        width=width,
        height=height,
    )
    video_track = ET.SubElement(video, "track")
    for index, clip in enumerate(video_clips, start=1):
        source_id = str(clip.get("source_id", "") or "")
        source_in = int(clip["source_in"])
        if clip.get("multicam_group_id") is not None:
            group = groups[str(clip["multicam_group_id"])]
            selected = str(clip.get("selected_angle_source_id", "") or "")
            if not selected:
                raise UnsafeTimelineDelivery(f"Premiere delivery requires explicit selected multicam angle: {clip.get('clip_id')}")
            source_id = selected
            source_in, _ = _multicam_local_range(clip, group, selected)
        _clipitem(
            video_track,
            clip_id=f"mo_edit_v_{index}",
            binding=bindings[source_id],
            timeline_start=int(clip["timeline_start"]),
            duration=int(clip["duration"]),
            source_in=source_in,
            enabled=bool(clip.get("enabled", True)),
            rate=rate,
            width=width,
            height=height,
        )
    for lane, source_track in enumerate(audio_tracks, start=1):
        track = ET.SubElement(audio, "track")
        for index, clip in enumerate(source_track.get("clips", []), start=1):
            if clip.get("multicam_group_id") is not None or clip.get("selected_angle_source_id") is not None:
                raise UnsafeTimelineDelivery("Premiere independent audio clip must reference one explicit source")
            source_id = str(clip.get("source_id", "") or "")
            _clipitem(
                track,
                clip_id=f"mo_edit_a_{lane}_{index}",
                binding=bindings[source_id],
                timeline_start=int(clip["timeline_start"]),
                duration=int(clip["duration"]),
                source_in=int(clip["source_in"]),
                enabled=bool(clip.get("enabled", True)),
                rate=rate,
                width=width,
                height=height,
            )


def _camera_key(angle: dict[str, Any]) -> str:
    return str(angle.get("camera", "") or angle.get("name", "") or angle.get("source_id", "") or "unknown")


def _build_multicam_source_sequence(
    parent: ET.Element,
    *,
    ir: dict[str, Any],
    bindings: dict[str, dict[str, Any]],
    groups: dict[str, dict[str, Any]],
    video_clips: list[dict[str, Any]],
    duration: int,
    rate: dict[str, Any],
    width: str | None,
    height: str | None,
) -> int:
    multicam_clips = [clip for clip in video_clips if clip.get("multicam_group_id") is not None]
    if not multicam_clips:
        return 0
    _, video, audio = _append_sequence_header(
        parent,
        sequence_id="mo_multicam_sources",
        name=f"{ir.get('name', 'MirrorOrder')} · Multicam Sources",
        duration=duration,
        rate=rate,
        width=width,
        height=height,
    )
    angle_keys: set[str] = set()
    for clip in multicam_clips:
        group = groups[str(clip["multicam_group_id"])]
        for angle in group.get("angles", []):
            angle_keys.add(_camera_key(angle))
    ordered_keys = sorted(angle_keys)
    video_tracks = {key: ET.SubElement(video, "track") for key in ordered_keys}
    audio_tracks = {key: ET.SubElement(audio, "track") for key in ordered_keys}
    written = 0
    for clip_index, clip in enumerate(multicam_clips, start=1):
        group = groups[str(clip["multicam_group_id"])]
        selected = str(clip.get("selected_angle_source_id", "") or "")
        if not selected:
            raise UnsafeTimelineDelivery(f"Premiere delivery requires explicit selected multicam angle: {clip.get('clip_id')}")
        audio_source = str(group.get("audio_source_id", "") or selected)
        group_source_ids = {str(angle.get("source_id", "") or "") for angle in group.get("angles", [])}
        if audio_source not in group_source_ids:
            raise UnsafeTimelineDelivery(
                f"Premiere multicam audio source lacks typed angle evidence: {group.get('group_id')} -> {audio_source}"
            )
        for angle_index, angle in enumerate(group.get("angles", []), start=1):
            source_id = str(angle.get("source_id", "") or "")
            source_in, clip_duration = _multicam_local_range(clip, group, source_id)
            key = _camera_key(angle)
            enabled = bool(clip.get("enabled", True)) and source_id == selected
            _clipitem(
                video_tracks[key],
                clip_id=f"mo_mc_v_{clip_index}_{angle_index}",
                binding=bindings[source_id],
                timeline_start=int(clip["timeline_start"]),
                duration=clip_duration,
                source_in=source_in,
                enabled=enabled,
                rate=rate,
                width=width,
                height=height,
            )
            if str(bindings[source_id]["asset"].get("hasAudio", "") or "").strip() != "0":
                _clipitem(
                    audio_tracks[key],
                    clip_id=f"mo_mc_a_{clip_index}_{angle_index}",
                    binding=bindings[source_id],
                    timeline_start=int(clip["timeline_start"]),
                    duration=clip_duration,
                    source_in=source_in,
                    enabled=bool(clip.get("enabled", True)) and source_id == audio_source,
                    rate=rate,
                    width=width,
                    height=height,
                )
            written += 1
    return written


def _write_xmeml_atomic(path: Path, root: ET.Element) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    body = ET.tostring(root, encoding="utf-8", xml_declaration=False)
    payload = b'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + body + b"\n"
    with open(temporary, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def export_nle_sequence_ir_to_premiere(
    config: ProjectConfig,
    ir: dict[str, Any],
    *,
    authority: dict[str, Any],
) -> dict[str, Any]:
    if str(ir.get("contract", "") or "") != NLE_SEQUENCE_IR_CONTRACT:
        raise UnsafeTimelineDelivery(f"expected NLE contract {NLE_SEQUENCE_IR_CONTRACT}")
    if ir.get("transitions"):
        raise UnsafeTimelineDelivery("Premiere XMEML adapter does not support transitions")
    video_tracks = tracks(ir, "video")
    audio_tracks = tracks(ir, "audio")
    if len(video_tracks) != 1:
        raise UnsafeTimelineDelivery("Premiere XMEML adapter requires exactly one non-empty edit video track")
    video_clips = [_object(raw, "nle video clip") for raw in video_tracks[0].get("clips", [])]
    if not video_clips:
        raise UnsafeTimelineDelivery("Premiere XMEML adapter requires at least one video clip")
    if not config.fcpxml or not config.fcpxml.is_file():
        raise UnsafeTimelineDelivery("Premiere XMEML delivery requires the original source FCPXML")

    frame_seconds = frame_duration(ir)
    rate = dict(ir.get("frame_rate", {}))
    source_root = ET.parse(config.fcpxml).getroot()
    _, assets, formats = _source_assets(source_root)
    sequence_attrs = _sequence_attributes(source_root, formats, frame_seconds)
    width, height = _dimensions(source_root, str(sequence_attrs.get("format", "") or ""))
    bindings = _bindings_with_paths(config, ir, assets, frame_seconds)
    groups = group_index(ir)
    duration = max(
        [int(clip["timeline_start"]) + int(clip["duration"]) for clip in video_clips]
        + [int(clip["timeline_start"]) + int(clip["duration"]) for track in audio_tracks for clip in track.get("clips", [])]
    )

    root = ET.Element("xmeml", {"version": "4"})
    project = ET.SubElement(root, "project", {"id": "mirrororder_project"})
    ET.SubElement(project, "name").text = f"{config.name} · MirrorOrder"
    children = ET.SubElement(project, "children")
    _build_edit_sequence(
        children,
        ir=ir,
        bindings=bindings,
        groups=groups,
        video_clips=video_clips,
        audio_tracks=audio_tracks,
        duration=duration,
        rate=rate,
        width=width,
        height=height,
    )
    multicam_source_clip_count = _build_multicam_source_sequence(
        children,
        ir=ir,
        bindings=bindings,
        groups=groups,
        video_clips=video_clips,
        duration=duration,
        rate=rate,
        width=width,
        height=height,
    )

    output_path = config.output_dir / PREMIERE_XMEML_NAME
    report_path = config.output_dir / PREMIERE_REPORT_NAME
    _write_xmeml_atomic(output_path, root)
    report = {
        "version": 1,
        "contract": PREMIERE_REPORT_CONTRACT,
        "artifact_scope": "project_output",
        "premiere_xmeml": PREMIERE_XMEML_NAME,
        "timeline_authority": authority,
        "nle_sequence_contract": NLE_SEQUENCE_IR_CONTRACT,
        "timeline_project_id": str(ir.get("project_id", "") or ""),
        "sequence_id": str(ir.get("sequence_id", "") or ""),
        "frame_rate": rate,
        "video_clip_count": len(video_clips),
        "audio_track_count": len(audio_tracks),
        "multicam_source_clip_count": multicam_source_clip_count,
        "multicam_source_sequence_written": multicam_source_clip_count > 0,
        "markers_not_exported": len(ir.get("markers", [])),
        "transitions_supported": False,
        "persisted_report_contains_device_paths": False,
        "interchange_contains_device_media_paths": True,
        "shared_project_paths_written": False,
        "semantics": {
            "edit_sequence_preserves_selected_angles": True,
            "multicam_source_sequence_preserves_all_typed_angles": multicam_source_clip_count > 0,
            "multicam_source_sequence_is_premiere_creation_source": multicam_source_clip_count > 0,
            "paths_resolved_only_at_export": True,
            "vendor_runtime_dependency": False,
        },
    }
    _write_json_atomic(report_path, report)
    return report


def export_timeline_premiere_delivery(
    config: ProjectConfig,
    request: dict[str, Any],
    *,
    expected_project_id: str,
) -> dict[str, Any]:
    if str(request.get("contract", "") or "") != TIMELINE_DELIVERY_CONTRACT:
        raise UnsafeTimelineDelivery(f"expected contract {TIMELINE_DELIVERY_CONTRACT}")
    authority = _authority(request)
    timeline = _object(request.get("timeline"), "timeline")
    project_id = str(timeline.get("project_id", "") or "")
    if project_id != expected_project_id:
        raise UnsafeTimelineDelivery(
            f"Timeline project_id mismatch: expected {expected_project_id}, got {project_id or '<empty>'}"
        )
    try:
        ir = build_nle_sequence_ir(timeline)
    except UnsafeNLESequenceIR as error:
        raise UnsafeTimelineDelivery(str(error)) from error
    return export_nle_sequence_ir_to_premiere(config, ir, authority=authority)
