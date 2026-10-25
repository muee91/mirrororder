from __future__ import annotations

import copy
import xml.etree.ElementTree as ET
from typing import Any

from ..config import ProjectConfig
from ..nle_sequence_ir import NLE_SEQUENCE_IR_CONTRACT, UnsafeNLESequenceIR, build_nle_sequence_ir
from .delivery_support import (
    TIMELINE_DELIVERY_CONTRACT,
    TIMELINE_FCPXML_NAME,
    TIMELINE_REPORT_NAME,
    UnsafeTimelineDelivery,
    _authority,
    _format_time,
    _object,
    _sequence_attributes,
    _source_assets,
    _tag,
    _write_json_atomic,
    _write_xml_atomic,
)
from .fcpxml_resources import (
    binding_index,
    build_multicam_resources,
    frame_duration,
    group_index,
    source_index,
    tracks,
)
from .fcpxml_storyline import append_gap, attach_audio, attach_markers, primary_video_item


TIMELINE_DELIVERY_REPORT_V2_CONTRACT = "timeline_delivery_report.v2"


def export_nle_sequence_ir(
    config: ProjectConfig,
    ir: dict[str, Any],
    *,
    authority: dict[str, Any],
) -> dict[str, Any]:
    if str(ir.get("contract", "") or "") != NLE_SEQUENCE_IR_CONTRACT:
        raise UnsafeTimelineDelivery(f"expected NLE contract {NLE_SEQUENCE_IR_CONTRACT}")
    if ir.get("transitions"):
        raise UnsafeTimelineDelivery("FCPXML Timeline adapter does not support transitions")

    duration_per_frame = frame_duration(ir)
    sources = source_index(ir)
    groups = group_index(ir)
    video_tracks = tracks(ir, "video")
    audio_tracks = tracks(ir, "audio")
    if len(video_tracks) != 1:
        raise UnsafeTimelineDelivery("FCPXML Timeline adapter requires exactly one non-empty video track")
    video_clips = [_object(raw, "nle video clip") for raw in video_tracks[0].get("clips", [])]
    if not video_clips:
        raise UnsafeTimelineDelivery("FCPXML Timeline adapter requires at least one video clip")

    if not config.fcpxml or not config.fcpxml.is_file():
        raise UnsafeTimelineDelivery("Timeline FCPXML delivery requires the original source FCPXML")
    try:
        source_tree = ET.parse(config.fcpxml)
    except (OSError, ET.ParseError) as error:
        raise UnsafeTimelineDelivery(f"cannot parse source FCPXML safely: {error}") from error
    source_root = source_tree.getroot()
    source_resources, assets, formats = _source_assets(source_root)
    sequence_attrs = _sequence_attributes(source_root, formats, duration_per_frame)
    bindings = binding_index(config, sources, assets)

    namespace_prefix = source_root.tag[:-len("fcpxml")] if source_root.tag.endswith("fcpxml") else ""

    def q(tag: str) -> str:
        return f"{namespace_prefix}{tag}" if namespace_prefix else tag

    output_root = ET.Element(source_root.tag, dict(source_root.attrib))
    resources = copy.deepcopy(source_resources)
    output_root.append(resources)
    used_group_ids = {
        str(clip.get("multicam_group_id", "") or "")
        for clip in video_clips
        if clip.get("multicam_group_id") is not None
    }
    used_group_ids.discard("")
    multicams = build_multicam_resources(
        resources,
        groups=groups,
        bindings=bindings,
        used_group_ids=used_group_ids,
        sequence_format=str(sequence_attrs["format"]),
        tc_format=str(sequence_attrs.get("tcFormat", "NDF") or "NDF"),
        frame_duration=duration_per_frame,
        q=q,
    )

    marker_list = [_object(raw, "nle marker") for raw in ir.get("markers", [])]
    audio_end = max(
        (int(clip["timeline_start"]) + int(clip["duration"]) for track in audio_tracks for clip in track.get("clips", [])),
        default=0,
    )
    marker_end = max(
        (int(marker["position"]) + max(1, int(marker.get("duration", 0))) for marker in marker_list),
        default=0,
    )
    video_end = max(int(clip["timeline_start"]) + int(clip["duration"]) for clip in video_clips)
    sequence_end_frames = max(video_end, audio_end, marker_end)

    library = ET.SubElement(output_root, q("library"))
    event = ET.SubElement(library, q("event"), {"name": "MirrorOrder Timeline Delivery"})
    project = ET.SubElement(event, q("project"), {"name": f"{config.name} · Timeline"})
    sequence_element = ET.SubElement(
        project,
        q("sequence"),
        {**sequence_attrs, "duration": _format_time(sequence_end_frames * duration_per_frame)},
    )
    spine = ET.SubElement(sequence_element, q("spine"))

    segments: list[dict[str, Any]] = []
    cursor = 0
    disabled_video_count = 0
    multicam_clip_count = 0
    for clip in sorted(video_clips, key=lambda item: (int(item["timeline_start"]), str(item.get("clip_id", "")))):
        timeline_start = int(clip["timeline_start"])
        duration_frames = int(clip["duration"])
        if timeline_start > cursor:
            segments.append(
                append_gap(
                    spine,
                    start=cursor,
                    duration=timeline_start - cursor,
                    frame_duration=duration_per_frame,
                    q=q,
                )
            )
        segment = primary_video_item(
            spine,
            clip,
            bindings=bindings,
            multicams=multicams,
            frame_duration=duration_per_frame,
            q=q,
        )
        segments.append(segment)
        if clip.get("enabled") is False:
            disabled_video_count += 1
        if clip.get("multicam_group_id") is not None:
            multicam_clip_count += 1
        cursor = timeline_start + duration_frames
    if cursor < sequence_end_frames:
        segments.append(
            append_gap(
                spine,
                start=cursor,
                duration=sequence_end_frames - cursor,
                frame_duration=duration_per_frame,
                q=q,
            )
        )

    audio_track_count, audio_clip_count, disabled_audio_count = attach_audio(
        segments,
        audio_tracks,
        bindings=bindings,
        frame_duration=duration_per_frame,
        q=q,
    )
    marker_count = attach_markers(segments, marker_list, frame_duration=duration_per_frame, q=q)

    output_path = config.output_dir / TIMELINE_FCPXML_NAME
    report_path = config.output_dir / TIMELINE_REPORT_NAME
    _write_xml_atomic(output_path, ET.ElementTree(output_root))
    report: dict[str, Any] = {
        "version": 2,
        "contract": TIMELINE_DELIVERY_REPORT_V2_CONTRACT,
        "artifact_scope": "project_output",
        "organized_fcpxml": TIMELINE_FCPXML_NAME,
        "timeline_authority": authority,
        "nle_sequence_contract": NLE_SEQUENCE_IR_CONTRACT,
        "timeline_project_id": str(ir.get("project_id", "") or ""),
        "sequence_id": str(ir.get("sequence_id", "") or ""),
        "frame_rate": dict(ir.get("frame_rate", {})),
        "video_clip_count": len(video_clips),
        "audio_track_count": audio_track_count,
        "audio_clip_count": audio_clip_count,
        "multicam_resource_count": len(multicams),
        "multicam_clip_count": multicam_clip_count,
        "multicam_flattened_count": 0,
        "marker_count": marker_count,
        "markers_not_exported": 0,
        "disabled_clip_count": disabled_video_count + disabled_audio_count,
        "device_paths_exposed": False,
        "semantics": {
            "source_resources_preserved": True,
            "timeline_positions_preserved": True,
            "source_ranges_preserved": True,
            "multicam_structure_preserved": True,
            "selected_multicam_angles_preserved": True,
            "selected_multicam_angles_flattened_to_assets": False,
            "embedded_asset_audio_preserved": True,
            "independent_audio_tracks_supported": True,
            "independent_audio_exported_as_connected_audio_only_assets": True,
            "markers_preserved": True,
            "disabled_clips_preserved": True,
            "transitions_supported": False,
            "device_paths_exposed": False,
            "artifact_refs_are_project_output_relative": True,
        },
    }
    _write_json_atomic(report_path, report)
    return report


def export_timeline_delivery(
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
    return export_nle_sequence_ir(config, ir, authority=authority)
