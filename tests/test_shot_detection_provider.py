import pytest

from script_organizer.resource_scheduler import ResourceCancelled
from script_organizer.shot_detection_provider import (
    PySceneDetectProvider,
    ShotBoundary,
    detect_index_shots,
    provider_status,
)


def test_pyscenedetect_provider_is_optional_and_reports_capability() -> None:
    provider = PySceneDetectProvider()
    status = provider_status(provider)
    assert status["provider"] == "pyscenedetect"
    assert isinstance(status["available"], bool)


class _FakeProvider:
    name = "fake"

    def __init__(self, boundaries):
        self.boundaries = boundaries
        self.calls = []

    def detect(self, media_path, *, duration_seconds=None, cancelled=None):
        self.calls.append((media_path, duration_seconds, cancelled))
        return list(self.boundaries)


def test_detect_index_shots_bounds_spans_and_records_clip_duration() -> None:
    provider = _FakeProvider(
        [
            ShotBoundary(-1, 2, "fake"),
            ShotBoundary(2, 20, "fake"),
            ShotBoundary(20, 20, "fake"),
        ]
    )
    sidecars, diagnostics = detect_index_shots(
        {
            "clips": [
                {
                    "clip_id": "C1",
                    "media_id": "M1",
                    "source_media_path": "/tmp/clip.mov",
                    "name": "clip.mov",
                    "duration": 5,
                }
            ]
        },
        provider,
    )

    assert diagnostics == []
    assert provider.calls[0][1] == 5.0
    assert sidecars[0].duration_seconds == 5.0
    assert [(item.span.start_seconds, item.span.end_seconds) for item in sidecars[0].items] == [
        (0.0, 2.0),
        (2.0, 5.0),
    ]


def test_detect_index_shots_propagates_cancellation_before_provider() -> None:
    provider = _FakeProvider([])
    with pytest.raises(ResourceCancelled):
        detect_index_shots(
            {"clips": [{"clip_id": "C1", "media_id": "M1", "media_path": "/tmp/clip.mov"}]},
            provider,
            cancelled=lambda: True,
        )
    assert provider.calls == []
