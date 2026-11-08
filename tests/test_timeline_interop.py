import sys
from types import SimpleNamespace

import pytest

from script_organizer.timeline_interop import OTIOInterop, TimelineMarker


def test_otio_is_an_optional_interop_provider() -> None:
    assert isinstance(OTIOInterop.available(), bool)


def test_otio_markers_preserve_frame_rate(monkeypatch) -> None:
    class RationalTime:
        def __init__(self, value, rate):
            self.value = value
            self.rate = rate

    class TimeRange:
        def __init__(self, *, start_time, duration):
            self.start_time = start_time
            self.duration = duration

    class Marker:
        def __init__(self, *, name, marked_range, color):
            self.name = name
            self.marked_range = marked_range
            self.color = color

    fake_otio = SimpleNamespace(
        schema=SimpleNamespace(MarkerDictionary=dict, Marker=Marker),
        opentime=SimpleNamespace(RationalTime=RationalTime, TimeRange=TimeRange),
    )
    monkeypatch.setitem(sys.modules, "opentimelineio", fake_otio)

    markers = OTIOInterop.make_markers([TimelineMarker("cut", 1.0, 0.5, rate=24.0)])
    marker = markers["cut"]
    assert marker.marked_range.start_time.value == 24.0
    assert marker.marked_range.start_time.rate == 24.0
    assert marker.marked_range.duration.value == 12.0
    assert marker.marked_range.duration.rate == 24.0


def test_timeline_marker_rejects_invalid_rate() -> None:
    with pytest.raises(ValueError, match="rate"):
        TimelineMarker("bad", 0, rate=0)
