from __future__ import annotations

import json
from pathlib import Path

import pytest

from script_organizer.assembly_timeline import build_assembly_timeline
from script_organizer.audit_engine import _analysis_revision, _mapping_for_group
from script_organizer.audit_store import AuditStore
from script_organizer.automation_store import AutomationStore
from script_organizer.config import ProjectConfig
from script_organizer.coverage_graph import build_coverage_graph
from script_organizer.editorial_store import EditorialStore
from script_organizer.fcpxml_exporter import build_selection_manifest
from script_organizer.review_store import ReviewStore
from script_organizer.rough_cut_plan import build_rough_cut_plan
from script_organizer.script_supervisor_store import (
    ScriptSupervisorConflictError,
    ScriptSupervisorStore,
)


class FakeProject:
    def __init__(self, config: ProjectConfig):
        self.project_id = "demo"
        self.config = config
        self.reload_if_changed()

    def reload_if_changed(self) -> bool:
        self.index = json.loads((self.config.output_dir / "material_index.json").read_text(encoding="utf-8"))
        self.script = json.loads((self.config.output_dir / "script.json").read_text(encoding="utf-8"))
        self.matches = json.loads((self.config.output_dir / "matches.json").read_text(encoding="utf-8"))
        return False


def _project(tmp_path: Path, *, two_segments: bool = True) -> FakeProject:
    root = tmp_path / "project"
    output = root / "output"
    transcript_dir = root / "cache" / "transcripts"
    script_path = root / "script.txt"
    config_path = root / "project.toml"
    output.mkdir(parents=True)
    transcript_dir.mkdir(parents=True)
    script_path.write_text("demo", encoding="utf-8")
    config_path.write_text("[project]\nname='demo'\n", encoding="utf-8")

    segments = [
        {"segment_id": "H1", "episode": 1, "scene_id": "SC1", "order": 1, "type": "scene_heading", "raw_text": "1-1 客厅 日"},
        {"segment_id": "S1", "episode": 1, "scene_id": "SC1", "order": 2, "type": "dialogue", "speaker": "王强", "text": "你好"},
    ]
    if two_segments:
        segments.append(
            {"segment_id": "S2", "episode": 1, "scene_id": "SC1", "order": 3, "type": "dialogue", "speaker": "李雪", "text": "你回来了"}
        )
    script = {"segments": segments}
    group = {
        "group_id": "G1",
        "start": 0.0,
        "end": 10.0,
        "duration": 10.0,
        "members": [
            {"clip_id": "CA", "media_id": "M_A", "camera": "A", "name": "/Volumes/SECRET/A001.mov", "duration": 10.0},
            {"clip_id": "CB", "media_id": "M_B", "camera": "B", "name": "B001.mov", "duration": 10.0},
        ],
    }
    material = {"groups": [group], "clips": [], "stats": {"groups": 1, "clips": 2}}
    (output / "script.json").write_text(json.dumps(script, ensure_ascii=False), encoding="utf-8")
    (output / "material_index.json").write_text(json.dumps(material, ensure_ascii=False), encoding="utf-8")
    (output / "matches.json").write_text(json.dumps({"groups": {}, "by_segment": {}}, ensure_ascii=False), encoding="utf-8")

    mapped_ids = ["S1", "S2"] if two_segments else ["S1"]
    AutomationStore(output).save(
        "analysis",
        {
            "G1": {
                "status": "auto_confirmed",
                "script_segment_ids": mapped_ids,
                "episode_ids": [1],
                "confidence": 0.96,
            }
        },
        {},
    )

    config = ProjectConfig(
        config_path=config_path,
        name="demo",
        fcpxml=None,
        script=script_path,
        output_dir=output,
        transcript_dir=transcript_dir,
        input_kind="media-directory",
        media_root=None,
    )
    project = FakeProject(config)
    review = ReviewStore(output / "review.json").load()
    automatic = AutomationStore(output).load()["groups"]["G1"]
    mapping = _mapping_for_group(review, automatic, group)
    revision = _analysis_revision(output)
    AuditStore(output).save(
        {
            "analysis_revision": revision,
            "summary": {"current_groups": 1},
            "groups": {
                "G1": {
                    "group_id": "G1",
                    "analysis_revision": revision,
                    "mapping": mapping,
                    "judge": {"verdict": "agree", "confidence": 0.9, "reason": "demo"},
                    "issues": [],
                    "shot_intelligence": {
                        "angles": {
                            "CA": {"clip_id": "CA", "shot_type": "wide", "coverage_role": "master"},
                            "CB": {"clip_id": "CB", "shot_type": "closeup", "coverage_role": "dialogue"},
                        }
                    },
                    "rough_cut": {
                        "technical_usability": "good",
                        "take_completeness": "complete",
                        "coverage_role": "dialogue",
                        "continuity_risk": "low",
                    },
                }
            },
        }
    )
    return project


def _save_supervisor(project: FakeProject, entry: dict, *, expected_revision: int = 0) -> dict:
    return ScriptSupervisorStore(project.config.output_dir).apply(
        {
            "group_id": "G1",
            "expected_revision": expected_revision,
            "actor": "场记甲",
            "entry": entry,
        }
    )


