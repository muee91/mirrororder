from __future__ import annotations

import inspect
from pathlib import Path

import pytest

from script_organizer import rough_placement_runtime
from script_organizer.review_store import ReviewConflictError, ReviewStore


def test_runtime_requires_expected_revision_and_maps_conflicts_to_409() -> None:
    source = inspect.getsource(rough_placement_runtime.install_rough_placement_runtime)
    assert 'body.get("expected_revision")' in source
    assert '"expected_revision": expected_revision' in source
    assert "except ReviewConflictError" in source
    assert "HTTPStatus.CONFLICT" in source
    assert '"interaction": "rough_batch"' in source


def test_review_batch_rejects_a_stale_preview_before_any_write(tmp_path: Path) -> None:
    review = ReviewStore(tmp_path / "review.json")
    current = review.apply_action(
        {
            "action": "set_group",
            "group_id": "G0",
            "state": "keep",
            "actor": "Editor A",
        }
    )
    assert current["revision"] == 1

    stale_actions = [
        {
            "action": "set_group_placement",
            "group_id": "G1",
            "episode_ids": [1],
            "script_segment_ids": [],
            "actor": "Editor A",
            "interaction": "rough_batch",
            "source_surface": "desktop_material_script",
            "source_kind": "take",
            "expected_revision": 0,
        },
        {
            "action": "set_group_placement",
            "group_id": "G2",
            "episode_ids": [1],
            "script_segment_ids": [],
            "actor": "Editor A",
            "interaction": "rough_batch",
            "source_surface": "desktop_material_script",
            "source_kind": "take",
            "expected_revision": 0,
        },
    ]

    with pytest.raises(ReviewConflictError, match="Review revision 已变化"):
        review.apply_actions(stale_actions)

    reopened = review.load()
    assert reopened["revision"] == 1
    assert reopened["placements"] == {}
