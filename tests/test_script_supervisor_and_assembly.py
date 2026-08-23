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
from script_organizer.media_role_store import MediaRoleStore
from script_organizer.review_store import ReviewStore
from script_organizer.rough_cut_plan import build_rough_cut_plan
from script_organizer.script_supervisor_parser import deterministic_parse
from script_organizer.script_supervisor_projection import (
    enrich_coverage_with_standalone_slate,
    enrich_rough_cut_with_standalone_slate,
)
from script_organizer.script_supervisor_store import ScriptSupervisorConflictError, ScriptSupervisorStore


class FakeProject:
    def __init__(self, config: ProjectConfig):
        self.project_id = "demo"
        self.workspace_id = "ws-demo"
        self.config = config
        self.reload_if_changed()

    def reload_if_changed(self) -> bool:
        self.index = json.loads((self.config.output_dir / "material_index.json").read_text(encoding="utf-8"))
        self.script = json.loads((self.config.output_dir / "script.json").read_text(encoding="utf-8"))
        self.matches = json.loads((self.config.output_dir / "matches.json").read_text(encoding="utf-8"))
        return False


def _project(tmp_path: Path, *, two_segments: bool = True) -> FakeProject:
    root = tmp_path / "project"
    output, transcript_dir = root / "output", root / "cache" / "transcripts"
    script_path, config_path = root / "script.txt", root / "project.toml"
    output.mkdir(parents=True); transcript_dir.mkdir(parents=True)
    script_path.write_text("demo", encoding="utf-8"); config_path.write_text("[project]\nname='demo'\n", encoding="utf-8")
    segments = [
        {"segment_id": "H1", "episode": 1, "scene_id": "SC1", "order": 1, "type": "scene_heading", "raw_text": "1-1 客厅 日"},
        {"segment_id": "S1", "episode": 1, "scene_id": "SC1", "order": 2, "type": "dialogue", "speaker": "王强", "text": "你好"},
    ]
    if two_segments:
        segments.append({"segment_id": "S2", "episode": 1, "scene_id": "SC1", "order": 3, "type": "dialogue", "speaker": "李雪", "text": "你回来了"})
    group = {
        "group_id": "G1", "start": 0.0, "end": 10.0, "duration": 10.0,
        "members": [
            {"clip_id": "CA", "media_id": "M_A", "camera": "A", "name": "/Volumes/SECRET/A001.mov", "duration": 10.0},
            {"clip_id": "CB", "media_id": "M_B", "camera": "B", "name": "B001.mov", "duration": 10.0},
        ],
    }
    (output / "script.json").write_text(json.dumps({"segments": segments}, ensure_ascii=False), encoding="utf-8")
    (output / "material_index.json").write_text(json.dumps({"groups": [group], "clips": [], "stats": {"groups": 1, "clips": 2}}, ensure_ascii=False), encoding="utf-8")
    (output / "matches.json").write_text(json.dumps({"groups": {}, "by_segment": {}}, ensure_ascii=False), encoding="utf-8")
    mapped = ["S1", "S2"] if two_segments else ["S1"]
    AutomationStore(output).save("analysis", {"G1": {"status": "auto_confirmed", "script_segment_ids": mapped, "episode_ids": [1], "confidence": 0.96}}, {})
    project = FakeProject(ProjectConfig(config_path=config_path, name="demo", fcpxml=None, script=script_path, output_dir=output, transcript_dir=transcript_dir, input_kind="media-directory", media_root=None))
    review = ReviewStore(output / "review.json").load(); automatic = AutomationStore(output).load()["groups"]["G1"]
    mapping = _mapping_for_group(review, automatic, group); revision = _analysis_revision(output)
    AuditStore(output).save({"analysis_revision": revision, "summary": {"current_groups": 1}, "groups": {"G1": {"group_id": "G1", "analysis_revision": revision, "mapping": mapping, "judge": {"verdict": "agree", "confidence": 0.9, "reason": "demo"}, "issues": [], "shot_intelligence": {"angles": {"CA": {"clip_id": "CA", "shot_type": "wide", "coverage_role": "master"}, "CB": {"clip_id": "CB", "shot_type": "closeup", "coverage_role": "dialogue"}}}, "rough_cut": {"technical_usability": "good", "take_completeness": "complete", "coverage_role": "dialogue", "continuity_risk": "low"}}}})
    return project


