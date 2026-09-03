from __future__ import annotations

import re
from typing import Any


NLE_SEQUENCE_IR_CONTRACT = "nle_sequence_ir.v1"
TIMELINE_PROJECT_VERSION = 2


class UnsafeNLESequenceIR(ValueError):
    """Raised when a Timeline snapshot cannot be projected losslessly into NLE-neutral IR."""


def _object(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise UnsafeNLESequenceIR(f"{label} must be an object")
    return value


def _list(value: object, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise UnsafeNLESequenceIR(f"{label} must be an array")
    return value


def _string(value: object, label: str, *, required: bool = False) -> str:
    result = str(value or "")
    if required and not result.strip():
        raise UnsafeNLESequenceIR(f"{label} is required")
    return result


def _integer(value: object, label: str, *, positive: bool = False) -> int:
    if isinstance(value, bool):
        raise UnsafeNLESequenceIR(f"{label} must be an integer")
    try:
        result = int(value)
    except (TypeError, ValueError) as error:
        raise UnsafeNLESequenceIR(f"{label} must be an integer") from error
    if str(result) != str(value).strip():
        raise UnsafeNLESequenceIR(f"{label} must be an integer")
    if positive and result <= 0:
        raise UnsafeNLESequenceIR(f"{label} must be a positive integer")
    if not positive and result < 0:
        raise UnsafeNLESequenceIR(f"{label} must be a non-negative integer")
    return result


def _optional_positive_integer(value: object, label: str) -> int | None:
    if value is None:
        return None
    return _integer(value, label, positive=True)


_WINDOWS_ABSOLUTE = re.compile(r"^[A-Za-z]:[\\/]")


def _looks_device_local_path(value: str) -> bool:
    stripped = value.strip()
    return bool(
        stripped.startswith("/")
        or stripped.startswith("file://")
        or stripped.startswith("\\\\")
        or _WINDOWS_ABSOLUTE.match(stripped)
    )


def _metadata(value: object, label: str) -> dict[str, str]:
    raw = _object(value if value is not None else {}, label)
    result: dict[str, str] = {}
    for key, item in raw.items():
        if not isinstance(key, str) or not isinstance(item, str):
            raise UnsafeNLESequenceIR(f"{label} must contain string keys and string values")
        if _looks_device_local_path(item):
            raise UnsafeNLESequenceIR(f"{label} must not contain device-local absolute paths")
        result[key] = item
    return result


def _active_sequence(timeline: dict[str, Any]) -> dict[str, Any]:
    sequences = [_object(item, "timeline sequence") for item in _list(timeline.get("sequences"), "timeline.sequences")]
    if not sequences:
        raise UnsafeNLESequenceIR("Timeline has no sequence")
    active_id = _string(timeline.get("active_sequence_id"), "active_sequence_id", required=True)
    matches = [item for item in sequences if _string(item.get("sequence_id"), "sequence_id") == active_id]
    if len(matches) != 1:
        raise UnsafeNLESequenceIR(f"Timeline active_sequence_id does not resolve uniquely: {active_id}")
    return matches[0]


def _frame_rate(sequence: dict[str, Any]) -> dict[str, int]:
    raw = _object(sequence.get("frame_rate"), "sequence.frame_rate")
    return {
        "numerator": _integer(raw.get("numerator"), "frame_rate.numerator", positive=True),
        "denominator": _integer(raw.get("denominator"), "frame_rate.denominator", positive=True),
    }


def _sources(timeline: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    projected: list[dict[str, Any]] = []
    index: dict[str, dict[str, Any]] = {}
    for position, item in enumerate(_list(timeline.get("sources"), "timeline.sources")):
        source = _object(item, f"timeline.sources[{position}]")
        source_id = _string(source.get("source_id"), f"timeline.sources[{position}].source_id", required=True)
        if source_id in index:
            raise UnsafeNLESequenceIR(f"duplicate Timeline source_id: {source_id}")
        name = _string(source.get("name"), f"source {source_id} name")
        if _looks_device_local_path(name):
            raise UnsafeNLESequenceIR(f"source {source_id} name must not expose a device-local absolute path")
        row = {
            "source_id": source_id,
            "clip_id": _string(source.get("clip_id"), f"source {source_id} clip_id"),
            "media_id": _string(source.get("media_id"), f"source {source_id} media_id"),
            "name": name,
            "duration_frames": _optional_positive_integer(
                source.get("duration_frames"), f"source {source_id} duration_frames"
            ),
        }
        projected.append(row)
        index[source_id] = row
    projected.sort(key=lambda item: item["source_id"])
    return projected, index


def _multicam_groups(
    timeline: dict[str, Any],
    sources: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    projected: list[dict[str, Any]] = []
    index: dict[str, dict[str, Any]] = {}
    for position, item in enumerate(_list(timeline.get("multicam_groups", []), "timeline.multicam_groups")):
        group = _object(item, f"timeline.multicam_groups[{position}]")
        group_id = _string(group.get("group_id"), f"timeline.multicam_groups[{position}].group_id", required=True)
        if group_id in index:
            raise UnsafeNLESequenceIR(f"duplicate Timeline multicam group_id: {group_id}")
        raw_angles = _list(group.get("angles", []), f"multicam {group_id} angles")
        if not raw_angles:
            legacy = _list(group.get("angle_source_ids", []), f"multicam {group_id} angle_source_ids")
            if legacy:
                raise UnsafeNLESequenceIR(
                    f"multicam {group_id} lacks typed angles; Timeline Core must normalize legacy angle_source_ids before NLE projection"
                )
            raise UnsafeNLESequenceIR(f"multicam {group_id} has no angles")
        angles: list[dict[str, Any]] = []
        seen_sources: set[str] = set()
        for angle_position, raw_angle in enumerate(raw_angles):
            angle = _object(raw_angle, f"multicam {group_id} angles[{angle_position}]")
            source_id = _string(angle.get("source_id"), f"multicam {group_id} angle source_id", required=True)
            if source_id not in sources:
                raise UnsafeNLESequenceIR(f"multicam {group_id} references unknown source: {source_id}")
            if source_id in seen_sources:
                raise UnsafeNLESequenceIR(f"multicam {group_id} contains duplicate angle source: {source_id}")
            seen_sources.add(source_id)
            start_raw = angle.get("sync_start_frame")
            end_raw = angle.get("sync_end_frame")
            if start_raw is None and end_raw is None:
                sync_start = None
                sync_end = None
            elif start_raw is None or end_raw is None:
                raise UnsafeNLESequenceIR(f"multicam {group_id} angle {source_id} sync range is incomplete")
            else:
                sync_start = _integer(start_raw, f"multicam {group_id} angle {source_id} sync_start_frame")
                sync_end = _integer(end_raw, f"multicam {group_id} angle {source_id} sync_end_frame")
                if sync_end <= sync_start:
                    raise UnsafeNLESequenceIR(f"multicam {group_id} angle {source_id} sync range must satisfy start < end")
                duration_frames = sources[source_id]["duration_frames"]
                if duration_frames is not None and sync_end > duration_frames:
                    raise UnsafeNLESequenceIR(f"multicam {group_id} angle {source_id} sync range exceeds source duration")
            name = _string(angle.get("name"), f"multicam {group_id} angle {source_id} name")
            if _looks_device_local_path(name):
                raise UnsafeNLESequenceIR(f"multicam {group_id} angle {source_id} name exposes a device-local path")
            angles.append(
                {
                    "source_id": source_id,
                    "camera": _string(angle.get("camera"), f"multicam {group_id} angle {source_id} camera"),
                    "name": name,
                    "sync_start_frame": sync_start,
                    "sync_end_frame": sync_end,
                }
            )
        angles.sort(key=lambda item: item["source_id"])
        reference_source_id = group.get("reference_source_id")
        if reference_source_id is not None:
            reference_source_id = _string(reference_source_id, f"multicam {group_id} reference_source_id", required=True)
            if reference_source_id not in seen_sources:
                raise UnsafeNLESequenceIR(f"multicam {group_id} reference source is not one of its angles: {reference_source_id}")
        audio_source_id = group.get("audio_source_id")
        if audio_source_id is not None:
            audio_source_id = _string(audio_source_id, f"multicam {group_id} audio_source_id", required=True)
            if audio_source_id not in sources:
                raise UnsafeNLESequenceIR(f"multicam {group_id} audio source does not exist: {audio_source_id}")
        row = {
            "group_id": group_id,
            "angles": angles,
            "reference_source_id": reference_source_id,
            "audio_source_id": audio_source_id,
        }
        projected.append(row)
        index[group_id] = row
    projected.sort(key=lambda item: item["group_id"])
    return projected, index


def _tracks(
    sequence: dict[str, Any],
    sources: dict[str, dict[str, Any]],
    multicam_groups: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    projected: list[dict[str, Any]] = []
    track_ids: set[str] = set()
    clip_track: dict[str, str] = {}
    global_clip_ids: set[str] = set()
    for track_position, item in enumerate(_list(sequence.get("tracks"), "sequence.tracks")):
        track = _object(item, f"sequence.tracks[{track_position}]")
        track_id = _string(track.get("track_id"), f"sequence.tracks[{track_position}].track_id", required=True)
        if track_id in track_ids:
            raise UnsafeNLESequenceIR(f"duplicate Timeline track_id: {track_id}")
        track_ids.add(track_id)
        kind = _string(track.get("kind"), f"track {track_id} kind", required=True)
        if kind not in {"video", "audio"}:
            raise UnsafeNLESequenceIR(f"track {track_id} has unsupported kind: {kind}")
        clips: list[dict[str, Any]] = []
        for clip_position, raw_clip in enumerate(_list(track.get("clips", []), f"track {track_id} clips")):
            clip = _object(raw_clip, f"track {track_id} clips[{clip_position}]")
            clip_id = _string(clip.get("clip_id"), f"track {track_id} clip_id", required=True)
            if clip_id in global_clip_ids:
                raise UnsafeNLESequenceIR(f"duplicate Timeline clip_id: {clip_id}")
            global_clip_ids.add(clip_id)
            clip_track[clip_id] = track_id
            source_id = _string(clip.get("source_id"), f"clip {clip_id} source_id", required=True)
            source = sources.get(source_id)
            if source is None:
                raise UnsafeNLESequenceIR(f"clip {clip_id} references unknown source: {source_id}")
            timeline_start = _integer(clip.get("timeline_start"), f"clip {clip_id} timeline_start")
            source_in = _integer(clip.get("source_in"), f"clip {clip_id} source_in")
            duration = _integer(clip.get("duration"), f"clip {clip_id} duration", positive=True)
            source_duration = source["duration_frames"]
            if source_duration is not None and source_in + duration > source_duration:
                raise UnsafeNLESequenceIR(f"clip {clip_id} source range exceeds source {source_id} duration")
            enabled = clip.get("enabled", True)
            if not isinstance(enabled, bool):
                raise UnsafeNLESequenceIR(f"clip {clip_id} enabled must be boolean")
            multicam_group_id = clip.get("multicam_group_id")
            selected_angle_source_id = clip.get("selected_angle_source_id")
            if multicam_group_id is not None:
                multicam_group_id = _string(multicam_group_id, f"clip {clip_id} multicam_group_id", required=True)
                group = multicam_groups.get(multicam_group_id)
                if group is None:
                    raise UnsafeNLESequenceIR(f"clip {clip_id} references unknown multicam group: {multicam_group_id}")
                angle_source_ids = {angle["source_id"] for angle in group["angles"]}
                if source_id not in angle_source_ids:
                    raise UnsafeNLESequenceIR(f"clip {clip_id} base source is not in multicam group {multicam_group_id}")
                if selected_angle_source_id is not None:
                    selected_angle_source_id = _string(
                        selected_angle_source_id, f"clip {clip_id} selected_angle_source_id", required=True
                    )
                    if selected_angle_source_id not in angle_source_ids:
                        raise UnsafeNLESequenceIR(
                            f"clip {clip_id} selected angle is not in multicam group {multicam_group_id}: {selected_angle_source_id}"
                        )
            elif selected_angle_source_id is not None:
                raise UnsafeNLESequenceIR(f"clip {clip_id} has selected angle without multicam group")
            clips.append(
                {
                    "clip_id": clip_id,
                    "source_id": source_id,
                    "timeline_start": timeline_start,
                    "source_in": source_in,
                    "duration": duration,
                    "enabled": enabled,
                    "multicam_group_id": multicam_group_id,
                    "selected_angle_source_id": selected_angle_source_id,
                    "metadata": _metadata(clip.get("metadata", {}), f"clip {clip_id} metadata"),
                }
            )
        clips.sort(key=lambda item: (item["timeline_start"], item["clip_id"]))
        previous_end: int | None = None
        for clip in clips:
            if previous_end is not None and clip["timeline_start"] < previous_end:
                raise UnsafeNLESequenceIR(f"track {track_id} contains overlapping clips around {clip['clip_id']}")
            previous_end = clip["timeline_start"] + clip["duration"]
        projected.append({"track_id": track_id, "kind": kind, "clips": clips})
    return projected, clip_track


def _markers(sequence: dict[str, Any]) -> list[dict[str, Any]]:
    projected: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for position, item in enumerate(_list(sequence.get("markers", []), "sequence.markers")):
        marker = _object(item, f"sequence.markers[{position}]")
        marker_id = _string(marker.get("marker_id"), f"sequence.markers[{position}].marker_id", required=True)
        if marker_id in seen_ids:
            raise UnsafeNLESequenceIR(f"duplicate Timeline marker_id: {marker_id}")
        seen_ids.add(marker_id)
        kind = _string(marker.get("kind", "standard"), f"marker {marker_id} kind", required=True)
        projected.append(
            {
                "marker_id": marker_id,
                "position": _integer(marker.get("position"), f"marker {marker_id} position"),
                "duration": _integer(marker.get("duration", 0), f"marker {marker_id} duration"),
                "kind": kind,
                "label": _string(marker.get("label"), f"marker {marker_id} label"),
                "metadata": _metadata(marker.get("metadata", {}), f"marker {marker_id} metadata"),
            }
        )
    projected.sort(key=lambda item: (item["position"], item["marker_id"]))
    return projected


def _transitions(sequence: dict[str, Any], clip_track: dict[str, str]) -> list[dict[str, Any]]:
    projected: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for position, item in enumerate(_list(sequence.get("transitions", []), "sequence.transitions")):
        transition = _object(item, f"sequence.transitions[{position}]")
        transition_id = _string(
            transition.get("transition_id"), f"sequence.transitions[{position}].transition_id", required=True
        )
        if transition_id in seen_ids:
            raise UnsafeNLESequenceIR(f"duplicate Timeline transition_id: {transition_id}")
        seen_ids.add(transition_id)
        track_id = _string(transition.get("track_id"), f"transition {transition_id} track_id", required=True)
        left_clip_id = _string(
            transition.get("left_clip_id"), f"transition {transition_id} left_clip_id", required=True
        )
        right_clip_id = _string(
            transition.get("right_clip_id"), f"transition {transition_id} right_clip_id", required=True
        )
        left_track = clip_track.get(left_clip_id)
        right_track = clip_track.get(right_clip_id)
        if left_track is None or right_track is None:
            raise UnsafeNLESequenceIR(f"transition {transition_id} references unknown clip")
        if left_track != track_id or right_track != track_id:
            raise UnsafeNLESequenceIR(f"transition {transition_id} clips do not belong to declared track {track_id}")
        projected.append(
            {
                "transition_id": transition_id,
                "track_id": track_id,
                "left_clip_id": left_clip_id,
                "right_clip_id": right_clip_id,
                "duration": _integer(transition.get("duration"), f"transition {transition_id} duration", positive=True),
            }
        )
    projected.sort(key=lambda item: item["transition_id"])
    return projected


def build_nle_sequence_ir(timeline: dict[str, Any]) -> dict[str, Any]:
    """Project a normalized TimelineProject v2 into lossless, NLE-neutral interchange IR."""

    timeline = _object(timeline, "timeline")
    version = _integer(timeline.get("version"), "timeline.version", positive=True)
    if version != TIMELINE_PROJECT_VERSION:
        raise UnsafeNLESequenceIR(
            f"unsupported Timeline project version: expected {TIMELINE_PROJECT_VERSION}, got {version}; normalize in Timeline Core first"
        )
    project_id = _string(timeline.get("project_id"), "timeline.project_id", required=True)
    sequence = _active_sequence(timeline)
    sequence_id = _string(sequence.get("sequence_id"), "sequence.sequence_id", required=True)
    sources, source_index = _sources(timeline)
    multicam_groups, multicam_index = _multicam_groups(timeline, source_index)
    tracks, clip_track = _tracks(sequence, source_index, multicam_index)
    markers = _markers(sequence)
    transitions = _transitions(sequence, clip_track)

    return {
        "contract": NLE_SEQUENCE_IR_CONTRACT,
        "timeline_project_version": TIMELINE_PROJECT_VERSION,
        "project_id": project_id,
        "sequence_id": sequence_id,
        "name": _string(sequence.get("name"), "sequence.name"),
        "frame_rate": _frame_rate(sequence),
        "sources": sources,
        "multicam_groups": multicam_groups,
        "tracks": tracks,
        "markers": markers,
        "transitions": transitions,
        "semantics": {
            "timeline_is_authority": True,
            "multicam_structure_preserved": True,
            "unresolved_multicam_angle_preserved": True,
            "disabled_clips_preserved": True,
            "independent_audio_preserved": True,
            "markers_preserved": True,
            "transitions_preserved": True,
            "format_specific_representation": False,
            "device_source_paths_included": False,
        },
    }


__all__ = [
    "NLE_SEQUENCE_IR_CONTRACT",
    "TIMELINE_PROJECT_VERSION",
    "UnsafeNLESequenceIR",
    "build_nle_sequence_ir",
]
