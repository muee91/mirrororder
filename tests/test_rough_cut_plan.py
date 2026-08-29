from __future__ import annotations

import json
from pathlib import Path

from script_organizer.audit_engine import _analysis_revision, _mapping_for_group
from script_organizer.audit_store import AuditStore
from script_organizer.automation_store import AutomationStore
from script_organizer.config import ProjectConfig
from script_organizer.editorial_store import EditorialStore
from script_organizer.rough_cut_plan import build_rough_cut_plan
from script_organizer.review_store import ReviewStore


class FakeProject:
    def __init__(self, config: ProjectConfig):
        self.project_id = "demo"
        self.config = config
        self.reload_if_changed()

    def reload_if_changed(self) -> bool:
        self.index = json.loads((self.config.output_dir / "material_index.json").read_text(encoding="utf-8"))
        self.script = json.loads((self.config.output_dir / "script.json").read_text(encoding="utf-8"))
        return False


def _project(tmp_path: Path, *, two_groups: bool = False) -> FakeProject:
    root = tmp_path / "project"
    output = root / "output"
    transcript_dir = root / "cache" / "transcripts"
    script_path = root / "script.txt"
    config_path = root / "project.toml"
    output.mkdir(parents=True)
    transcript_dir.mkdir(parents=True)
    script_path.write_text("demo", encoding="utf-8")
    config_path.write_text("[project]\nname='demo'\n", encoding="utf-8")

    script = {
        "segments": [
            {"segment_id": "H1", "episode": 1, "scene_id": "SC1", "order": 1, "type": "scene_heading", "raw_text": "1-1 客厅 日"},
            {"segment_id": "S1", "episode": 1, "scene_id": "SC1", "order": 2, "type": "dialogue", "speaker": "王强", "text": "你好"},
        ]
    }
    groups = [
        {
            "group_id": "G1",
            "start": 0.0,
            "end": 5.0,
            "duration": 5.0,
            "members": [
                {"clip_id": "CA", "media_id": "M_A", "camera": "A", "name": "/Volumes/SECRET/A001.mov", "duration": 5.0},
                {"clip_id": "CB", "media_id": "M_B", "camera": "B", "name": "B001.mov", "duration": 5.0},
            ],
        }
    ]
    if two_groups:
        groups.append(
            {
                "group_id": "G2",
                "start": 7.0,
                "end": 12.0,
                "duration": 5.0,
                "members": [{"clip_id": "CC", "media_id": "M_C", "camera": "A", "name": "A002.mov", "duration": 5.0}],
            }
        )
    material = {"groups": groups, "clips": [], "stats": {"groups": len(groups)}}
    (output / "script.json").write_text(json.dumps(script, ensure_ascii=False), encoding="utf-8")
    (output / "material_index.json").write_text(json.dumps(material, ensure_ascii=False), encoding="utf-8")
    (output / "matches.json").write_text(json.dumps({"groups": {}}, ensure_ascii=False), encoding="utf-8")

    automation_groups = {
        "G1": {"status": "auto_confirmed", "script_segment_ids": ["S1"], "episode_ids": [1], "confidence": 0.96},
    }
    if two_groups:
        automation_groups["G2"] = {"status": "auto_confirmed", "script_segment_ids": ["S1"], "episode_ids": [1], "confidence": 0.93}
    AutomationStore(output).save("analysis", automation_groups, {})

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
    automatic = AutomationStore(output).load()["groups"]
    revision = _analysis_revision(output)
    audit_groups = {}
    for group in project.index["groups"]:
        group_id = group["group_id"]
        mapping = _mapping_for_group(review, automatic[group_id], group)
        if group_id == "G1":
            angles = {
                "CA": {"clip_id": "CA", "shot_type": "medium", "coverage_role": "master"},
                "CB": {"clip_id": "CB", "shot_type": "closeup", "coverage_role": "dialogue"},
            }
        else:
            angles = {
                "CC": {"clip_id": "CC", "shot_type": "medium_closeup", "coverage_role": "reaction"},
            }
        audit_groups[group_id] = {
            "group_id": group_id,
            "analysis_revision": revision,
            "mapping": mapping,
            "judge": {"verdict": "agree", "confidence": 0.9, "reason": "demo"},
            "issues": [],
            "shot_intelligence": {"angles": angles},
            "rough_cut": {
                "technical_usability": "good",
                "take_completeness": "complete",
                "coverage_role": "dialogue",
                "continuity_risk": "low",
            },
        }
    AuditStore(output).save(
        {
            "analysis_revision": revision,
            "summary": {"current_groups": len(audit_groups)},
            "groups": audit_groups,
        }
    )
    return project


def _segment(plan: dict) -> dict:
    return plan["scenes"][0]["segments"][0]


def _set_final(project: FakeProject, group_id: str, state: str) -> None:
    store = EditorialStore(project.config.output_dir)
    current = store.load()
    store.apply_decision(
        {
            "target_kind": "group",
            "group_id": group_id,
            "state": state,
            "actor": "editor",
            "expected_revision": current["revision"],
        }
    )


