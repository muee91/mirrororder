"""Optional OpenTimelineIO boundary for evidence markers and confirmed spans."""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Any, Iterable


@dataclass(frozen=True)
class TimelineMarker:
    name: str
    start_seconds: float
    duration_seconds: float = 0.0
    color: str = "blue"
    # OTIO stores a RationalTime as ``value / rate`` seconds.  Keep the
    # source rate alongside second-based inputs so frame-aligned markers do
    # not get silently rewritten to a 1 Hz timebase.
    rate: float = 1.0

    def __post_init__(self) -> None:
        if not math.isfinite(float(self.rate)) or float(self.rate) <= 0:
            raise ValueError("timeline marker rate must be finite and positive")
        if not math.isfinite(float(self.start_seconds)) or float(self.start_seconds) < 0:
            raise ValueError("timeline marker start must be finite and non-negative")
        if not math.isfinite(float(self.duration_seconds)) or float(self.duration_seconds) < 0:
            raise ValueError("timeline marker duration must be finite and non-negative")


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
            start = otio.opentime.RationalTime(
                float(marker.start_seconds) * float(marker.rate),
                float(marker.rate),
            )
            duration = otio.opentime.RationalTime(
                float(marker.duration_seconds) * float(marker.rate),
                float(marker.rate),
            )
            result[marker.name] = otio.schema.Marker(
                name=marker.name,
                marked_range=otio.opentime.TimeRange(
                    start_time=start,
                    duration=duration,
                ),
                color=marker.color,
            )
        return result
