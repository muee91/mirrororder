from __future__ import annotations

from script_organizer.assembly_timeline import (
    ASSEMBLY_CONTRACT,
    _block_id,
    _merge_scene_entries,
    _segment_entry,
)


def _best_segment(segment_id: str) -> dict:
    return {
        "script": {"segment_id": segment_id, "order": 1, "speaker": "A", "text": "hello"},
        "selection_status": "explicit_best",
        "primary_group_id": "G1",
        "issues": [],
        "candidates": [
            {
                "group_id": "G1",
                "duration": 10.0,
                "decision_source": "editorial_assignment",
                "continuity_risk": "low",
                "script_supervisor": {
                    "status": "partial",
                    "usable_range": {"start": 2.0, "end": 6.0},
                    "preferred_clip_id": "CB",
                },
                "angles": [
                    {"clip_id": "CA", "camera": "A", "shot_type": "wide", "coverage_role": "master"},
                    {"clip_id": "CB", "camera": "B", "shot_type": "closeup", "coverage_role": "dialogue"},
                ],
            }
        ],
    }


def test_assembly_v2_preserves_editorial_decision_range_and_angle_authority() -> None:
    entry = _segment_entry(_best_segment("S1"))
    assert ASSEMBLY_CONTRACT == "assembly_timeline.v2"
    assert entry["group_id"] == "G1"
    assert entry["decision_source"] == "editorial_assignment"
    assert entry["angle"]["status"] == "manual_preferred"
    assert entry["angle"]["clip_id"] == "CB"
    assert {row["clip_id"] for row in entry["angle"]["candidates"]} == {"CA", "CB"}
    assert entry["usable_range"]["status"] == "manual"
    assert entry["usable_range"]["start"] == 2.0
    assert entry["usable_range"]["end"] == 6.0


def test_consecutive_script_segments_using_same_take_merge_into_one_assembly_block() -> None:
    first = _segment_entry(_best_segment("S1"))
    second = _segment_entry(_best_segment("S2"))
    blocks = _merge_scene_entries([first, second])
    assert len(blocks) == 1
    assert blocks[0]["script_segment_ids"] == ["S1", "S2"]
    assert blocks[0]["group_id"] == "G1"
    assert _block_id("SC1", blocks[0]) == _block_id("SC1", blocks[0])


def test_unresolved_segment_never_gains_a_take_in_assembly_projection() -> None:
    entry = _segment_entry(
        {
            "script": {"segment_id": "S3", "order": 3, "speaker": "B", "text": "pending"},
            "selection_status": "needs_editorial_choice",
            "primary_group_id": "",
            "candidates": [_best_segment("S3")["candidates"][0]],
            "issues": [],
        }
    )
    block = _merge_scene_entries([entry])[0]
    assert block["kind"] == "unresolved"
    assert block["group_id"] == ""
    assert block["decision_source"] == ""
