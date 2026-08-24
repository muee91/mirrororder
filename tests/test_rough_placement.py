from __future__ import annotations

import pytest

from script_organizer.rough_placement import (
    RoughPlacementPlan,
    parse_rough_placement_text,
    resolve_rough_plans,
)


def _tuples(text: str) -> list[tuple[int, int, int]]:
    return [
        (plan.take_start, plan.take_end, plan.episode)
        for plan in parse_rough_placement_text(text)
    ]


def test_parse_compact_handwritten_ranges() -> None:
    assert _tuples("1-10 第1集；11-20 第2集") == [
        (1, 10, 1),
        (11, 20, 2),
    ]


def test_parse_production_language_and_single_take() -> None:
    assert _tuples("镜头1-10先放第1集，Take 11归到第2集，T12 -> EP2集") == [
        (1, 10, 1),
        (11, 11, 2),
        (12, 12, 2),
    ]


def test_does_not_confuse_episode_range_with_take_range() -> None:
    assert parse_rough_placement_text("1-10集对应镜头1-100") == []


def test_conflicting_overlap_requires_user_resolution() -> None:
    with pytest.raises(ValueError, match="同时分到"):
        parse_rough_placement_text("1-10 第1集；8-12 第2集")


def test_batch_is_bounded() -> None:
    with pytest.raises(ValueError, match="400 个 Take"):
        parse_rough_placement_text("1-401 第1集")


def test_resolve_includes_split_groups_and_reports_missing() -> None:
    resolved = resolve_rough_plans(
        [RoughPlacementPlan(1, 3, 7)],
        [
            {"group_id": "G1", "take_index": 1},
            {"group_id": "G2A", "take_index": 2},
            {"group_id": "G2B", "take_index": 2},
        ],
    )
    assert resolved["group_ids"] == ["G1", "G2A", "G2B"]
    assert resolved["resolved_groups"] == 3
    assert resolved["missing_take_indices"] == [3]
    assert resolved["plans"][0]["group_ids"] == ["G1", "G2A", "G2B"]
