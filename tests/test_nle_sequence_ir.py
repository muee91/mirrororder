from __future__ import annotations

import copy

import pytest

from script_organizer.nle_sequence_ir import (
    NLE_SEQUENCE_IR_CONTRACT,
    UnsafeNLESequenceIR,
    build_nle_sequence_ir,
)


def timeline() -> dict:
    return {
        "version": 2,
        "project_id": "p1",
        "sources": [
            {"source_id": "source:b", "clip_id": "b", "media_id": "mb", "name": "B.mov", "duration_frames": 600},
            {"source_id": "source:a", "clip_id": "a", "media_id": "ma", "name": "A.mov", "duration_frames": 300},
            {"source_id": "source:boom", "clip_id": "boom", "media_id": "mboom", "name": "Boom.wav", "duration_frames": 900},
        ],
        "multicam_groups": [
            {
                "group_id": "take-1",
                "angle_source_ids": ["source:a", "source:b"],
                "angles": [
                    {"source_id": "source:b", "camera": "B", "name": "B", "sync_start_frame": 400, "sync_end_frame": 600},
                    {"source_id": "source:a", "camera": "A", "name": "A", "sync_start_frame": 100, "sync_end_frame": 300},
                ],
                "reference_source_id": "source:a",
                "audio_source_id": "source:boom",
            }
        ],
        "sequences": [
            {
                "sequence_id": "main",
                "name": "Episode 1",
                "frame_rate": {"numerator": 24000, "denominator": 1001},
                "tracks": [
                    {
                        "track_id": "V1",
                        "kind": "video",
                        "clips": [
                            {
                                "clip_id": "c2",
                                "source_id": "source:a",
                                "timeline_start": 48,
                                "source_in": 148,
                                "duration": 24,
                                "enabled": False,
                                "multicam_group_id": "take-1",
                                "selected_angle_source_id": None,
                                "metadata": {"scene_id": "SC1", "group_id": "take-1"},
                            },
                            {
                                "clip_id": "c1",
                                "source_id": "source:a",
                                "timeline_start": 0,
                                "source_in": 100,
                                "duration": 48,
                                "enabled": True,
                                "multicam_group_id": "take-1",
                                "selected_angle_source_id": "source:b",
                                "metadata": {"scene_id": "SC1", "group_id": "take-1"},
                            },
                        ],
                    },
                    {
                        "track_id": "A1",
                        "kind": "audio",
                        "clips": [
                            {
                                "clip_id": "audio-1",
                                "source_id": "source:boom",
                                "timeline_start": 0,
                                "source_in": 20,
                                "duration": 72,
                                "enabled": True,
                                "multicam_group_id": None,
                                "selected_angle_source_id": None,
                                "metadata": {"role": "production_audio"},
                            }
                        ],
                    },
                ],
                "markers": [
                    {"marker_id": "m2", "position": 48, "duration": 12, "kind": "script", "label": "Line 2", "metadata": {"segment_id": "S2"}},
                    {"marker_id": "m1", "position": 0, "duration": 0, "kind": "scene", "label": "SC1", "metadata": {"scene_id": "SC1"}},
                ],
                "transitions": [
                    {"transition_id": "t1", "track_id": "V1", "left_clip_id": "c1", "right_clip_id": "c2", "duration": 4}
                ],
            }
        ],
        "active_sequence_id": "main",
    }


def test_projects_lossless_nle_neutral_sequence_without_flattening() -> None:
    result = build_nle_sequence_ir(timeline())
    assert result["contract"] == NLE_SEQUENCE_IR_CONTRACT
    assert result["frame_rate"] == {"numerator": 24000, "denominator": 1001}
    assert [item["source_id"] for item in result["sources"]] == ["source:a", "source:b", "source:boom"]
    assert result["multicam_groups"][0]["reference_source_id"] == "source:a"
    assert result["multicam_groups"][0]["audio_source_id"] == "source:boom"
    assert result["multicam_groups"][0]["angles"][1]["sync_start_frame"] == 400
    assert [item["clip_id"] for item in result["tracks"][0]["clips"]] == ["c1", "c2"]
    assert result["tracks"][0]["clips"][0]["selected_angle_source_id"] == "source:b"
    assert result["tracks"][0]["clips"][1]["selected_angle_source_id"] is None
    assert result["tracks"][0]["clips"][1]["enabled"] is False
    assert result["tracks"][1]["kind"] == "audio"
    assert [item["marker_id"] for item in result["markers"]] == ["m1", "m2"]
    assert result["transitions"][0]["transition_id"] == "t1"
    assert result["semantics"]["format_specific_representation"] is False


def test_preserves_unresolved_multicam_angle_instead_of_inventing_selection() -> None:
    value = timeline()
    value["sequences"][0]["tracks"][0]["clips"][1]["selected_angle_source_id"] = None
    result = build_nle_sequence_ir(value)
    assert result["tracks"][0]["clips"][0]["selected_angle_source_id"] is None


def test_requires_timeline_core_v2_normalization_instead_of_migrating_again() -> None:
    value = timeline()
    value["version"] = 1
    with pytest.raises(UnsafeNLESequenceIR, match="normalize in Timeline Core first"):
        build_nle_sequence_ir(value)


def test_rejects_legacy_only_multicam_shape() -> None:
    value = timeline()
    value["multicam_groups"][0]["angles"] = []
    with pytest.raises(UnsafeNLESequenceIR, match="lacks typed angles"):
        build_nle_sequence_ir(value)


def test_rejects_invalid_sync_range_and_source_range() -> None:
    value = timeline()
    value["multicam_groups"][0]["angles"][0]["sync_end_frame"] = 700
    with pytest.raises(UnsafeNLESequenceIR, match="sync range exceeds source duration"):
        build_nle_sequence_ir(value)

    value = timeline()
    value["sequences"][0]["tracks"][0]["clips"][0]["source_in"] = 290
    value["sequences"][0]["tracks"][0]["clips"][0]["duration"] = 20
    with pytest.raises(UnsafeNLESequenceIR, match="source range exceeds"):
        build_nle_sequence_ir(value)


def test_rejects_overlap_and_device_local_path_leakage() -> None:
    value = timeline()
    value["sequences"][0]["tracks"][0]["clips"][0]["timeline_start"] = 40
    with pytest.raises(UnsafeNLESequenceIR, match="overlapping clips"):
        build_nle_sequence_ir(value)

    value = timeline()
    value["sequences"][0]["tracks"][0]["clips"][0]["metadata"]["finder_path"] = "/Volumes/RAID/A.mov"
    with pytest.raises(UnsafeNLESequenceIR, match="device-local absolute paths"):
        build_nle_sequence_ir(value)


def test_projection_does_not_mutate_timeline_snapshot() -> None:
    value = timeline()
    before = copy.deepcopy(value)
    build_nle_sequence_ir(value)
    assert value == before