def _save_supervisor(project: FakeProject, entry: dict, expected_revision: int = 0) -> dict:
    return ScriptSupervisorStore(project.config.output_dir).apply({"group_id": "G1", "expected_revision": expected_revision, "actor": "场记甲", "entry": entry})


def _best(project: FakeProject, state: str = "best") -> None:
    store = EditorialStore(project.config.output_dir); current = store.load()
    store.apply_decision({"target_kind": "group", "group_id": "G1", "state": state, "actor": "editor", "expected_revision": current["revision"]})


def test_v1_group_write_migrates_to_record_and_keeps_compatibility_projection(tmp_path: Path) -> None:
    project = _project(tmp_path)
    saved = _save_supervisor(project, {"scene": "12A", "shot": "3B", "take_number": 4, "status": "partial", "note": "只要前半段，后半段穿帮", "usable_range": {"start": 0.7, "end": 4.8}, "preferred_clip_id": "CB", "angles": {"CA": {"shot_type": "medium", "note": "双人"}, "CB": {"shot_type": "extreme_closeup", "note": "人物特写"}}})
    assert saved["contract"] == "script_supervisor.v2"
    assert len(saved["records"]) == 1
    record = next(iter(saved["records"].values()))
    assert record["source_group_id"] == "G1"
    assert {row["clip_id"] for row in record["attachments"]} == {"CA", "CB"}
    assert saved["entries"]["G1"]["angles"]["CB"]["shot_type"] == "extreme_closeup"
    with pytest.raises(ScriptSupervisorConflictError):
        _save_supervisor(project, {"scene": "stale"}, expected_revision=0)


def test_standalone_record_does_not_require_algorithmic_take_and_never_stores_path(tmp_path: Path) -> None:
    project = _project(tmp_path)
    saved = ScriptSupervisorStore(project.config.output_dir).apply_record({"record_id": "slate-drone", "expected_revision": 0, "actor": "场记甲", "record": {"episode": 1, "scene": "1", "shot": "空镜", "status": "usable", "note": "饭店外景建立镜头", "attachments": [{"media_id": "M_DRONE", "display_name": "/Volumes/SECRET/DJI_001.MP4", "source_role": "aerial", "shot_type": "wide"}]}})
    row = saved["records"]["slate-drone"]
    assert row["source_group_id"] == ""
    assert row["attachments"][0]["display_name"] == "DJI_001.MP4"
    assert "/Volumes/SECRET" not in json.dumps(saved, ensure_ascii=False)
    assert "G1" not in saved["entries"]


def test_natural_language_slate_parser_is_fast_deterministic_and_does_not_invent_seconds() -> None:
    parsed = deterministic_parse("24场3镜第二次，B近景，前半段可用，后面笑场")
    assert parsed["scene"] == "24"
    assert parsed["shot"] == "3"
    assert parsed["take_number"] == 2
    assert parsed["status"] == "partial"
    assert parsed["angle_shots"]["B"] == "closeup"
    assert parsed["range_hint"] == "first_half"
    assert "usable_range" not in parsed
    inherited = deterministic_parse("上一条第三次，NG，演员忘词", parsed)
    assert inherited["scene"] == "24" and inherited["shot"] == "3"
    assert inherited["take_number"] == 3 and inherited["status"] == "ng"


