"""Exclusion 语义迁移的垂直回归：排除是 placement 轴的独立卫生事实，
不写 legacy 创意 state，不改写 delivery_state，UI/交付按独立原因消费。"""

from __future__ import annotations

import json
from pathlib import Path

from script_organizer.review_store import (
    ReviewStore,
    is_group_excluded,
    normalize_review,
)
from script_organizer.web_server import _is_legacy_creative_state_write


def _store(tmp_path: Path) -> ReviewStore:
    return ReviewStore(tmp_path / "review.json")


def test_exclusion_actions_write_a_separate_fact(tmp_path: Path) -> None:
    store = _store(tmp_path)
    saved = store.apply_action(
        {
            "action": "set_group_exclusion",
            "group_id": "G1",
            "actor": "场记",
            "expected_revision": 0,
            "source_surface": "golden-slate-placement-pools",
        }
    )
    assert saved["exclusions"]["G1"]["method"] == "manual"
    assert saved["exclusions"]["G1"]["actor"] == "场记"
    assert saved["exclusions"]["G1"]["source_surface"] == "golden-slate-placement-pools"
    # 创意 state 轴完全未被触碰。
    assert saved["groups"] == {}

    cleared = store.apply_action(
        {
            "action": "clear_group_exclusion",
            "group_id": "G1",
            "actor": "场记",
            "expected_revision": saved["revision"],
        }
    )
    assert cleared["exclusions"] == {}
    assert cleared["revision"] == saved["revision"] + 1


def test_is_group_excluded_supports_parent_inheritance(tmp_path: Path) -> None:
    store = _store(tmp_path)
    review = normalize_review(
        {"exclusions": {"G_parent": {"method": "manual", "updated_at": "2026-09-06T00:00:00+00:00"}}}
    )
    assert is_group_excluded(review, "G_child", "G_parent") is True
    assert is_group_excluded(review, "G_parent") is True
    assert is_group_excluded(review, "G_other") is False
    assert is_group_excluded(normalize_review({}), "G1") is False


def test_legacy_creative_state_writes_are_rejected_at_the_boundary() -> None:
    for state in ("keep", "best", "reject"):
        assert _is_legacy_creative_state_write({"action": "set_group", "group_id": "G1", "state": state})
        assert _is_legacy_creative_state_write({"action": "set_assignment", "segment_id": "S1", "group_id": "G1", "state": state})
    # 清除（unreviewed）、排除、placement 都不是创意写入。
    assert not _is_legacy_creative_state_write({"action": "set_group", "group_id": "G1", "state": "unreviewed"})
    assert not _is_legacy_creative_state_write({"action": "set_group_exclusion", "group_id": "G1"})
    assert not _is_legacy_creative_state_write({"action": "set_group_placement", "group_id": "G1", "episode_ids": [1]})


def test_rough_cut_treats_exclusion_as_an_independent_reason(tmp_path: Path) -> None:
    from test_rough_cut_plan import _project, _segment

    project = _project(tmp_path)
    review = ReviewStore(project.config.output_dir / "review.json")
    review.apply_action(
        {
            "action": "set_group_exclusion",
            "group_id": "G1",
            "actor": "场记",
            "expected_revision": 0,
            "source_surface": "golden-slate-placement-pools",
        }
    )
    plan = build_plan(project)
    segment = _segment(plan)
    candidate = segment["candidates"][0]
    # delivery_state 保持纯创意语义；排除只作为独立不可选原因出现。
    assert candidate["excluded"] is True
    assert candidate["delivery_state"] != "reject"
    assert segment["primary_group_id"] == ""
    assert plan["semantics"]["exclusion_is_delivery_reject"] is False


def build_plan(project):
    from script_organizer.rough_cut_plan import build_rough_cut_plan

    return build_rough_cut_plan(project)


def test_review_v1_projects_exclusion_without_touching_creative_state(tmp_path: Path) -> None:
    from test_review_read_model import FakeProject
    from script_organizer.review_read_model import build_review_read_model

    project = FakeProject(tmp_path)
    project.review.payload["exclusions"] = {
        "G_1": {"method": "manual", "actor": "场记", "updated_at": "2026-09-06T00:00:00+00:00"}
    }
    model = build_review_read_model(project, people_for_group=lambda _group_id: {"face": [], "speaker": []})
    take = model["take_groups"][0]
    assert take["editorial_state"]["excluded"] is True
    # 创意评分（fixture 里 G1 是 keep）不被排除改写。
    assert take["editorial_state"]["legacy_manual"]["effective_state"] == "keep"
    serialized = json.dumps(model, ensure_ascii=False)
    assert '"excluded": true' in serialized