def _best(project: FakeProject, state: str = "best") -> None:
    store = EditorialStore(project.config.output_dir)
    current = store.load()
    store.apply_decision(
        {
            "target_kind": "group",
            "group_id": "G1",
            "state": state,
            "actor": "editor",
            "expected_revision": current["revision"],
        }
    )


def test_supervisor_store_is_revision_safe_and_keeps_structured_human_facts(tmp_path: Path) -> None:
    project = _project(tmp_path)
    saved = _save_supervisor(
        project,
        {
            "scene": "12A",
            "shot": "3B",
            "take_number": 4,
            "status": "partial",
            "note": "只要前半段，后半段穿帮",
            "usable_range": {"start": 0.7, "end": 4.8},
            "preferred_clip_id": "CB",
            "angles": {
                "CA": {"shot_type": "medium", "note": "双人"},
                "CB": {"shot_type": "extreme_closeup", "note": "人物特写"},
            },
        },
    )
    row = saved["entries"]["G1"]
    assert row["scene"] == "12A"
    assert row["shot"] == "3B"
    assert row["take_number"] == 4
    assert row["status"] == "partial"
    assert row["usable_range"] == {"start": 0.7, "end": 4.8}
    assert row["angles"]["CB"]["shot_type"] == "extreme_closeup"
    assert row["actor"] == "场记甲"
    with pytest.raises(ScriptSupervisorConflictError):
        _save_supervisor(project, {"scene": "stale"}, expected_revision=0)


