from __future__ import annotations

import hashlib
import os
import statistics
import urllib.parse
import xml.etree.ElementTree as ET
from collections import defaultdict
from fractions import Fraction
from pathlib import Path
from typing import Iterable

from .media_identity import media_identity
from .models import Clip, GroupMember, MulticamGroup


def parse_time(value: str | None) -> Fraction:
    """Parse FCPXML rational seconds without losing frame precision."""
    raw = str(value or "0s").rstrip("s")
    if "/" in raw:
        numerator, denominator = raw.split("/", 1)
        return Fraction(int(numerator), int(denominator))
    return Fraction(raw)


def _media_path(src: str, document_dir: Path | None = None) -> str:
    """Resolve FCPXML media URLs, including standard document-relative URLs."""
    decoded = urllib.parse.unquote(src)
    parsed = urllib.parse.urlparse(decoded)
    value = parsed.path if parsed.scheme == "file" else decoded
    if value and document_dir is not None and not os.path.isabs(value):
        try:
            return str((document_dir / value).resolve())
        except OSError:
            return str(document_dir / value)
    return value


def _asset_media_path(asset: ET.Element, document_dir: Path | None = None) -> str:
    direct = asset.get("src", "")
    if direct:
        return _media_path(direct, document_dir)
    reps = list(asset.findall("./media-rep"))
    original = next((item for item in reps if item.get("kind") == "original-media"), None)
    chosen = original if original is not None else (reps[0] if reps else None)
    return _media_path(chosen.get("src", ""), document_dir) if chosen is not None else ""


