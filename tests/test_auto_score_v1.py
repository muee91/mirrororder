from __future__ import annotations

from script_organizer.music.edit_model import build_music_edit_plan
from script_organizer.music.timeline import scene_windows_from_assembly


def _assembly():
    return {
        "contract": "assembly_timeline.v1",
        "revision": "asm-r1",
        "rough_cut_plan_revision": "rough-r1",
        "coverage_revision": "cov-r1",
        "readiness": "needs_review",
        "duration": 30.0,
        "scenes": [
            {
                "scene_id": "1-1",
                "episode": 1,
                "readiness": "ready",
                "duration": 12.0,
                "summary": {"blocks": 1},
            },
            {
                "scene_id": "1-2",
                "episode": 1,
                "readiness": "needs_review",
                "duration": 18.0,
                "summary": {"blocks": 2},
            },
        ],
    }


def _music_plan():
    license_row = {"eligible": True, "commercial_use": True, "sync_right": True}
    return {
        "contract": "auto-score.v1",
        "feature_level": "v1.0-alpha",
        "cues": [
            {
                "cue_id": "MUSIC-E001-001",
                "episode": 1,
                "scene_id": "1-1",
                "dialogue_density": 0.7,
                "selected": {
                    "asset_id": "MU_A",
                    "source_start": 10.0,
                    "source_end": 22.0,
                    "boundary_source": "downbeat->downbeat",
                    "beat_aligned": True,
                },
                "asset": {
                    "asset_id": "MU_A",
                    "path": "dark.wav",
                    "title": "Dark",
                    "generated": False,
                    "license": license_row,
                },
            },
            {
                "cue_id": "MUSIC-E001-002",
                "episode": 1,
                "scene_id": "1-2",
                "dialogue_density": 0.2,
                "selected": {
                    "asset_id": "MU_B",
                    "source_start": 30.0,
                    "source_end": 48.0,
                    "boundary_source": "beat->beat",
                    "beat_aligned": True,
                },
                "asset": {
                    "asset_id": "MU_B",
                    "path": "danger.wav",
                    "title": "Danger",
                    "generated": False,
                    "license": license_row,
                },
            },
        ],
    }


def test_scene_windows_accumulate_scene_local_assembly_timing() -> None:
    windows = scene_windows_from_assembly(_assembly(), episode=1)
    assert windows[(1, "1-1")]["start"] == 0.0
    assert windows[(1, "1-1")]["end"] == 12.0
    assert windows[(1, "1-2")]["start"] == 12.0
    assert windows[(1, "1-2")]["end"] == 30.0


def test_music_edit_plan_uses_real_timeline_and_blocks_unready_scene() -> None:
    edit_plan = build_music_edit_plan(_music_plan(), _assembly(), episode=1)
    assert edit_plan["contract"] == "music_edit_plan.v1"
    first, second = edit_plan["edits"]

    assert first["status"] == "ready"
    assert first["exportable"] is True
    assert first["placement"]["timeline_start"] == 0.0
    assert first["placement"]["timeline_end"] == 12.0
    assert first["placement"]["source_start"] == 10.0
    assert first["placement"]["source_end"] == 22.0
    assert first["mix"]["ducking"]["enabled"] is True

    assert second["status"] == "timeline_blocked"
    assert second["exportable"] is False
    assert second["placement"]["timeline_start"] == 12.0
    assert second["placement"]["timeline_end"] == 30.0
    assert edit_plan["summary"]["ready"] == 1
    assert edit_plan["summary"]["blocked"] == 1


def test_music_edit_plan_refuses_short_source_segment() -> None:
    plan = _music_plan()
    plan["cues"][0]["selected"]["source_end"] = 17.0
    edit_plan = build_music_edit_plan(plan, _assembly(), episode=1)
    first = edit_plan["edits"][0]
    assert first["status"] == "extend_required"
    assert first["exportable"] is False
    assert first["placement"]["fit"] == "extend_required"
