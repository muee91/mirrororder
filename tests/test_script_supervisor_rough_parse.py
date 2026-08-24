from __future__ import annotations

from script_organizer.script_supervisor_parser import deterministic_parse


def test_parse_episode_only_note() -> None:
    parsed = deterministic_parse("EP3")
    assert parsed["episode"] == 3
    assert parsed["scene"] == ""
    assert parsed["shot"] == ""
    assert parsed["take_number"] is None
    assert parsed["note"] == "EP3"


def test_parse_sparse_episode_scene_and_camera_shot() -> None:
    parsed = deterministic_parse("EP3 12场 B近 可用")
    assert parsed["episode"] == 3
    assert parsed["scene"] == "12"
    assert parsed["shot"] == ""
    assert parsed["take_number"] is None
    assert parsed["status"] == "usable"
    assert parsed["angle_shots"] == {"B": "closeup"}


def test_parse_compact_scene_shot_take_notation() -> None:
    parsed = deterministic_parse("12-3-2 B中近")
    assert parsed["scene"] == "12"
    assert parsed["shot"] == "3"
    assert parsed["take_number"] == 2
    assert parsed["angle_shots"] == {"B": "medium_closeup"}


def test_big_closeup_is_distinct_from_closeup_and_close_shot() -> None:
    parsed = deterministic_parse("EP3 12场 B大特写")
    assert parsed["angle_shots"] == {"B": "big_closeup"}


def test_same_scene_next_take_inherits_only_relevant_context() -> None:
    parsed = deterministic_parse(
        "同场下一条 C中，后半段可用",
        {
            "episode": 2,
            "scene": "8",
            "shot": "4",
            "take_number": 3,
            "status": "usable",
            "note": "previous",
        },
    )
    assert parsed["episode"] == 2
    assert parsed["scene"] == "8"
    assert parsed["shot"] == "4"
    assert parsed["take_number"] == 4
    assert parsed["status"] == "partial"
    assert parsed["range_hint"] == "second_half"
    assert parsed["angle_shots"] == {"C": "medium"}


def test_same_scene_does_not_force_previous_shot_or_take() -> None:
    parsed = deterministic_parse(
        "同场 B远",
        {"episode": 5, "scene": "21", "shot": "7", "take_number": 2},
    )
    assert parsed["episode"] == 5
    assert parsed["scene"] == "21"
    assert parsed["shot"] == ""
    assert parsed["take_number"] is None
    assert parsed["angle_shots"] == {"B": "wide"}


def test_same_scene_alone_preserves_only_episode_and_scene() -> None:
    parsed = deterministic_parse(
        "同场",
        {"episode": 5, "scene": "21", "shot": "7", "take_number": 2},
    )
    assert parsed["episode"] == 5
    assert parsed["scene"] == "21"
    assert parsed["shot"] == ""
    assert parsed["take_number"] is None


def test_needs_viewing_stays_text_evidence_without_fake_seconds() -> None:
    parsed = deterministic_parse("看片再定")
    assert parsed["note"] == "看片再定"
    assert parsed["range_hint"] == "needs_viewing"
    assert "usable_range" not in parsed
