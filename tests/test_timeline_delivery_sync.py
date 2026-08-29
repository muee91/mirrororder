from __future__ import annotations

import copy
import json

import pytest

from script_organizer.timeline_delivery import UnsafeTimelineDelivery
from script_organizer.timeline_delivery_sync import (
    MULTICAM_SYNC_METADATA_KEY,
    normalize_timeline_delivery_request,
)


def _request(*, include_sync: bool = True) -> dict:
    metadata = {}
    if include_sync:
        metadata[MULTICAM_SYNC_METADATA_KEY] = json.dumps(
            {
                "version": 1,
                "sources": [
                    {"source_id": "source:a", "start_frame": 100, "end_frame": 300},
                    {"source_id": "source:b", "start_frame": 400, "end_frame": 600},
                ],
            }
        )
    return {
        "contract": "timeline_delivery_request.v1",
        "timeline": {
            "project_id": "p1",
            "sequences": [
                {
                    "sequence_id": "main",
                    "tracks": [
                        {
                            "track_id": "V1",
                            "kind": "video",
                            "clips": [
                                {
                                    "clip_id": "c1",
                                    "source_id": "source:a",
                                    "source_in": 120,
                                    "duration": 40,
                                    "multicam_group_id": "g1",
                                    "selected_angle_source_id": "source:b",
                                    "metadata": metadata,
                                }
                            ],
                        }
                    ],
                }
            ],
        },
    }


def _clip(payload: dict) -> dict:
    return payload["timeline"]["sequences"][0]["tracks"][0]["clips"][0]


def test_rebases_selected_angle_from_immutable_clip_sync_metadata_without_mutating_snapshot() -> None:
    request = _request()
    original = copy.deepcopy(request)
    normalized = normalize_timeline_delivery_request(request)

    assert request == original
    assert _clip(normalized)["source_id"] == "source:b"
    assert _clip(normalized)["source_in"] == 420
    assert _clip(normalized)["selected_angle_source_id"] == "source:b"
    assert _clip(normalized)["multicam_group_id"] == "g1"


def test_legacy_multicam_without_sync_metadata_remains_available_to_material_index_fallback() -> None:
    request = _request(include_sync=False)
    normalized = normalize_timeline_delivery_request(request)
    assert _clip(normalized)["source_id"] == "source:a"
    assert _clip(normalized)["source_in"] == 120


def test_present_but_invalid_sync_metadata_fails_closed() -> None:
    request = _request()
    _clip(request)["metadata"][MULTICAM_SYNC_METADATA_KEY] = "not-json"
    with pytest.raises(UnsafeTimelineDelivery, match="sync metadata is invalid"):
        normalize_timeline_delivery_request(request)


def test_selected_angle_outside_sync_range_fails_closed() -> None:
    request = _request()
    _clip(request)["source_in"] = 270
    _clip(request)["duration"] = 40
    with pytest.raises(UnsafeTimelineDelivery, match="base multicam sync range"):
        normalize_timeline_delivery_request(request)
