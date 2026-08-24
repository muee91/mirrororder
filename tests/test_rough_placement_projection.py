from __future__ import annotations

import json
from pathlib import Path

from script_organizer.review_store import ReviewStore
from script_organizer.script_supervisor_store import ScriptSupervisorStore


def _project_outputs(tmp_path: Path) -> Path:
    output = tmp_path / "output"
    output.mkdir()
    (output / "material_index.json").write_text(
        json.dumps(
            {
                "groups": [
                    {
                        "group_id": "G1",
                        "take_index": 1,
                        "members": [
                            {
                                "clip_id": "C1",
                                "camera": "B",
                                "name": "B001.mov",
                                "duration": 5.0,
                            }
                        ],
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    (output / "script.json").write_text(
        json.dumps(
            {
                "segments": [
                    {
                        "segment_id": "E002-S12-L1",
                        "episode": 2,
                        "scene_id": "12",
                        "type": "dialogue",
                        "speaker": "A",
                        "text": "你好",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    return output


def test_episode_only_review_is_projected_to_slate(tmp_path: Path) -> None:
    output = _project_outputs(tmp_path)
    review = ReviewStore(output / "review.json")
    saved = review.apply_action(
        {
            "action": "set_group_placement",
            "group_id": "G1",
            "episode_ids": [2],
            "script_segment_ids": [],
            "actor": "editor",
            "interaction": "rough_episode",
            "source_surface": "native_app",
            "source_kind": "take",
        }
    )
    assert saved["placements"]["G1"]["episode_ids"] == [2]
    assert saved["placements"]["G1"]["script_segment_ids"] == []

    board = ScriptSupervisorStore(output).load()
    record = next(row for row in board["records"].values() if row["source_group_id"] == "G1")
    assert record["episode"] == 2
    assert record["script_scene_id"] == ""
    assert record["scene"] == ""
    assert record["attachments"][0]["clip_id"] == "C1"
    assert record["attachments"][0]["camera"] == "B"


def test_precise_then_rough_clears_auto_scene_but_keeps_human_angle_detail(tmp_path: Path) -> None:
    output = _project_outputs(tmp_path)
    review = ReviewStore(output / "review.json")
    review.apply_action(
        {
            "action": "set_group_placement",
            "group_id": "G1",
            "episode_ids": [2],
            "script_segment_ids": ["E002-S12-L1"],
            "actor": "editor",
            "source_surface": "native_app",
            "source_kind": "take",
        }
    )

    store = ScriptSupervisorStore(output)
    board = store.load()
    record_id, record = next(
        (record_id, row)
        for record_id, row in board["records"].items()
        if row["source_group_id"] == "G1"
    )
    attachments = [dict(item) for item in record["attachments"]]
    attachments[0]["shot_type"] = "closeup"
    attachments[0]["note"] = "手写：近景"
    attachments.append(
        {
            "clip_id": "",
            "media_id": "M_INSERT",
            "camera": "",
            "display_name": "insert.mov",
            "shot_type": "insert",
            "source_role": "insert",
            "note": "孤立附件：手部细节",
        }
    )
    store.apply_record(
        {
            "record_id": record_id,
            "expected_revision": board["revision"],
            "actor": "editor",
            "record": {
                "source_group_id": "G1",
                "script_scene_id": "12",
                "episode": 2,
                "scene": "12",
                "note": "人工备注：先看片",
                "attachments": attachments,
            },
        }
    )

    review.apply_action(
        {
            "action": "set_group_placement",
            "group_id": "G1",
            "episode_ids": [2],
            "script_segment_ids": [],
            "actor": "editor",
            "interaction": "rough_episode",
            "source_surface": "native_app",
            "source_kind": "take",
        }
    )
    refreshed = ScriptSupervisorStore(output).load()["records"][record_id]
    assert refreshed["episode"] == 2
    assert refreshed["script_scene_id"] == ""
    # Scene text was explicitly retained/edited by the human slate, so the
    # projection must not destroy it even when precise script linkage is cleared.
    assert refreshed["scene"] == "12"
    assert refreshed["attachments"][0]["shot_type"] == "closeup"
    assert refreshed["attachments"][0]["note"] == "手写：近景"
    assert refreshed["note"] == "人工备注：先看片"
    orphan = next(item for item in refreshed["attachments"] if item["media_id"] == "M_INSERT")
    assert orphan["shot_type"] == "insert"
    assert orphan["note"] == "孤立附件：手部细节"
