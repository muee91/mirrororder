"""Optional OpenTimelineIO boundary for evidence markers and confirmed spans."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable


@dataclass(frozen=True)
class TimelineMarker:
    name: str
    start_seconds: float
    duration_seconds: float = 0.0
    color: str = "blue"


class OTIOInterop:
    provider = "opentimelineio"

    @staticmethod
    def available() -> bool:
        try:
            import opentimelineio  # noqa: F401
        except ImportError:
            return False
        return True

    @classmethod
    def make_markers(cls, markers: Iterable[TimelineMarker]) -> Any:
        try:
            import opentimelineio as otio
        except ImportError as error:
            raise RuntimeError("OpenTimelineIO 未安装") from error
        result = otio.schema.MarkerDictionary()
        for marker in markers:
            result[marker.name] = otio.schema.Marker(
                name=marker.name,
                marked_range=otio.opentime.TimeRange(
                    start_time=otio.opentime.RationalTime(marker.start_seconds, 1),
                    duration=otio.opentime.RationalTime(marker.duration_seconds, 1),
                ),
                color=marker.color,
            )
        return result
