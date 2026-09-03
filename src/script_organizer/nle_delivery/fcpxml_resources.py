from __future__ import annotations

import xml.etree.ElementTree as ET
from fractions import Fraction
from typing import Any

from ..config import ProjectConfig
from ..timeline_delivery import (
    UnsafeTimelineDelivery,
    _asset_bounds,
    _material_clip_map,
    _object,
    _parse_time,
    _format_time,
)


def positive_int(value: object, label: str) -> int:
    if isinstance(value, bool):
        raise UnsafeTimelineDelivery(f"{label} must be a positive integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise UnsafeTimelineDelivery(f"{label} must be a positive integer") from error
    if parsed <= 0 or str(parsed) != str(value).strip():
        raise UnsafeTimelineDelivery(f"{label} must be a positive integer")
    return parsed


def non_negative_int(value: object, label: str) -> int:
    if isinstance(value, bool):
        raise UnsafeTimelineDelivery(f"{label} must be a non-negative integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise UnsafeTimelineDelivery(f"{label} must be a non-negative integer") from error
    if parsed < 0 or str(parsed) != str(value).strip():
        raise UnsafeTimelineDelivery(f"{label} must be a non-negative integer")
    return parsed


def frame_duration(ir: dict[str, Any]) -> Fraction:
    rate = _object(ir.get("frame_rate"), "nle_sequence.frame_rate")
    numerator = positive_int(rate.get("numerator"), "frame_rate.numerator")
    denominator = positive_int(rate.get("denominator"), "frame_rate.denominator")
    return Fraction(denominator, numerator)


def source_index(ir: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for raw in ir.get("sources", []):
        source = _object(raw, "nle source")
        source_id = str(source.get("source_id", "") or "")
        if not source_id or source_id in result:
            raise UnsafeTimelineDelivery(f"invalid or duplicate NLE source_id: {source_id or '<empty>'}")
        result[source_id] = source
    return result


def group_index(ir: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for raw in ir.get("multicam_groups", []):
        group = _object(raw, "nle multicam group")
        group_id = str(group.get("group_id", "") or "")
        if not group_id or group_id in result:
            raise UnsafeTimelineDelivery(f"invalid or duplicate NLE multicam group_id: {group_id or '<empty>'}")
        result[group_id] = group
    return result


def tracks(ir: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for raw in ir.get("tracks", []):
        track = _object(raw, "nle track")
        clips = track.get("clips", [])
        if str(track.get("kind", "") or "") == kind and isinstance(clips, list) and clips:
            result.append(track)
    return result


def binding_index(
    config: ProjectConfig,
    sources: dict[str, dict[str, Any]],
    assets: dict[str, ET.Element],
) -> dict[str, dict[str, Any]]:
    material_clips = _material_clip_map(config)
    result: dict[str, dict[str, Any]] = {}
    for source_id, source in sources.items():
        clip_id = str(source.get("clip_id", "") or "")
        if not clip_id:
            raise UnsafeTimelineDelivery(f"NLE source requires clip_id: {source_id}")
        material = material_clips.get(clip_id)
        if material is None:
            raise UnsafeTimelineDelivery(f"NLE source has no material-index FCPXML asset mapping: {clip_id}")
        asset_id = str(material.get("source_asset_id", "") or "")
        asset = assets.get(asset_id)
        if asset is None:
            raise UnsafeTimelineDelivery(f"NLE source asset is missing from source FCPXML resources: {asset_id}")
        result[source_id] = {
            "source": source,
            "material": material,
            "asset_id": asset_id,
            "asset": asset,
        }
    return result


def validate_source_range(
    binding: dict[str, Any],
    *,
    start_frame: int,
    duration_frames: int,
    frame_duration: Fraction,
    label: str,
) -> tuple[Fraction, Fraction]:
    source = _object(binding.get("source"), f"{label} source")
    source_duration_frames = source.get("duration_frames")
    if source_duration_frames is not None:
        total_frames = positive_int(source_duration_frames, f"{label} source duration_frames")
        if start_frame + duration_frames > total_frames:
            raise UnsafeTimelineDelivery(f"{label} exceeds TimelineSource duration")

    start = start_frame * frame_duration
    duration = duration_frames * frame_duration
    material = _object(binding.get("material"), f"{label} material")
    occurrence_start = _parse_time(material.get("source_start"))
    occurrence_end = _parse_time(material.get("source_end"))
    if occurrence_start is not None and start < occurrence_start:
        raise UnsafeTimelineDelivery(f"{label} source range precedes material occurrence")
    if occurrence_end is not None and start + duration > occurrence_end:
        raise UnsafeTimelineDelivery(f"{label} exceeds material occurrence")

    asset = binding.get("asset")
    if not isinstance(asset, ET.Element):
        raise UnsafeTimelineDelivery(f"{label} asset is invalid")
    asset_start, asset_end = _asset_bounds(asset)
    if start < asset_start:
        raise UnsafeTimelineDelivery(f"{label} source range precedes asset start")
    if asset_end is not None and start + duration > asset_end:
        raise UnsafeTimelineDelivery(f"{label} exceeds asset duration")
    return start, duration


def _unique_resource_id(existing: set[str], prefix: str) -> str:
    index = 1
    while True:
        candidate = f"{prefix}_{index}"
        if candidate not in existing:
            existing.add(candidate)
            return candidate
        index += 1


def _typed_angles(group: dict[str, Any]) -> list[dict[str, Any]]:
    raw_angles = group.get("angles", [])
    if not isinstance(raw_angles, list) or len(raw_angles) < 2:
        raise UnsafeTimelineDelivery(
            f"FCPXML multicam requires at least two typed angles: {group.get('group_id', '<unknown>')}"
        )
    result: list[dict[str, Any]] = []
    for raw in raw_angles:
        angle = _object(raw, "nle multicam angle")
        source_id = str(angle.get("source_id", "") or "")
        start_raw = angle.get("sync_start_frame")
        end_raw = angle.get("sync_end_frame")
        if start_raw is None or end_raw is None:
            raise UnsafeTimelineDelivery(
                "FCPXML multicam requires typed sync range for every angle: "
                f"{group.get('group_id', '<unknown>')} -> {source_id or '<empty>'}"
            )
        start = non_negative_int(start_raw, f"multicam angle {source_id} sync_start_frame")
        end = positive_int(end_raw, f"multicam angle {source_id} sync_end_frame")
        if end <= start:
            raise UnsafeTimelineDelivery(f"invalid multicam typed sync range: {source_id}")
        result.append({**angle, "source_id": source_id, "sync_start_frame": start, "sync_end_frame": end})
    return result


def build_multicam_resources(
    resources: ET.Element,
    *,
    groups: dict[str, dict[str, Any]],
    bindings: dict[str, dict[str, Any]],
    used_group_ids: set[str],
    sequence_format: str,
    tc_format: str,
    frame_duration: Fraction,
    q,
) -> dict[str, dict[str, Any]]:
    existing_ids = {str(item.get("id", "") or "") for item in resources if str(item.get("id", "") or "")}
    result: dict[str, dict[str, Any]] = {}
    for group_id in sorted(used_group_ids):
        group = groups.get(group_id)
        if group is None:
            raise UnsafeTimelineDelivery(f"NLE clip references unknown multicam group: {group_id}")
        media_id = _unique_resource_id(existing_ids, "mo_multicam")
        media = ET.SubElement(resources, q("media"), {"id": media_id, "name": f"MirrorOrder {group_id}"})
        multicam = ET.SubElement(
            media,
            q("multicam"),
            {"format": sequence_format, "tcStart": "0s", "tcFormat": tc_format},
        )
        angle_ids: dict[str, str] = {}
        angle_ranges: dict[str, tuple[int, int]] = {}
        for angle_index, angle in enumerate(_typed_angles(group), start=1):
            source_id = str(angle["source_id"])
            binding = bindings.get(source_id)
            if binding is None:
                raise UnsafeTimelineDelivery(f"multicam angle has no source binding: {group_id} -> {source_id}")
            sync_start = int(angle["sync_start_frame"])
            sync_end = int(angle["sync_end_frame"])
            source_start, source_duration = validate_source_range(
                binding,
                start_frame=sync_start,
                duration_frames=sync_end - sync_start,
                frame_duration=frame_duration,
                label=f"multicam angle {group_id}/{source_id}",
            )
            angle_id = f"{media_id}_angle_{angle_index}"
            angle_ids[source_id] = angle_id
            angle_ranges[source_id] = (sync_start, sync_end)
            name = str(
                angle.get("camera", "")
                or angle.get("name", "")
                or binding["source"].get("name", "")
                or source_id
            )
            mc_angle = ET.SubElement(multicam, q("mc-angle"), {"name": name, "angleID": angle_id})
            ET.SubElement(
                mc_angle,
                q("asset-clip"),
                {
                    "name": str(binding["source"].get("name", "") or source_id),
                    "ref": str(binding["asset_id"]),
                    "offset": "0s",
                    "start": _format_time(source_start),
                    "duration": _format_time(source_duration),
                },
            )

        audio_source_id = group.get("audio_source_id")
        if audio_source_id is not None:
            audio_source_id = str(audio_source_id or "")
            if audio_source_id not in angle_ids:
                raise UnsafeTimelineDelivery(
                    "FCPXML multicam audio_source_id requires typed angle sync evidence: "
                    f"{group_id} -> {audio_source_id or '<empty>'}"
                )
        result[group_id] = {
            "media_id": media_id,
            "angle_ids": angle_ids,
            "angle_ranges": angle_ranges,
            "audio_source_id": audio_source_id,
        }
    return result