def _tag(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def _children(element: ET.Element, name: str | None = None) -> list[ET.Element]:
    values = list(element)
    return [item for item in values if name is None or _tag(item) == name]


def _descendants(element: ET.Element, name: str) -> Iterable[ET.Element]:
    return (item for item in element.iter() if _tag(item) == name)


def _camera_name(value: str, fallback: str = "?") -> str:
    raw = str(value or "").strip().upper()
    if raw in {"A", "B", "C"}:
        return raw
    for camera in ("A", "B", "C"):
        if raw.startswith(camera) or raw.endswith(camera) or f"_{camera}" in raw or f"-{camera}" in raw:
            return camera
    return fallback


def _camera_for(element: ET.Element, fallback: str = "?") -> str:
    lane = element.get("lane", "")
    lane_camera = {"1": "A", "2": "B", "3": "C"}.get(lane)
    return lane_camera or _camera_name(lane, fallback)


def _main_spine(root: ET.Element) -> ET.Element | None:
    """Select the user project sequence, never a sequence inside a resource."""
    for project in _descendants(root, "project"):
        sequence = next(_descendants(project, "sequence"), None)
        if sequence is None:
            continue
        spine = next((item for item in _children(sequence) if _tag(item) == "spine"), None)
        if spine is not None:
            return spine
    return None


def _story_start(element: ET.Element, cursor: Fraction, parent_start: Fraction, depth: int) -> Fraction:
    if element.get("offset") is not None:
        offset = parse_time(element.get("offset"))
        return offset if depth == 0 else parent_start + offset
    lane = element.get("lane", "")
    if not lane or lane == "0":
        return cursor
    return parent_start


def stable_clip_id(media_path: str, source_asset_id: str, occurrence: int = 0) -> str:
    seed = f"{media_path}|{source_asset_id}|{occurrence}".encode("utf-8")
    return "C_" + hashlib.sha1(seed).hexdigest()[:16]


def read_fcpxml(path: str | Path) -> list[Clip]:
    document_path = Path(path).expanduser().resolve()
    document_dir = document_path.parent
    root = ET.parse(document_path).getroot()
    assets: dict[str, str] = {}
    media_ids: dict[str, str] = {}
    for asset in _descendants(root, "asset"):
        asset_id = asset.get("id", "")
        media_path = _asset_media_path(asset, document_dir)
        assets[asset_id] = media_path
        media_ids[asset_id] = media_identity(media_path) if media_path else ""

    multicam_media: dict[str, list[tuple[str, ET.Element]]] = {}
    referenced_media: dict[str, ET.Element] = {}
    for media in _descendants(root, "media"):
        media_id = media.get("id", "")
        angles: list[tuple[str, ET.Element]] = []
        for multicam in _children(media, "multicam"):
            for angle in _children(multicam, "mc-angle"):
                camera = _camera_name(angle.get("name", "") or angle.get("angleID", ""))
                angles.append((camera, angle))
        if media_id and angles:
            multicam_media[media_id] = angles
        sequence = next(_descendants(media, "sequence"), None)
        if media_id and sequence is not None:
            spine = next((item for item in _children(sequence) if _tag(item) == "spine"), None)
            if spine is not None:
                referenced_media[media_id] = spine

    occurrence: defaultdict[tuple[str, str], int] = defaultdict(int)
    clips: list[Clip] = []
    spine = _main_spine(root)
    if spine is None:
        return clips

    def append_clip(
        source_asset_id: str,
        name: str,
        camera: str,
        start: Fraction,
        duration: Fraction,
        source_start: Fraction,
    ) -> None:
        if duration <= 0:
            return
        media_path = assets.get(source_asset_id, "")
        key = (media_path, source_asset_id)
        current = occurrence[key]
        occurrence[key] += 1
        clip_id = stable_clip_id(media_path, source_asset_id, current)
        clips.append(
            Clip(
                clip_id=clip_id,
                name=name or Path(media_path).stem or source_asset_id,
                camera=camera,
                media_path=media_path,
                timeline_start=start,
                timeline_end=start + duration,
                duration=duration,
                exists=bool(media_path and os.path.exists(media_path)),
                source_asset_id=source_asset_id,
                source_start=source_start,
                source_end=source_start + duration,
                media_id=media_ids.get(source_asset_id, ""),
            )
        )

    def emit_asset_reference(
        element: ET.Element,
        start: Fraction,
        duration: Fraction,
        source_start: Fraction,
        camera: str,
    ) -> bool:
        source_asset_id = element.get("ref", "")
        if source_asset_id not in assets:
            return False
        append_clip(
            source_asset_id,
            element.get("name", ""),
            _camera_for(element, camera),
            start,
            duration,
            source_start,
        )
        return True

    def emit_multicam(element: ET.Element, start: Fraction, duration: Fraction, camera: str) -> None:
        resource_id = element.get("ref", "")
        outer_source_start = parse_time(element.get("start"))
        outer_end = outer_source_start + duration
        for angle_camera, angle in multicam_media.get(resource_id, []):
            walk_story(
                angle,
                parent_start=Fraction(0),
                depth=1,
                inherited_camera=angle_camera or camera,
                clip_window=(outer_source_start, outer_end, start),
            )

    def emit_referenced_media(element: ET.Element, start: Fraction, duration: Fraction, camera: str) -> bool:
        resource_id = element.get("ref", "")
        resource_spine = referenced_media.get(resource_id)
        if resource_spine is None:
            return False
        source_start = parse_time(element.get("start"))
        walk_story(
            resource_spine,
            parent_start=Fraction(0),
            depth=1,
            inherited_camera=camera,
            clip_window=(source_start, source_start + duration, start),
        )
        return True

    def walk_story(
        parent: ET.Element,
        parent_start: Fraction,
        depth: int,
        inherited_camera: str,
        clip_window: tuple[Fraction, Fraction, Fraction] | None = None,
    ) -> None:
        cursor = parent_start
        for element in _children(parent):
            kind = _tag(element)
            duration = parse_time(element.get("duration"))
            start = _story_start(element, cursor, parent_start, depth)
            end = start + duration
            lane = element.get("lane", "")
            if (not lane or lane == "0") and duration > 0:
                cursor = max(cursor, end)
            if duration <= 0:
                if _children(element):
                    walk_story(element, start, depth + 1, inherited_camera, clip_window)
                continue

            effective_start = start
            effective_end = end
            source_start = parse_time(element.get("start"))
            timeline_start = start
            if clip_window is not None:
                window_start, window_end, outer_timeline_start = clip_window
                effective_start = max(start, window_start)
                effective_end = min(end, window_end)
                if effective_end <= effective_start:
                    continue
                source_start += effective_start - start
                timeline_start = outer_timeline_start + (effective_start - window_start)
            effective_duration = effective_end - effective_start
            camera = _camera_for(element, inherited_camera)

            if kind == "mc-clip" and element.get("ref", "") in multicam_media:
                emit_multicam(element, timeline_start, effective_duration, camera)
                continue

            if kind in {"asset-clip", "video", "audio", "ref-clip", "sync-clip", "clip"}:
                if emit_asset_reference(element, timeline_start, effective_duration, source_start, camera):
                    continue
                if kind in {"ref-clip", "sync-clip"} and emit_referenced_media(
                    element,
                    timeline_start,
                    effective_duration,
                    camera,
                ):
                    continue

            if kind == "gap" or _children(element):
                walk_story(element, start, depth + 1, camera, clip_window)

    walk_story(spine, Fraction(0), 0, "?")
    return clips


def _member(clip: Clip) -> GroupMember:
    return GroupMember(
        clip_id=clip.clip_id,
        camera=clip.camera,
        name=clip.name,
        media_path=clip.media_path,
        timeline_start=clip.timeline_start,
        timeline_end=clip.timeline_end,
        duration=clip.duration,
        exists=clip.exists,
        source_start=clip.source_start,
        source_end=clip.source_end,
        media_id=clip.media_id,
    )


def overlap_seconds(left: Clip, right: Clip) -> float:
    return max(0.0, min(left.timeline_end, right.timeline_end) - max(left.timeline_start, right.timeline_start))


def group_id_for(clips: list[Clip]) -> str:
    seed = "|".join(sorted(clip.clip_id for clip in clips)).encode("utf-8")
    return "G_" + hashlib.sha1(seed).hexdigest()[:16]


def _component_indexes(clips: list[Clip], minimum_overlap_seconds: float) -> list[list[int]]:
    parent = list(range(len(clips)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        root_left, root_right = find(left), find(right)
        if root_left != root_right:
            parent[root_right] = root_left

    for index, left in enumerate(clips):
        for other_index in range(index + 1, len(clips)):
            right = clips[other_index]
            if left.camera == right.camera:
                continue
            if overlap_seconds(left, right) >= minimum_overlap_seconds:
                union(index, other_index)

    components: defaultdict[int, list[int]] = defaultdict(list)
    for index, clip in enumerate(clips):
        components[find(index)].append(index)
    return list(components.values())


def _child_group_id(parent_group_id: str, members: list[GroupMember]) -> str:
    seed = "|".join(
        [
            parent_group_id,
            *sorted(
                f"{member.clip_id}:{member.timeline_start}:{member.timeline_end}:"
                f"{member.source_start}:{member.source_end}"
                for member in members
            ),
        ]
    ).encode("utf-8")
    return "G_" + hashlib.sha1(seed).hexdigest()[:16]


def _slice_member(clip: Clip, start: Fraction, end: Fraction) -> GroupMember:
    effective_start = max(start, clip.timeline_start)
    effective_end = min(end, clip.timeline_end)
    source_start = clip.source_start + max(Fraction(0), effective_start - clip.timeline_start)
    source_end = source_start + max(Fraction(0), effective_end - effective_start)
    return GroupMember(
        clip_id=clip.clip_id,
        camera=clip.camera,
        name=clip.name,
        media_path=clip.media_path,
        timeline_start=effective_start,
        timeline_end=effective_end,
        duration=max(Fraction(0), effective_end - effective_start),
        exists=clip.exists,
        source_start=source_start,
        source_end=source_end,
        media_id=clip.media_id,
    )


def _group_from_members(
    members: list[Clip],
    group_id: str,
    parent_group_id: str = "",
    take_index: int = 1,
    split_reason: str = "",
) -> MulticamGroup:
    members.sort(key=lambda clip: (clip.timeline_start, clip.camera, clip.name, clip.clip_id))
    return MulticamGroup(
        group_id=group_id,
        start=min(clip.timeline_start for clip in members),
        end=max(clip.timeline_end for clip in members),
        members=tuple(_member(clip) for clip in members),
        cameras=tuple(sorted({clip.camera for clip in members})),
        kind="multicam" if len({clip.camera for clip in members}) > 1 else "single-camera",
        parent_group_id=parent_group_id,
        take_index=take_index,
        split_reason=split_reason,
    )


def _bridge_split(
    members: list[Clip],
    minimum_overlap_seconds: float,
    bridge_ratio: float,
) -> list[MulticamGroup] | None:
    """Split a transitive component when one long clip bridges real stop/start takes.

    A bridge is only accepted when removing it reveals at least two temporal
    components made from at least two other cameras. This keeps ordinary
    same-camera stop/start clips together when another angle remains rolling.
    """
    if len(members) < 5 or len({clip.camera for clip in members}) < 3:
        return None
    parent_group_id = group_id_for(members)
    candidates: list[tuple[int, float, Clip, list[list[Clip]]]] = []
    for bridge in members:
        others = [clip for clip in members if clip.clip_id != bridge.clip_id]
        other_cameras = {clip.camera for clip in others}
        if len(other_cameras) < 2:
            continue
        components = [
            [others[index] for index in indexes]
            for indexes in _component_indexes(others, minimum_overlap_seconds)
        ]
        overlapping = [
            component
            for component in components
            if any(overlap_seconds(bridge, clip) >= minimum_overlap_seconds for clip in component)
        ]
        if len(overlapping) < 2:
            continue
        durations = [float(clip.duration) for clip in others if float(clip.duration) > 0]
        typical = statistics.median(durations) if durations else 0.0
        if typical <= 0 or float(bridge.duration) < typical * max(1.0, bridge_ratio):
            continue
        overlapping.sort(key=lambda component: min(clip.timeline_start for clip in component))
        candidates.append((len(overlapping), float(bridge.duration) / typical, bridge, overlapping))
    if not candidates:
        return None

    _count, _ratio, bridge, components = max(candidates, key=lambda item: (item[0], item[1]))
    component_ranges = [
        (
            min(clip.timeline_start for clip in component),
            max(clip.timeline_end for clip in component),
        )
        for component in components
    ]
    cuts = [
        (component_ranges[index][1] + component_ranges[index + 1][0]) / 2
        for index in range(len(component_ranges) - 1)
    ]
    windows = []
    for index, (component_start, component_end) in enumerate(component_ranges):
        window_start = bridge.timeline_start if index == 0 else cuts[index - 1]
        window_end = bridge.timeline_end if index == len(component_ranges) - 1 else cuts[index]
        windows.append((min(window_start, component_start), max(window_end, component_end)))

    groups: list[MulticamGroup] = []
    for take_index, (component, (window_start, window_end)) in enumerate(zip(components, windows), start=1):
        sliced_bridge = _slice_member(bridge, window_start, window_end)
        group_members = [_member(clip) for clip in component]
        if sliced_bridge.duration > 0:
            group_members.append(sliced_bridge)
        group_members.sort(key=lambda member: (member.timeline_start, member.camera, member.name, member.clip_id))
        groups.append(
            MulticamGroup(
                group_id=_child_group_id(parent_group_id, group_members),
                start=min(member.timeline_start for member in group_members),
                end=max(member.timeline_end for member in group_members),
                members=tuple(group_members),
                cameras=tuple(sorted({member.camera for member in group_members})),
                kind="multicam" if len({member.camera for member in group_members}) > 1 else "single-camera",
                parent_group_id=parent_group_id,
                take_index=take_index,
                split_reason=f"{bridge.camera}机长录制跨越多次其他机位停拍",
            )
        )
    return groups


def build_multicam_groups(
    clips: list[Clip],
    minimum_overlap_seconds: float = 0.5,
    bridge_ratio: float = 1.8,
) -> list[MulticamGroup]:
    """Build logical Takes from FCPXML overlap without letting one bridge glue scenes."""
    component_indexes = _component_indexes(clips, minimum_overlap_seconds)

    groups: list[MulticamGroup] = []
    for indexes in component_indexes:
        members = [clips[index] for index in indexes]
        split = _bridge_split(members, minimum_overlap_seconds, bridge_ratio)
        if split:
            groups.extend(split)
            continue
        groups.append(_group_from_members(members, group_id_for(members)))
    return sorted(groups, key=lambda group: (group.start, group.group_id))