def test_automatic_mapping_is_candidate_not_creative_best(tmp_path: Path) -> None:
    project = _project(tmp_path)
    plan = build_rough_cut_plan(project)
    segment = _segment(plan)
    assert segment["selection_status"] == "needs_editorial_choice"
    assert segment["primary_group_id"] == ""
    assert segment["candidates"][0]["delivery_state"] == "keep"
    assert segment["candidates"][0]["decision_source"] == "automatic_mapping_fallback"
    assert segment["candidates"][0]["creative_authority"] is False
    assert plan["semantics"]["automatic_mapping_is_creative_best"] is False
    assert plan["semantics"]["keep_promoted_to_best"] is False


def test_only_explicit_best_becomes_primary(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _set_final(project, "G1", "best")
    segment = _segment(build_rough_cut_plan(project))
    assert segment["selection_status"] == "explicit_best"
    assert segment["primary_group_id"] == "G1"
    assert segment["candidates"][0]["decision_source"] == "editorial_group"
    assert segment["candidates"][0]["creative_authority"] is True


def test_keep_is_not_promoted_to_primary(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _set_final(project, "G1", "keep")
    segment = _segment(build_rough_cut_plan(project))
    assert segment["selection_status"] == "needs_editorial_choice"
    assert segment["primary_group_id"] == ""
    assert segment["candidates"][0]["delivery_state"] == "keep"
    assert segment["candidates"][0]["creative_authority"] is True


def test_multiple_explicit_best_is_a_conflict_not_an_arbitrary_pick(tmp_path: Path) -> None:
    project = _project(tmp_path, two_groups=True)
    _set_final(project, "G1", "best")
    _set_final(project, "G2", "best")
    segment = _segment(build_rough_cut_plan(project))
    assert segment["selection_status"] == "conflict_multiple_best"
    assert segment["primary_group_id"] == ""
    assert {row["group_id"] for row in segment["candidates"] if row["delivery_state"] == "best"} == {"G1", "G2"}
    assert any(issue["code"] == "multiple_explicit_best" for issue in segment["issues"])


def test_rejected_groups_are_not_eligible(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _set_final(project, "G1", "reject")
    segment = _segment(build_rough_cut_plan(project))
    assert segment["selection_status"] == "no_eligible_take"
    assert segment["summary"]["eligible"] == 0
    assert segment["candidates"][0]["delivery_state"] == "reject"


def test_individual_opinion_never_becomes_rough_cut_primary(tmp_path: Path) -> None:
    project = _project(tmp_path)
    EditorialStore(project.config.output_dir).apply_opinion(
        {
            "target_kind": "group",
            "group_id": "G1",
            "state": "best",
            "actor": "reviewer",
            "reviewer_id": "r1",
        }
    )
    segment = _segment(build_rough_cut_plan(project))
    assert segment["selection_status"] == "needs_editorial_choice"
    assert segment["primary_group_id"] == ""


def test_role_pools_are_available_without_claiming_missing_roles(tmp_path: Path) -> None:
    project = _project(tmp_path)
    segment = _segment(build_rough_cut_plan(project))
    assert [row["camera"] for row in segment["role_pools"]["master"]] == ["A"]
    assert [row["camera"] for row in segment["role_pools"]["dialogue"]] == ["B"]
    assert "reaction" not in segment["role_pools"]
    assert all("missing" not in issue["code"] for issue in segment["issues"])


def test_plan_is_read_only_and_path_safe(tmp_path: Path) -> None:
    project = _project(tmp_path)
    manifest = project.config.output_dir / "selection_manifest.json"
    organized = project.config.output_dir / "organized.fcpxml"
    assert not manifest.exists()
    assert not organized.exists()
    plan = build_rough_cut_plan(project)
    assert not manifest.exists()
    assert not organized.exists()
    raw = json.dumps(plan, ensure_ascii=False)
    assert "/Volumes/SECRET" not in raw
    assert plan["semantics"]["writes_selection_manifest"] is False
    assert plan["semantics"]["writes_fcpxml"] is False


def test_static_rough_cut_runtime_and_app_boundary() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "src" / "script_organizer" / "rough_cut_runtime.py").read_text(encoding="utf-8")
    planner = (root / "src" / "script_organizer" / "rough_cut_plan.py").read_text(encoding="utf-8")
    runtime_stack = (root / "src" / "script_organizer" / "runtime_stack.py").read_text(encoding="utf-8")
    ui = (root / "web" / "rough_cut_ui.js").read_text(encoding="utf-8")
    css = (root / "web" / "rough_cut.css").read_text(encoding="utf-8")
    index = (root / "web" / "index.html").read_text(encoding="utf-8")

    assert 'parts[4] == "rough-cut-plan"' in runtime
    assert 'self._local_only()' in runtime
    assert 'self._agent("read", project_id)' in runtime
    assert '"timeline_write": False' in runtime
    assert '"fcpxml_write": False' in runtime
    assert 'resolve_delivery_state' in planner
    assert 'automatic_state="keep"' in planner
    assert '"keep_promoted_to_best": False' in planner
    assert runtime_stack.index("install_coverage_runtime()") < runtime_stack.index("install_rough_cut_runtime()") < runtime_stack.index("install_assistant_runtime()")

    assert "window.webkit?.messageHandlers?.mirrorOrder" in ui
    assert "projectApi('/rough-cut-plan')" in ui
    assert "不会自动替你选择 Best" in ui
    assert "不写 Manifest、不生成时间线" in ui
    assert 'data-focus-group=' in ui
    assert "html.native-production" in css
    assert '/rough_cut.css' in index
    assert '/rough_cut_ui.js' in index
