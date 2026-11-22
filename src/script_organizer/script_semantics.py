from __future__ import annotations

from collections.abc import Mapping


# These rows carry screenplay structure or a cast list. They are useful
# context in the Script workspace, but they do not describe footage that can
# be assigned to a Take.
NON_PLACEABLE_SCRIPT_TYPES = frozenset({
    "scene_heading",
    "transition",
    "parenthetical",
    "character",
})
NON_PLACEABLE_SCRIPT_SPEAKERS = frozenset({
    "人物",
    "人物表",
    "人物列表",
    "角色表",
    "角色列表",
})


def _field(segment: object, key: str) -> object:
    if isinstance(segment, Mapping):
        return segment.get(key)
    return getattr(segment, key, None)


def is_placeable_script_segment(segment: object) -> bool:
    """Return whether a script row can receive a material/Take placement."""

    segment_type = str(_field(segment, "type") or "").strip().casefold()
    speaker = " ".join(str(_field(segment, "speaker") or "").split()).strip().casefold()
    return segment_type not in NON_PLACEABLE_SCRIPT_TYPES and speaker not in NON_PLACEABLE_SCRIPT_SPEAKERS