def test_human_shot_label_overrides_ai_only_for_same_clip(tmp_path: Path) -> None:
    project = _project(tmp_path)
    _save_supervisor(project, {"scene": "1-1", "angles": {"CB": {"shot_type": "medium_closeup", "note": "人工核对"}}})
    graph = build_coverage_graph(project); group = graph["scenes"][0]["take_groups"][0]
    angles = {row["clip_id"]: row for row in group["angles"]}
    assert angles["CA"]["shot_type"] == "wide" and angles["CA"]["shot_source"] == "audit"
    assert angles["CB"]["shot_type"] == "medium_closeup" and angles["CB"]["shot_source"] == "script_supervisor"


def test_supervisor_ng_constrains_plan_but_does_not_become_delivery_reject(tmp_path: Path) -> None:
    project = _project(tmp_path, two_segments=False); _save_supervisor(project, {"status": "ng", "note": "穿帮"})
    segment = build_rough_cut_plan(project)["scenes"][0]["segments"][0]
    assert segment["selection_status"] == "no_eligible_take"
    assert segment["candidates"][0]["delivery_state"] == "keep"
    manifest = build_selection_manifest(project.config)
    row = next(row for segment_row in manifest["segments"] for row in segment_row["groups"] if row["group_id"] == "G1")
    assert row["state"] == "keep" and row["decision_source"] == "automatic_mapping_fallback"


def test_final_best_plus_supervisor_ng_is_explicit_conflict(tmp_path: Path) -> None:
    project = _project(tmp_path, two_segments=False); _best(project); _save_supervisor(project, {"status": "ng", "note": "导演说不用"})
    segment = build_rough_cut_plan(project)["scenes"][0]["segments"][0]
    assert segment["selection_status"] == "conflict_supervisor_vs_best" and segment["primary_group_id"] == ""


def test_partial_without_range_never_invents_seconds(tmp_path: Path) -> None:
    project = _project(tmp_path, two_segments=False); _best(project); _save_supervisor(project, {"status": "partial", "note": "只要前半段"})
    segment = build_rough_cut_plan(project)["scenes"][0]["segments"][0]
    assert any(issue["code"] == "partial_without_range" for issue in segment["issues"])
    block = build_assembly_timeline(project)["scenes"][0]["blocks"][0]
    assert block["usable_range"]["status"] == "pending"
    assert block["usable_range"]["start"] == 0.0 and block["usable_range"]["end"] == 10.0


def test_manual_range_and_preferred_angle_make_multicam_block_ready(tmp_path: Path) -> None:
    project = _project(tmp_path); _best(project)
    _save_supervisor(project, {"status": "partial", "note": "只用这一段", "usable_range": {"start": 1.2, "end": 6.4}, "preferred_clip_id": "CB"})
    scene = build_assembly_timeline(project)["scenes"][0]
    assert len(scene["blocks"]) == 1
    block = scene["blocks"][0]
    assert block["script_segment_ids"] == ["S1", "S2"]
    assert block["angle"]["status"] == "manual_preferred" and block["angle"]["clip_id"] == "CB"
    assert block["usable_range"]["status"] == "manual" and block["duration"] == pytest.approx(5.2)


def test_multicam_without_preferred_angle_stays_pending(tmp_path: Path) -> None:
    project = _project(tmp_path, two_segments=False); _best(project)
    block = build_assembly_timeline(project)["scenes"][0]["blocks"][0]
    assert block["angle"]["status"] == "pending" and block["angle"]["clip_id"] == ""
    assert {row["clip_id"] for row in block["angle"]["candidates"]} == {"CA", "CB"}


