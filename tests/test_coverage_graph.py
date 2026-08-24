from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from script_organizer.audit_engine import _analysis_revision, _mapping_for_group
from script_organizer.audit_store import AuditStore
from script_organizer.automation_store import AutomationStore
from script_organizer.config import ProjectConfig
from script_organizer.coverage_graph import build_coverage_graph, continuity_risks
from script_organizer.editorial_store import EditorialStore
from script_organizer.review_store import ReviewStore


class FakeProject:
    def __init__(self, config: ProjectConfig):
        self.project_id = "demo"
        self.config = config
        self.reload()

    def reload(self) -> None:
        self.index = json.loads((self.config.output_dir / "material_index.json").read_text(encoding="utf-8"))
        self.script = json.loads((self.config.output_dir / "script.json").read_text(encoding="utf-8"))
        self.matches = json.loads((self.config.output_dir / "matches.json").read_text(encoding="utf-8"))

    def reload_if_changed(self) -> bool:
        self.reload()
        return False


def _project(tmp_path: Path) -> FakeProject:
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
            {"segment_id": "S1", "episode": 1, "scene_id": "SC1", "order": 1, "type": "scene_heading", "raw_text": "1-1 客厅 日"},
            {"segment_id": "S2", "episode": 1, "scene_id": "SC1", "order": 2, "type": "dialogue", "speaker": "王强", "text": "你好"},
            {"segment_id": "S3", "episode": 2, "scene_id": "SC2", "order": 1, "type": "scene_heading", "raw_text": "2-1 门口 夜"},
            {"segment_id": "S4", "episode": 2, "scene_id": "SC2", "order": 2, "type": "dialogue", "speaker": "李雪", "text": "走吧"},
        ]
    }
    material = {
        "groups": [
            {
                "group_id": "G1",
                "start": 0.0,
                "end": 5.0,
                "duration": 5.0,
                "members": [
                    {
                        "clip_id": "CA",
                        "media_id": "M_A",
                        "camera": "A",
                        "name": "A001.mov",
                        "media_path": "/Volumes/SECRET/A001.mov",
                        "source_start": 1.0,
                        "source_end": 6.0,
                        "duration": 5.0,
                    },
                    {
                        "clip_id": "CB",
                        "media_id": "M_B",
                        "camera": "B",
                        "name": "B001.mov",
                        "source_media_path": "/Volumes/SECRET/B001.mov",
                        "source_start": 0.0,
                        "source_end": 5.0,
                        "duration": 5.0,
                    },
                ],
            },
            {
                "group_id": "G2",
                "start": 8.0,
                "end": 12.0,
                "duration": 4.0,
                "members": [{"clip_id": "CC", "camera": "A", "name": "A002.mov", "duration": 4.0}],
            },
            {
                "group_id": "G3",
                "start": 20.0,
                "end": 25.0,
                "duration": 5.0,
                "members": [{"clip_id": "CD", "camera": "A", "name": "A003.mov", "duration": 5.0}],
            },
            {
                "group_id": "G4",
                "start": 30.0,
                "end": 33.0,
                "duration": 3.0,
                "members": [{"clip_id": "CE", "camera": "A", "name": "A004.mov", "duration": 3.0}],
            },
            {
                "group_id": "G5",
                "start": 40.0,
                "end": 43.0,
                "duration": 3.0,
                "members": [{"clip_id": "CF", "camera": "A", "name": "A005.mov", "duration": 3.0}],
            },
        ],
        "clips": [],
        "stats": {"groups": 5, "clips": 6},
    }
    matches = {
        "groups": {
            "G1": {"candidates": [{"candidate_id": "C1", "script_segment_ids": ["S2"], "total_score": 0.95}]},
            # Candidate-only evidence must not become scene coverage while the
            # automatic resolver still says needs_review.
            "G2": {"candidates": [{"candidate_id": "C2", "script_segment_ids": ["S2"], "total_score": 0.61}]},
            "G3": {"candidates": [{"candidate_id": "C3", "script_segment_ids": ["S4"], "total_score": 0.94}]},
        }
    }
    (output / "script.json").write_text(json.dumps(script, ensure_ascii=False), encoding="utf-8")
    (output / "material_index.json").write_text(json.dumps(material, ensure_ascii=False), encoding="utf-8")
    (output / "matches.json").write_text(json.dumps(matches, ensure_ascii=False), encoding="utf-8")

    AutomationStore(output).save(
        "analysis",
        {
            "G1": {"status": "auto_confirmed", "script_segment_ids": ["S2"], "episode_ids": [1], "confidence": 0.95},
            "G2": {"status": "needs_review", "script_segment_ids": ["S2"], "episode_ids": [1], "confidence": 0.61},
            "G3": {"status": "auto_confirmed", "script_segment_ids": ["S4"], "episode_ids": [2], "confidence": 0.94},
            "G4": {"status": "auto_confirmed", "script_segment_ids": [], "episode_ids": [2], "confidence": 0.88},
            "G5": {"status": "unresolved", "script_segment_ids": [], "episode_ids": [], "confidence": 0.0},
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
    mapping = _mapping_for_group(review, automatic, project.index["groups"][0])
    revision = _analysis_revision(output)
    AuditStore(output).save(
        {
            "analysis_revision": revision,
            "review_revision": 0,
            "summary": {"current_groups": 1},
            "groups": {
                "G1": {
                    "group_id": "G1",
                    "analysis_revision": revision,
                    "mapping": mapping,
                    "judge": {"verdict": "agree", "confidence": 0.9, "reason": "demo"},
                    "issues": [
                        {"code": "continuity_risk", "severity": "warning", "detail": "手位连续性需要确认"}
                    ],
                    "shot_intelligence": {
                        "angles": {
                            "CA": {"clip_id": "CA", "shot_type": "closeup", "coverage_role": "dialogue"},
                            "CB": {"clip_id": "CB", "shot_type": "medium", "coverage_role": "reaction"},
                        }
                    },
                    "rough_cut": {
                        "technical_usability": "good",
                        "take_completeness": "complete",
                        "coverage_role": "dialogue",
                        "continuity_risk": "high",
                    },
                    "role_suggestions": [],
                }
            },
        }
    )
    return project


def _scene(graph: dict, scene_id: str) -> dict:
    return next(item for item in graph["scenes"] if item["scene_id"] == scene_id)


def test_coverage_uses_effective_mapping_not_candidate_only_rows(tmp_path: Path) -> None:
    project = _project(tmp_path)
    graph = build_coverage_graph(project)
    sc1 = _scene(graph, "SC1")
    assert [row["group_id"] for row in sc1["take_groups"]] == ["G1"]
    assert sc1["summary"]["known_shots"] == 2
    assert sc1["summary"]["coverage_roles"] == {"dialogue": 1, "reaction": 1}
    assert sc1["summary"]["continuity_risks"] == 1
    assert continuity_risks(graph)[0]["group_id"] == "G1"
    assert graph["semantics"]["candidate_only_mapping_used"] is False


def test_individual_opinion_has_no_coverage_effect_and_final_is_annotation_only(tmp_path: Path) -> None:
    project = _project(tmp_path)
    store = EditorialStore(project.config.output_dir)
    store.apply_opinion(
        {
            "target_kind": "group",
            "group_id": "G1",
            "state": "best",
            "actor": "reviewer",
            "reviewer_id": "reviewer-1",
        }
    )
    opinion_graph = build_coverage_graph(project)
    opinion_row = _scene(opinion_graph, "SC1")["take_groups"][0]
    assert opinion_row["editorial_decision"]["state"] == "unreviewed"

    current = store.load()
    store.apply_decision(
        {
            "target_kind": "group",
            "group_id": "G1",
            "state": "keep",
            "actor": "editor",
            "expected_revision": current["revision"],
        }
    )
    final_graph = build_coverage_graph(project)
    final_row = _scene(final_graph, "SC1")["take_groups"][0]
    assert final_row["editorial_decision"]["state"] == "keep"
    assert final_row["mapping_source"] == "automatic"
    assert final_graph["semantics"]["editorial_decision_is_annotation_only"] is True
    assert final_graph["semantics"]["delivery_authority_changed"] is False
    assert final_graph["semantics"]["individual_opinions_used"] is False


def test_human_mapping_change_keeps_shot_facts_but_drops_old_continuity_judgment(tmp_path: Path) -> None:
    project = _project(tmp_path)
    ReviewStore(project.config.output_dir / "review.json").apply_action(
        {
            "action": "set_group_placement",
            "group_id": "G1",
            "episode_ids": [2],
            "script_segment_ids": ["S4"],
            "actor": "editor",
        }
    )
    graph = build_coverage_graph(project)
    sc1 = _scene(graph, "SC1")
    sc2 = _scene(graph, "SC2")
    assert all(row["group_id"] != "G1" for row in sc1["take_groups"])
    g1 = next(row for row in sc2["take_groups"] if row["group_id"] == "G1")
    assert g1["mapping_source"] == "human"
    assert g1["audit"]["visual_current"] is True
    assert g1["audit"]["mapping_stale"] is True
    assert [row["shot_type"] for row in g1["angles"]] == ["closeup", "medium"]
    assert g1["rough_cut"] == {}
    assert g1["continuity_issues"] == []
    assert all(row["group_id"] != "G1" for row in continuity_risks(graph))


def test_filtered_graph_scopes_episode_only_and_unplaced_rows(tmp_path: Path) -> None:
    project = _project(tmp_path)
    episode_one = build_coverage_graph(project, episode=1)
    assert [scene["scene_id"] for scene in episode_one["scenes"]] == ["SC1"]
    assert episode_one["episode_only_groups"] == []
    assert episode_one["unplaced_group_ids"] == []

    episode_two = build_coverage_graph(project, episode=2)
    assert [scene["scene_id"] for scene in episode_two["scenes"]] == ["SC2"]
    assert [row["group_id"] for row in episode_two["episode_only_groups"]] == ["G4"]
    assert episode_two["unplaced_group_ids"] == []

    global_graph = build_coverage_graph(project)
    assert global_graph["unplaced_group_ids"] == ["G2", "G5"]


def test_coverage_never_leaks_host_paths_or_infers_missing_shot_types(tmp_path: Path) -> None:
    project = _project(tmp_path)
    graph = build_coverage_graph(project)
    raw = json.dumps(graph, ensure_ascii=False)
    assert "/Volumes/SECRET" not in raw
    issue_codes = {
        issue["code"]
        for scene in graph["scenes"]
        for issue in scene.get("issues", [])
    }
    assert "missing_master" not in issue_codes
    assert "missing_reaction" not in issue_codes
    assert graph["semantics"]["missing_shots_are_not_inferred"] is True


def test_static_coverage_runtime_and_app_boundary() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "src" / "script_organizer" / "coverage_runtime.py").read_text(encoding="utf-8")
    editorial_runtime = (root / "src" / "script_organizer" / "editorial_runtime.py").read_text(encoding="utf-8")
    ui = (root / "web" / "coverage_ui.js").read_text(encoding="utf-8")
    css = (root / "web" / "coverage.css").read_text(encoding="utf-8")
    index = (root / "web" / "index.html").read_text(encoding="utf-8")

    assert 'parts[4] in {"coverage", "continuity"}' in runtime
    assert 'self._local_only()' in runtime
    assert 'self._agent("read", project_id)' in runtime
    assert '"write": False' in runtime
    assert '"delivery_authority": False' in runtime
    assert editorial_runtime.index("install_audit_runtime()") < editorial_runtime.index("install_coverage_runtime()") < editorial_runtime.index("install_assistant_runtime()")

    assert "window.webkit?.messageHandlers?.mirrorOrder" in ui
    assert "projectApi('/coverage')" in ui
    assert "不会因为没识别到某种景别就推断" in ui
    assert "不会变成 Editorial Decision 或 delivery.v1 的 Best" in ui
    assert 'data-focus-group=' in ui
    assert "html.native-production" in css
    assert '/coverage.css' in index
    assert '/coverage_ui.js' in index
