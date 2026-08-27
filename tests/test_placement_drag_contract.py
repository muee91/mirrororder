from __future__ import annotations

import json
from pathlib import Path

from script_organizer.review_store import ReviewConflictError, ReviewStore


ROOT = Path(__file__).resolve().parents[1]


def test_web_drag_surface_uses_manual_group_placement() -> None:
    html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    startup = (ROOT / "web" / "startup_release.js").read_text(encoding="utf-8")
    js = (ROOT / "web" / "placement_drag_ui.js").read_text(encoding="utf-8")
    css = (ROOT / "web" / "placement_drag.css").read_text(encoding="utf-8")

    assert "/placement_drag.css" in html
    assert "/startup_release.js" in html
    assert "loadScript('/placement_drag_ui.js')" in startup
    assert "application/x-mirrororder-placement" in js
    assert "set_group_placement" in js
    assert "script_segment_ids: [segmentId]" in js
    assert "source_kind: 'clip'" in js
    assert "source_surface: 'web_review'" in js
    assert "['reviewer', 'manager']" in js
    assert ".script-line.placement-drop-target" in css


def test_review_store_audits_drag_placement_atomically(tmp_path: Path) -> None:
    output = tmp_path / "output"
    output.mkdir()
    (output / "material_index.json").write_text(
        json.dumps({"groups": [{"group_id": "take-1"}]}, ensure_ascii=False),
        encoding="utf-8",
    )
    (output / "script.json").write_text(
        json.dumps(
            {
                "segments": [
                    {"segment_id": "seg-1", "type": "dialogue"},
                    {"segment_id": "scene-1", "type": "scene_heading"},
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    store = ReviewStore(output / "review.json")

    saved = store.apply_action(
        {
            "action": "set_group_placement",
            "group_id": "take-1",
            "episode_ids": [2],
            "script_segment_ids": ["seg-1"],
            "actor": "剪辑A",
            "interaction": "drag_drop",
            "source_surface": "web_review",
            "source_kind": "clip",
            "source_clip_id": "A001C002",
        }
    )

    placement = saved["placements"]["take-1"]
    assert placement["script_segment_ids"] == ["seg-1"]
    assert placement["method"] == "manual"
    assert placement["actor"] == "剪辑A"
    assert placement["interaction"] == "drag_drop"
    assert placement["source_kind"] == "clip"

    history = saved["history"][-1]
    assert history["revision"] == saved["revision"]
    assert history["action"] == "set_group_placement"
    assert history["actor"] == "剪辑A"
    assert history["source_clip_id"] == "A001C002"
    assert history["after"]["script_segment_ids"] == ["seg-1"]


def test_review_store_rejects_stale_drag_targets(tmp_path: Path) -> None:
    output = tmp_path / "output"
    output.mkdir()
    (output / "material_index.json").write_text(
        json.dumps({"groups": [{"group_id": "take-1"}]}), encoding="utf-8"
    )
    (output / "script.json").write_text(
        json.dumps({"segments": [{"segment_id": "seg-1", "type": "dialogue"}]}), encoding="utf-8"
    )
    store = ReviewStore(output / "review.json")

    try:
        store.apply_action(
            {
                "action": "set_group_placement",
                "group_id": "take-missing",
                "script_segment_ids": ["seg-1"],
                "actor": "A",
            }
        )
    except ValueError as error:
        assert "Take" in str(error)
    else:
        raise AssertionError("stale Take must be rejected")

    try:
        store.apply_action(
            {
                "action": "set_group_placement",
                "group_id": "take-1",
                "script_segment_ids": ["seg-missing"],
                "actor": "A",
            }
        )
    except ValueError as error:
        assert "剧本段" in str(error)
    else:
        raise AssertionError("stale script target must be rejected")


def test_review_store_rejects_stale_revision_without_overwriting_review(tmp_path: Path) -> None:
    output = tmp_path / "output"
    output.mkdir()
    (output / "material_index.json").write_text(json.dumps({"groups": [{"group_id": "take-1"}]}), encoding="utf-8")
    store = ReviewStore(output / "review.json")

    first = store.apply_action({"action": "set_group", "group_id": "take-1", "state": "keep", "actor": "A", "expected_revision": 0})
    assert first["revision"] == 1

    try:
        store.apply_action({"action": "set_group_placement", "group_id": "take-1", "episode_ids": [2], "actor": "B", "expected_revision": 0})
    except ReviewConflictError as error:
        assert "当前 r1" in str(error)
        assert "请刷新后重试" in str(error)
    else:
        raise AssertionError("stale Review revision must fail closed")

    current = store.load()
    assert current["revision"] == 1
    assert current["placements"] == {}
    assert current["groups"]["take-1"]["state"] == "keep"
