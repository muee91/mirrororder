from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from script_organizer.media_reader import infer_camera_label
from script_organizer.media_role_projection import enrich_coverage_graph, enrich_rough_cut_plan
from script_organizer.media_role_store import MediaRoleConflictError, MediaRoleStore


def test_industry_camera_conventions_are_strong_but_configurable() -> None:
    assert infer_camera_label(Path("/shoot/A机/A001.mov")) == "A"
    assert infer_camera_label(Path("/shoot/B/B013.mov")) == "B"
    assert infer_camera_label(Path("/shoot/day/CAM_C/C004.mov")) == "C"
    assert infer_camera_label(Path("/shoot/day/AERIAL.mov")) == "?"
    assert infer_camera_label(Path("/shoot/day/CAMERA_TEST.mov")) == "?"
    assert infer_camera_label(
        Path("/shoot/day/red-unit/clip_01.mov"),
        {"B": r"red-unit"},
    ) == "B"


def test_auxiliary_role_defaults_to_sync_exclude_and_is_revision_safe(tmp_path: Path) -> None:
    store = MediaRoleStore(tmp_path)
    saved = store.apply_many(
        {
            "expected_revision": 0,
            "actor": "editor",
            "changes": [
                {
                    "media_id": "M_DRONE",
                    "entry": {
                        "display_name": "DJI_0042.MP4",
                        "source_role": "aerial",
                        "scene_id": "24-3",
                    },
                }
            ],
        }
    )
    row = saved["media"]["M_DRONE"]
    assert row["source_role"] == "aerial"
    assert row["sync_policy"] == "exclude"
    assert row["scene_id"] == "24-3"
    assert row["actor"] == "editor"

    with pytest.raises(MediaRoleConflictError):
        store.apply_many(
            {
                "expected_revision": 0,
                "actor": "other",
                "changes": [{"media_id": "M_DRONE", "entry": {"source_role": "broll"}}],
            }
        )


def test_media_role_store_discards_device_paths(tmp_path: Path) -> None:
    store = MediaRoleStore(tmp_path)
    saved = store.apply_many(
        {
            "expected_revision": 0,
            "actor": "editor",
            "changes": [
                {
                    "media_id": "M_AUX",
                    "entry": {
                        "display_name": "DJI_0001.MP4",
                        "source_role": "aerial",
                        "media_path": "/Volumes/RAID/day1/DJI_0001.MP4",
                        "resolved_media_path": "/Volumes/RAID/day1/DJI_0001.MP4",
                    },
                }
            ],
        }
    )
    serialized = json.dumps(saved, ensure_ascii=False)
    assert "/Volumes/" not in serialized
    assert "media_path" not in saved["media"]["M_AUX"]
    assert "resolved_media_path" not in saved["media"]["M_AUX"]


def _project(tmp_path: Path) -> SimpleNamespace:
    output = tmp_path / "output"
    output.mkdir()
    return SimpleNamespace(config=SimpleNamespace(output_dir=output))


def _seed_roles(project: SimpleNamespace) -> None:
    MediaRoleStore(project.config.output_dir).apply_many(
        {
            "expected_revision": 0,
            "actor": "editor",
            "changes": [
                {
                    "media_id": "M_A",
                    "entry": {
                        "display_name": "A001.mov",
                        "camera_override": "B",
                        "source_role": "sync_camera",
                    },
                },
                {
                    "media_id": "M_DRONE",
                    "entry": {
                        "display_name": "DJI_0042.MP4",
                        "source_role": "aerial",
                        "scene_id": "SC1",
                        "note": "饭店外景建立镜头",
                    },
                },
                {
                    "media_id": "M_GOPRO",
                    "entry": {
                        "display_name": "GOPR0182.MP4",
                        "source_role": "gopro",
                        "scene_id": "",
                    },
                },
            ],
        }
    )


