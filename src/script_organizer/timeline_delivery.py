from __future__ import annotations

import copy
import json
import os
import tempfile
import xml.etree.ElementTree as ET
from fractions import Fraction
from pathlib import Path
from typing import Any

from .config import ProjectConfig


TIMELINE_DELIVERY_CONTRACT = "timeline_delivery_request.v1"
TIMELINE_DELIVERY_REPORT_CONTRACT = "timeline_delivery_report.v1"
TIMELINE_FCPXML_NAME = "timeline_organized.fcpxml"
TIMELINE_REPORT_NAME = "timeline_delivery_report.json"


class UnsafeTimelineDelivery(RuntimeError):
    """Raised when a Timeline snapshot cannot be represented without losing edit semantics."""


def _load_json(path: Path, fallback: object) -> object:
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return fallback


def _tag(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def _parse_time(value: object) -> Fraction | None:
    raw = str(value or "").strip().rstrip("s")
    if not raw:
        return None
    try:
        if "/" in raw:
            numerator, denominator = raw.split("/", 1)
            return Fraction(int(numerator), int(denominator))
        return Fraction(raw)
    except (ValueError, ZeroDivisionError):
        return None


def _format_time(value: Fraction) -> str:
    return f"{value.numerator}s" if value.denominator == 1 else f"{value.numerator}/{value.denominator}s"


def _positive_int(value: object, label: str) -> int:
    if isinstance(value, bool):
        raise UnsafeTimelineDelivery(f"{label} must be a positive integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise UnsafeTimelineDelivery(f"{label} must be a positive integer") from error
    if parsed <= 0 or str(parsed) != str(value).strip():
        raise UnsafeTimelineDelivery(f"{label} must be a positive integer")
    return parsed


def _non_negative_int(value: object, label: str) -> int:
    if isinstance(value, bool):
        raise UnsafeTimelineDelivery(f"{label} must be a non-negative integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise UnsafeTimelineDelivery(f"{label} must be a non-negative integer") from error
    if parsed < 0 or str(parsed) != str(value).strip():
        raise UnsafeTimelineDelivery(f"{label} must be a non-negative integer")
    return parsed


def _object(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise UnsafeTimelineDelivery(f"{label} must be an object")
    return value


def _list(value: object, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise UnsafeTimelineDelivery(f"{label} must be an array")
    return value


def _authority(request: dict[str, Any]) -> dict[str, Any]:
    authority = _object(request.get("authority"), "authority")
    generation = str(authority.get("generation", "") or "").strip()
    if not generation:
        raise UnsafeTimelineDelivery("authority.generation is required")
    revision = _non_negative_int(authority.get("revision"), "authority.revision")
    return {"generation": generation, "revision": revision}


def _active_sequence(project: dict[str, Any]) -> dict[str, Any]:
    sequences = [_object(item, "timeline sequence") for item in _list(project.get("sequences"), "timeline.sequences")]
    if not sequences:
        raise UnsafeTimelineDelivery("Timeline has no sequence")
    active_id = str(project.get("active_sequence_id", "") or "")
    sequence = next((item for item in sequences if str(item.get("sequence_id", "") or "") == active_id), None)
    if sequence is None:
        if len(sequences) != 1:
            raise UnsafeTimelineDelivery("Timeline active_sequence_id does not resolve uniquely")
        sequence = sequences[0]
    return sequence


def _frame_duration(sequence: dict[str, Any]) -> Fraction:
    rate = _object(sequence.get("frame_rate"), "sequence.frame_rate")
    numerator = _positive_int(rate.get("numerator"), "frame_rate.numerator")
    denominator = _positive_int(rate.get("denominator"), "frame_rate.denominator")
    return Fraction(denominator, numerator)


def _validate_tracks(sequence: dict[str, Any]) -> list[dict[str, Any]]:
    tracks = [_object(item, "timeline track") for item in _list(sequence.get("tracks"), "sequence.tracks")]
    video_tracks = [item for item in tracks if str(item.get("kind", "")) == "video" and _list(item.get("clips", []), "track.clips")]
    if len(video_tracks) > 1:
        raise UnsafeTimelineDelivery("timeline_delivery.v1 supports exactly one non-empty video track")
    audio_tracks = [item for item in tracks if str(item.get("kind", "")) == "audio" and _list(item.get("clips", []), "track.clips")]
    if audio_tracks:
        raise UnsafeTimelineDelivery("timeline_delivery.v1 does not support independent audio-track clips")
    transitions = _list(sequence.get("transitions", []), "sequence.transitions")
    if transitions:
        raise UnsafeTimelineDelivery("timeline_delivery.v1 does not support transitions")
    return video_tracks


def _material_asset_map(config: ProjectConfig) -> dict[str, str]:
    payload = _load_json(config.output_dir / "material_index.json", {})
    if not isinstance(payload, dict):
        raise UnsafeTimelineDelivery("material_index.json is not a valid object")
    result: dict[str, str] = {}
    for raw in payload.get("clips", []):
        if not isinstance(raw, dict):
            continue
        clip_id = str(raw.get("clip_id", "") or "")
        asset_id = str(raw.get("source_asset_id", "") or "")
        if clip_id and asset_id:
            result[clip_id] = asset_id
    return result


def _source_map(project: dict[str, Any]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for raw in _list(project.get("sources"), "timeline.sources"):
        source = _object(raw, "timeline source")
        source_id = str(source.get("source_id", "") or "")
        clip_id = str(source.get("clip_id", "") or "")
        if not source_id or not clip_id:
            raise UnsafeTimelineDelivery("Timeline source requires source_id and clip_id")
        if source_id in result:
            raise UnsafeTimelineDelivery(f"duplicate Timeline source_id: {source_id}")
        result[source_id] = source
    return result


def _source_assets(root: ET.Element) -> tuple[ET.Element, dict[str, ET.Element], dict[str, Fraction]]:
    resources = next((item for item in root if _tag(item) == "resources"), None)
    if resources is None:
        raise UnsafeTimelineDelivery("source FCPXML has no resources")
    assets: dict[str, ET.Element] = {}
    formats: dict[str, Fraction] = {}
    for item in resources:
        kind = _tag(item)
        item_id = str(item.get("id", "") or "")
        if kind == "asset" and item_id:
            assets[item_id] = item
        elif kind == "format" and item_id:
            duration = _parse_time(item.get("frameDuration"))
            if duration is not None and duration > 0:
                formats[item_id] = duration
    return resources, assets, formats


def _matching_format_id(formats: dict[str, Fraction], frame_duration: Fraction) -> str:
    matches = [format_id for format_id, duration in formats.items() if duration == frame_duration]
    if not matches:
        raise UnsafeTimelineDelivery(
            f"source FCPXML has no format matching Timeline frame duration {_format_time(frame_duration)}"
        )
    return sorted(matches)[0]


def _asset_bounds(asset: ET.Element) -> tuple[Fraction, Fraction | None]:
    start = _parse_time(asset.get("start")) or Fraction(0)
    duration = _parse_time(asset.get("duration"))
    end = start + duration if duration is not None and duration >= 0 else None
    return start, end


def _timeline_clips(
    video_tracks: list[dict[str, Any]],
    sources: dict[str, dict[str, Any]],
    clip_assets: dict[str, str],
    assets: dict[str, ET.Element],
    frame_duration: Fraction,
) -> tuple[list[dict[str, Any]], int]:
    if not video_tracks:
        return [], 0
    raw_clips = _list(video_tracks[0].get("clips", []), "video track clips")
    clips: list[dict[str, Any]] = []
    flattened_multicam = 0
    seen_ids: set[str] = set()
    for raw in raw_clips:
        clip = _object(raw, "timeline clip")
        clip_id = str(clip.get("clip_id", "") or "")
        if not clip_id or clip_id in seen_ids:
            raise UnsafeTimelineDelivery(f"invalid or duplicate Timeline clip_id: {clip_id or '<empty>'}")
        seen_ids.add(clip_id)
        if clip.get("enabled") is False:
            continue
        source_id = str(clip.get("selected_angle_source_id", "") or clip.get("source_id", "") or "")
        source = sources.get(source_id)
        if source is None:
            raise UnsafeTimelineDelivery(f"Timeline clip references unknown active source: {clip_id} -> {source_id}")
        source_clip_id = str(source.get("clip_id", "") or "")
        asset_id = clip_assets.get(source_clip_id, "")
        if not asset_id:
            raise UnsafeTimelineDelivery(f"Timeline source has no material-index FCPXML asset mapping: {source_clip_id}")
        asset = assets.get(asset_id)
        if asset is None:
            raise UnsafeTimelineDelivery(f"Timeline source asset is missing from source FCPXML resources: {asset_id}")

        timeline_start = _non_negative_int(clip.get("timeline_start"), f"clip {clip_id} timeline_start")
        source_in = _non_negative_int(clip.get("source_in"), f"clip {clip_id} source_in")
        duration = _positive_int(clip.get("duration"), f"clip {clip_id} duration")
        source_start = source_in * frame_duration
        source_duration = duration * frame_duration
        asset_start, asset_end = _asset_bounds(asset)
        if source_start < asset_start:
            raise UnsafeTimelineDelivery(f"Timeline clip source_in precedes asset start: {clip_id}")
        if asset_end is not None and source_start + source_duration > asset_end:
            raise UnsafeTimelineDelivery(f"Timeline clip source range exceeds asset duration: {clip_id}")
        if clip.get("multicam_group_id"):
            flattened_multicam += 1
        clips.append(
            {
                "clip_id": clip_id,
                "name": str(source.get("name", "") or source_clip_id),
                "asset_id": asset_id,
                "timeline_start": timeline_start,
                "source_start": source_start,
                "duration": source_duration,
                "frame_duration": frame_duration,
            }
        )

    clips.sort(key=lambda item: (item["timeline_start"], item["clip_id"]))
    previous_end = 0
    for clip in clips:
        start = int(clip["timeline_start"])
        duration_frames = int(clip["duration"] / frame_duration)
        if start < previous_end:
            raise UnsafeTimelineDelivery(f"Timeline video clips overlap around {clip['clip_id']}")
        previous_end = start + duration_frames
    return clips, flattened_multicam


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _write_xml_atomic(path: Path, tree: ET.ElementTree) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    os.close(fd)
    try:
        tree.write(temporary, encoding="utf-8", xml_declaration=True)
        ET.parse(temporary)
        os.replace(temporary, path)
    except Exception:
        Path(temporary).unlink(missing_ok=True)
        raise


def export_timeline_snapshot(
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
    sequence = _active_sequence(timeline)
    frame_duration = _frame_duration(sequence)
    video_tracks = _validate_tracks(sequence)
    sources = _source_map(timeline)
    clip_assets = _material_asset_map(config)
    if not config.fcpxml or not config.fcpxml.is_file():
        raise UnsafeTimelineDelivery("Timeline FCPXML delivery requires the original source FCPXML")
    try:
        source_tree = ET.parse(config.fcpxml)
    except (OSError, ET.ParseError) as error:
        raise UnsafeTimelineDelivery(f"cannot parse source FCPXML safely: {error}") from error
    source_root = source_tree.getroot()
    resources, assets, formats = _source_assets(source_root)
    format_id = _matching_format_id(formats, frame_duration)
    clips, flattened_multicam = _timeline_clips(
        video_tracks,
        sources,
        clip_assets,
        assets,
        frame_duration,
    )

    namespace_prefix = source_root.tag[:-len("fcpxml")] if source_root.tag.endswith("fcpxml") else ""
    def q(tag: str) -> str:
        return f"{namespace_prefix}{tag}" if namespace_prefix else tag

    output_root = ET.Element(source_root.tag, dict(source_root.attrib))
    output_root.append(copy.deepcopy(resources))
    library = ET.SubElement(output_root, q("library"))
    event = ET.SubElement(library, q("event"), {"name": "MirrorOrder Timeline Delivery"})
    project = ET.SubElement(event, q("project"), {"name": f"{config.name} · Timeline"})
    sequence_end_frames = max((int(item["timeline_start"]) + int(item["duration"] / frame_duration) for item in clips), default=0)
    sequence_element = ET.SubElement(
        project,
        q("sequence"),
        {
            "format": format_id,
            "duration": _format_time(sequence_end_frames * frame_duration),
        },
    )
    spine = ET.SubElement(sequence_element, q("spine"))
    cursor = 0
    for clip in clips:
        timeline_start = int(clip["timeline_start"])
        duration_frames = int(clip["duration"] / frame_duration)
        if timeline_start > cursor:
            gap_frames = timeline_start - cursor
            ET.SubElement(
                spine,
                q("gap"),
                {
                    "name": "MirrorOrder Gap",
                    "offset": _format_time(cursor * frame_duration),
                    "duration": _format_time(gap_frames * frame_duration),
                },
            )
        ET.SubElement(
            spine,
            q("asset-clip"),
            {
                "name": str(clip["name"]),
                "ref": str(clip["asset_id"]),
                "offset": _format_time(timeline_start * frame_duration),
                "start": _format_time(clip["source_start"]),
                "duration": _format_time(clip["duration"]),
            },
        )
        cursor = timeline_start + duration_frames

    output_path = config.output_dir / TIMELINE_FCPXML_NAME
    report_path = config.output_dir / TIMELINE_REPORT_NAME
    _write_xml_atomic(output_path, ET.ElementTree(output_root))
    report: dict[str, Any] = {
        "version": 1,
        "contract": TIMELINE_DELIVERY_REPORT_CONTRACT,
        "artifact_scope": "project_output",
        "organized_fcpxml": TIMELINE_FCPXML_NAME,
        "timeline_authority": authority,
        "timeline_project_id": project_id,
        "sequence_id": str(sequence.get("sequence_id", "") or ""),
        "frame_rate": {
            "numerator": _positive_int(_object(sequence.get("frame_rate"), "sequence.frame_rate").get("numerator"), "frame_rate.numerator"),
            "denominator": _positive_int(_object(sequence.get("frame_rate"), "sequence.frame_rate").get("denominator"), "frame_rate.denominator"),
        },
        "video_clip_count": len(clips),
        "multicam_flattened_count": flattened_multicam,
        "markers_not_exported": len(_list(sequence.get("markers", []), "sequence.markers")),
        "semantics": {
            "source_resources_preserved": True,
            "timeline_positions_preserved": True,
            "source_ranges_preserved": True,
            "selected_multicam_angles_flattened_to_assets": True,
            "independent_audio_tracks_supported": False,
            "transitions_supported": False,
            "markers_are_delivery_authority": False,
            "device_paths_exposed": False,
            "artifact_refs_are_project_output_relative": True,
        },
    }
    _write_json_atomic(report_path, report)
    return report


__all__ = [
    "TIMELINE_DELIVERY_CONTRACT",
    "TIMELINE_DELIVERY_REPORT_CONTRACT",
    "TIMELINE_FCPXML_NAME",
    "TIMELINE_REPORT_NAME",
    "UnsafeTimelineDelivery",
    "export_timeline_snapshot",
]