def test_standalone_slate_auxiliary_enters_scene_only_from_explicit_media_role_scene(tmp_path: Path) -> None:
    project = _project(tmp_path, two_segments=False)
    ScriptSupervisorStore(project.config.output_dir).apply_record({"record_id": "slate-drone", "expected_revision": 0, "actor": "场记甲", "record": {"episode": 1, "scene": "1", "status": "usable", "note": "开场建立", "attachments": [{"media_id": "M_DRONE", "display_name": "DJI.MP4", "source_role": "aerial", "shot_type": "wide"}]}})
    roles = MediaRoleStore(project.config.output_dir); current = roles.load()
    roles.apply_many({"expected_revision": current["revision"], "actor": "场记甲", "updates": [{"media_id": "M_DRONE", "display_name": "DJI.MP4", "source_role": "aerial", "sync_policy": "exclude", "scene_id": "SC1"}]})
    graph = enrich_coverage_with_standalone_slate(project, build_coverage_graph(project))
    rows = graph["scenes"][0]["slate_auxiliary_media"]
    assert len(rows) == 1 and rows[0]["media_id"] == "M_DRONE"
    assert rows[0]["slate"]["note"] == "开场建立"
    plan = enrich_rough_cut_with_standalone_slate(project, build_rough_cut_plan(project))
    assert plan["scenes"][0]["slate_auxiliary_media"][0]["source_role"] == "aerial"
    assert plan["semantics"]["standalone_slate_media_can_become_primary_take"] is False


def test_unlinked_human_scene_text_is_not_guessed_into_coverage(tmp_path: Path) -> None:
    project = _project(tmp_path, two_segments=False)
    ScriptSupervisorStore(project.config.output_dir).apply_record({"record_id": "slate-alone", "expected_revision": 0, "actor": "场记甲", "record": {"episode": 1, "scene": "1-1", "attachments": [{"media_id": "M_OTHER", "display_name": "OTHER.MOV", "source_role": "broll"}]}})
    graph = enrich_coverage_with_standalone_slate(project, build_coverage_graph(project))
    assert graph["scenes"][0]["slate_auxiliary_media"] == []
    assert graph["semantics"]["human_scene_text_is_not_guessed_into_script_scene"] is True


def test_supervisor_and_assembly_are_path_safe_and_never_write_fcpxml(tmp_path: Path) -> None:
    project = _project(tmp_path, two_segments=False); _best(project); _save_supervisor(project, {"note": "保底"})
    graph, assembly = build_coverage_graph(project), build_assembly_timeline(project)
    assert "/Volumes/SECRET" not in json.dumps(graph, ensure_ascii=False)
    assert "/Volumes/SECRET" not in json.dumps(assembly, ensure_ascii=False)
    assert not (project.config.output_dir / "organized.fcpxml").exists()
    assert assembly["semantics"]["writes_fcpxml"] is False


def test_static_supervisor_and_assembly_runtime_ui_boundaries() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "src/script_organizer/script_supervisor_runtime.py").read_text(encoding="utf-8")
    ui = (root / "web/script_supervisor_ui.js").read_text(encoding="utf-8")
    css = (root / "web/script_supervisor.css").read_text(encoding="utf-8")
    production = (root / "web/production_mode.js").read_text(encoding="utf-8")
    info = (root / "macos-app/Info.plist").read_text(encoding="utf-8")
    index = (root / "web/index.html").read_text(encoding="utf-8")
    assert 'parts[4] == "script-supervisor"' in runtime
    assert 'parts[4] == "script-supervisor-parse"' in runtime
    assert "self._local_only()" in runtime and '"agent_write": False' in runtime
    assert "script_supervisor.v2" in ui and "record_id" in ui and "source_group_id" in ui
    assert "Finder 素材可拖到这里" in ui and "搜索文件名 / Take" in ui
    assert "webkitSpeechRecognition" in ui and "macOS 系统听写" in ui
    assert "前半段可用" in ui and "projectApi('/script-supervisor-parse')" in ui
    assert "supervisor-mode" in css and ".slate-table" in css
    for group in ("素材", "剧本", "剪辑", "审阅"):
        assert group in production
    assert "NSMicrophoneUsageDescription" in info
    assert '/script_supervisor.css' in index and '/script_supervisor_ui.js' in index