def test_coverage_uses_camera_override_and_keeps_auxiliary_separate(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _seed_roles(project)
    graph = {
        "revision": "base",
        "scenes": [
            {
                "scene_id": "SC1",
                "take_groups": [
                    {
                        "group_id": "G1",
                        "angles": [{"clip_id": "CA", "media_id": "M_A", "camera": "A", "name": "A001.mov"}],
                    }
                ],
                "summary": {"take_groups": 1, "angles": 1},
            }
        ],
        "summary": {},
        "semantics": {},
    }
    result = enrich_coverage_graph(project, graph)
    angle = result["scenes"][0]["take_groups"][0]["angles"][0]
    assert angle["detected_camera"] == "A"
    assert angle["camera"] == "B"
    assert angle["media_role"]["source_role"] == "sync_camera"

    auxiliary = result["scenes"][0]["auxiliary_media"]
    assert [row["media_id"] for row in auxiliary] == ["M_DRONE"]
    assert auxiliary[0]["source_role"] == "aerial"
    assert auxiliary[0]["sync_policy"] == "exclude"
    assert result["summary"]["auxiliary_media"] == 1
    assert result["summary"]["unplaced_auxiliary_media"] == 1
    assert result["semantics"]["auxiliary_media_is_take"] is False
    assert result["semantics"]["auxiliary_media_satisfies_dialogue_coverage"] is False
    assert result["revision"] != "base"
    assert "/Volumes/" not in json.dumps(result, ensure_ascii=False)


def test_rough_cut_exposes_scene_auxiliary_without_promoting_it(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _seed_roles(project)
    plan = {
        "scenes": [
            {
                "scene_id": "SC1",
                "segments": [{"primary_group_id": "G1", "candidates": [{"group_id": "G1"}]}],
                "summary": {"segments": 1},
            }
        ],
        "summary": {},
        "semantics": {},
    }
    result = enrich_rough_cut_plan(project, plan)
    scene = result["scenes"][0]
    assert [row["media_id"] for row in scene["auxiliary_pools"]["aerial"]] == ["M_DRONE"]
    assert scene["segments"][0]["primary_group_id"] == "G1"
    assert result["semantics"]["auxiliary_media_can_replace_best"] is False
    assert result["semantics"]["auxiliary_media_can_become_primary_take"] is False


def test_runtime_ui_and_sync_boundaries_are_explicit() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime_stack = (root / "src" / "script_organizer" / "runtime_stack.py").read_text(encoding="utf-8")
    runtime = (root / "src" / "script_organizer" / "media_role_runtime.py").read_text(encoding="utf-8")
    inventory_runtime = (root / "src" / "script_organizer" / "media_inventory_task_runtime.py").read_text(encoding="utf-8")
    sync_engine = (root / "src" / "script_organizer" / "multicam_sync_engine.py").read_text(encoding="utf-8")
    vendor_index = (root / "vendor" / "multicam-audio-sync" / "scripts" / "make_index.py").read_text(encoding="utf-8")
    vendor_sync = (root / "vendor" / "multicam-audio-sync" / "scripts" / "sync.py").read_text(encoding="utf-8")
    ui = (root / "web" / "media_role_ui.js").read_text(encoding="utf-8")
    index = (root / "web" / "index.html").read_text(encoding="utf-8")
    stage = (root / "desktop/scripts/stage-runtime.mjs").read_text(encoding="utf-8")

    assert runtime_stack.index("install_media_role_runtime()") < runtime_stack.index("from .coverage_runtime import install_coverage_runtime")
    assert runtime_stack.index("install_media_role_runtime()") < runtime_stack.index("install_coverage_runtime()")
    assert 'parts[4] == "media-inventory"' in inventory_runtime
    assert 'self._local_only()' in runtime
    assert '"agent_write": False' in runtime
    assert '"editorial_authority": False' in runtime
    assert '"paths_exposed": False' in inventory_runtime

    assert "MediaRoleStore(config.output_dir)" in sync_engine
    assert '"paths_projected": False' in sync_engine
    assert '"media_roles": dict(media_roles or {})' in sync_engine
    assert 'role.get("sync_policy", "auto")' in vendor_index
    assert '== "exclude":' in vendor_index
    assert "media_id_for_path" in vendor_index
    assert "ax_raw = load_audio(xid)" in vendor_sync
    assert "if ax_raw is None or ay_raw is None" in vendor_sync

    assert "window.webkit?.messageHandlers?.mirrorOrder" in ui
    assert "data-save-media-role" in ui
    assert "航拍" in ui and "空镜" in ui and "GoPro" in ui
    assert '<script src="/media_role_ui.js"></script>' in index
    assert '<link rel="stylesheet" href="/media_roles.css">' in index

    # The current Tauri release stages the Python Core and first-party sync
    # engine as resources; Team Web remains served by that Core.
    assert 'const organizerSource = path.join(repoRoot, "src", "script_organizer")' in stage
    assert 'const multicamSource = path.join(repoRoot, "vendor", "multicam-audio-sync")' in stage
    assert 'copyDirectory(organizerSource, path.join(coreTarget, "src", "script_organizer"))' in stage