def test_human_shot_label_overrides_ai_only_for_the_same_clip(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _save_supervisor(
        project,
        {
            "scene": "1-1",
            "angles": {"CB": {"shot_type": "medium_closeup", "note": "人工核对"}},
        },
    )
    graph = build_coverage_graph(project)
    group = graph["scenes"][0]["take_groups"][0]
    angles = {row["clip_id"]: row for row in group["angles"]}
    assert angles["CA"]["shot_type"] == "wide"
    assert angles["CA"]["shot_source"] == "audit"
    assert angles["CB"]["shot_type"] == "medium_closeup"
    assert angles["CB"]["shot_source"] == "script_supervisor"
    assert graph["semantics"]["script_supervisor_shot_overrides_ai"] is True


def test_supervisor_ng_constrains_plan_but_does_not_become_delivery_reject(tmp_path: Path) -> None:
    project = _project(tmp_path, two_segments=False)
    _save_supervisor(project, {"scene": "1-1", "status": "ng", "note": "穿帮"})
    plan = build_rough_cut_plan(project)
    segment = plan["scenes"][0]["segments"][0]
    assert segment["selection_status"] == "no_eligible_take"
    assert segment["candidates"][0]["delivery_state"] == "keep"
    assert segment["candidates"][0]["supervisor_blocked"] is True
    assert plan["semantics"]["script_supervisor_ng_is_delivery_reject"] is False

    manifest = build_selection_manifest(project.config)
    manifest_group = next(
        row for segment_row in manifest["segments"]
        if segment_row["script_segment"] == "S1"
        for row in segment_row["groups"]
        if row["group_id"] == "G1"
    )
    assert manifest_group["state"] == "keep"
    assert manifest_group["decision_source"] == "automatic_mapping_fallback"


def test_final_best_plus_supervisor_ng_is_explicit_conflict(tmp_path: Path) -> None:
    project = _project(tmp_path, two_segments=False)
    _best(project)
    _save_supervisor(project, {"status": "ng", "note": "导演说不用"})
    segment = build_rough_cut_plan(project)["scenes"][0]["segments"][0]
    assert segment["selection_status"] == "conflict_supervisor_vs_best"
    assert segment["primary_group_id"] == ""
    assert any(issue["code"] == "supervisor_ng_vs_best" for issue in segment["issues"])


def test_partial_without_range_never_invents_seconds(tmp_path: Path) -> None:
    project = _project(tmp_path, two_segments=False)
    _best(project)
    _save_supervisor(project, {"status": "partial", "note": "只要前半段"})
    plan = build_rough_cut_plan(project)
    segment = plan["scenes"][0]["segments"][0]
    assert segment["selection_status"] == "explicit_best"
    assert any(issue["code"] == "partial_without_range" for issue in segment["issues"])
    assembly = build_assembly_timeline(project)
    block = assembly["scenes"][0]["blocks"][0]
    assert block["usable_range"]["status"] == "pending"
    assert block["usable_range"]["start"] == 0.0
    assert block["usable_range"]["end"] == 10.0
    assert block["assembly_status"] == "needs_review"
    assert any(issue["code"] == "partial_range_pending" for issue in block["issues"])


def test_manual_range_and_preferred_angle_make_multicam_block_ready(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _best(project)
    _save_supervisor(
        project,
        {
            "status": "partial",
            "note": "只用这一段",
            "usable_range": {"start": 1.2, "end": 6.4},
            "preferred_clip_id": "CB",
        },
    )
    assembly = build_assembly_timeline(project)
    scene = assembly["scenes"][0]
    # Both consecutive dialogue segments use the same explicit Best Take, range
    # and angle, therefore they must merge into one source block.
    assert len(scene["blocks"]) == 1
    block = scene["blocks"][0]
    assert block["script_segment_ids"] == ["S1", "S2"]
    assert block["angle"]["status"] == "manual_preferred"
    assert block["angle"]["clip_id"] == "CB"
    assert block["usable_range"]["status"] == "manual"
    assert block["duration"] == pytest.approx(5.2)
    assert block["assembly_status"] == "ready"
    assert assembly["duration"] == pytest.approx(5.2)


def test_multicam_without_preferred_angle_stays_pending(tmp_path: Path) -> None:
    project = _project(tmp_path, two_segments=False)
    _best(project)
    assembly = build_assembly_timeline(project)
    block = assembly["scenes"][0]["blocks"][0]
    assert block["angle"]["status"] == "pending"
    assert block["angle"]["clip_id"] == ""
    assert {row["clip_id"] for row in block["angle"]["candidates"]} == {"CA", "CB"}
    assert block["assembly_status"] == "needs_review"
    assert assembly["semantics"]["angle_auto_choice"] is False


def test_assembly_never_uses_keep_or_automatic_mapping_as_source_selection(tmp_path: Path) -> None:
    project = _project(tmp_path, two_segments=False)
    assembly = build_assembly_timeline(project)
    block = assembly["scenes"][0]["blocks"][0]
    assert block["kind"] == "unresolved"
    assert block["assembly_status"] == "selection_pending"
    assert assembly["duration"] == 0.0
    assert assembly["semantics"]["explicit_best_required"] is True
    assert assembly["semantics"]["automatic_mapping_selects_take"] is False
    assert assembly["semantics"]["keep_selects_take"] is False


def test_supervisor_and_assembly_contracts_are_path_safe_and_do_not_write_fcpxml(tmp_path: Path) -> None:
    project = _project(tmp_path, two_segments=False)
    _best(project)
    _save_supervisor(project, {"scene": "1-1", "note": "保底"})
    manifest = project.config.output_dir / "selection_manifest.json"
    organized = project.config.output_dir / "organized.fcpxml"
    graph = build_coverage_graph(project)
    assembly = build_assembly_timeline(project)
    assert not manifest.exists()
    assert not organized.exists()
    assert "/Volumes/SECRET" not in json.dumps(graph, ensure_ascii=False)
    assert "/Volumes/SECRET" not in json.dumps(assembly, ensure_ascii=False)
    assert assembly["semantics"]["writes_selection_manifest"] is False
    assert assembly["semantics"]["writes_fcpxml"] is False


def test_static_supervisor_and_assembly_runtime_ui_boundaries() -> None:
    root = Path(__file__).resolve().parents[1]
    supervisor_runtime = (root / "src" / "script_organizer" / "script_supervisor_runtime.py").read_text(encoding="utf-8")
    assembly_runtime = (root / "src" / "script_organizer" / "assembly_runtime.py").read_text(encoding="utf-8")
    editorial_runtime = (root / "src" / "script_organizer" / "editorial_runtime.py").read_text(encoding="utf-8")
    supervisor_ui = (root / "web" / "script_supervisor_ui.js").read_text(encoding="utf-8")
    assembly_ui = (root / "web" / "assembly_ui.js").read_text(encoding="utf-8")
    index = (root / "web" / "index.html").read_text(encoding="utf-8")

    assert 'parts[4] == "script-supervisor"' in supervisor_runtime
    assert 'self._local_only()' in supervisor_runtime
    assert 'self._agent("read", project_id)' in supervisor_runtime
    assert '"agent_write": False' in supervisor_runtime
    assert '"script_supervisor_is_editorial_authority": False' in supervisor_runtime
    assert 'parts[4] == "assembly-timeline"' in assembly_runtime
    assert '"preview_only": True' in assembly_runtime
    assert '"fcpxml_write": False' in assembly_runtime
    assert editorial_runtime.index("install_audit_runtime()") < editorial_runtime.index("install_script_supervisor_runtime()") < editorial_runtime.index("install_coverage_runtime()") < editorial_runtime.index("install_rough_cut_runtime()") < editorial_runtime.index("install_assembly_runtime()") < editorial_runtime.index("install_assistant_runtime()")

    assert "if (!APP_CLIENT) return;" in supervisor_ui
    for field in ("scene", "shot", "take_number", "status", "note", "usable_range", "angles"):
        assert field in supervisor_ui
    assert "人工标注会覆盖 AI 景别" in supervisor_ui
    assert "projectApi('/script-supervisor')" in supervisor_ui
    assert "projectApi('/assembly-timeline')" in assembly_ui
    assert "机位待定" in assembly_ui
    assert "不写 Selection Manifest" in assembly_ui
    assert '/script_supervisor.css' in index
    assert '/script_supervisor_ui.js' in index
    assert '/assembly.css' in index
    assert '/assembly_ui.js' in index
