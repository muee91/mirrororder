from __future__ import annotations

import json
from pathlib import Path

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
from script_organizer.script_supervisor_store import ScriptSupervisorStore


FIXTURE = Path(__file__).parent / "fixtures" / "golden-mini-drama" / "scenario.json"


class GoldenProject:
    def __init__(self, config: ProjectConfig, project_id: str, workspace_id: str):
        self.config = config
        self.project_id = project_id
        self.workspace_id = workspace_id
        self.reload()

    def reload(self) -> None:
        output = self.config.output_dir
        self.index = json.loads((output / "material_index.json").read_text(encoding="utf-8"))
        self.script = json.loads((output / "script.json").read_text(encoding="utf-8"))
        self.matches = json.loads((output / "matches.json").read_text(encoding="utf-8"))

    def reload_if_changed(self) -> bool:
        self.reload()
        return False


def _scenario() -> dict:
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert payload["contract"] == "mirrororder.golden_project.v1"
    return payload


def _write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _group(project: GoldenProject, group_id: str) -> dict:
    return next(group for group in project.index["groups"] if group["group_id"] == group_id)


def _scene(payload: dict, scene_id: str) -> dict:
    return next(scene for scene in payload["scenes"] if scene["scene_id"] == scene_id)


def _segment(scene: dict, segment_id: str) -> dict:
    return next(
        segment
        for segment in scene["segments"]
        if segment.get("script", {}).get("segment_id") == segment_id
    )


def _materialize(tmp_path: Path) -> GoldenProject:
    scenario = _scenario()
    root = tmp_path / "golden-mini-drama"
    output = root / "output"
    transcripts = root / "cache" / "transcripts"
    output.mkdir(parents=True)
    transcripts.mkdir(parents=True)
    script_path = root / "script.txt"
    config_path = root / "project.toml"
    script_path.write_text("Synthetic golden mini-drama. Runtime uses output/script.json.", encoding="utf-8")
    config_path.write_text(
        "[project]\nname = 'Golden Mini Drama'\n[input]\nkind = 'media-directory'\nscript = './script.txt'\n[output]\ndirectory = './output'\n",
        encoding="utf-8",
    )

    _write_json(output / "script.json", scenario["script"])
    _write_json(
        output / "material_index.json",
        {
            "groups": scenario["groups"],
            "clips": [],
            "stats": {
                "groups": len(scenario["groups"]),
                "clips": sum(len(group.get("members", [])) for group in scenario["groups"]),
            },
        },
    )
    _write_json(output / "matches.json", scenario["matches"])
    AutomationStore(output).save("golden-analysis", scenario["automation"], {})

    config = ProjectConfig(
        config_path=config_path,
        name="Golden Mini Drama",
        fcpxml=None,
        script=script_path,
        output_dir=output,
        transcript_dir=transcripts,
        input_kind="media-directory",
        media_root=None,
    )
    project = GoldenProject(
        config,
        str(scenario["project_id"]),
        str(scenario["workspace_id"]),
    )

    review_store = ReviewStore(output / "review.json")
    for row in scenario["human_placements"]:
        review_store.apply_action(
            {
                "action": "set_group_placement",
                "group_id": row["group_id"],
                "episode_ids": row["episode_ids"],
                "script_segment_ids": row["script_segment_ids"],
                "actor": row["actor"],
                "interaction": "golden_fixture",
                "source_surface": "test",
                "source_kind": "take",
            }
        )

    # Audit evidence is generated against the effective mapping after the human
    # placement above. Subsequent reopen must preserve this freshness boundary.
    review = review_store.load()
    automation = AutomationStore(output).load()["groups"]
    revision = _analysis_revision(output)
    audit_groups: dict[str, dict] = {}
    for group_id, raw in scenario["audit"].items():
        group = _group(project, group_id)
        audit_groups[group_id] = {
            "group_id": group_id,
            "analysis_revision": revision,
            "mapping": _mapping_for_group(review, automation[group_id], group),
            "judge": {"verdict": "agree", "confidence": 0.92, "reason": "synthetic golden evidence"},
            "issues": [],
            "shot_intelligence": {
                "angles": {
                    clip_id: {"clip_id": clip_id, **facts}
                    for clip_id, facts in raw["angles"].items()
                }
            },
            "rough_cut": raw["rough_cut"],
            "role_suggestions": [],
        }
    AuditStore(output).save(
        {
            "analysis_revision": revision,
            "review_revision": int(review.get("revision", 0) or 0),
            "summary": {"current_groups": len(audit_groups)},
            "groups": audit_groups,
        }
    )

    slate_store = ScriptSupervisorStore(output)
    slate_revision = 0
    for row in scenario["slate"]:
        saved = slate_store.apply(
            {
                "group_id": row["group_id"],
                "expected_revision": slate_revision,
                "actor": row["actor"],
                "entry": row["entry"],
            }
        )
        slate_revision = int(saved["revision"])

    editorial = EditorialStore(output)
    # A reviewer may like the NG take. This opinion must never become rough-cut
    # or delivery authority without an explicit final Editorial Decision.
    editorial.apply_opinion(
        {
            "target_kind": "group",
            "group_id": "G_E1_SC1_T2",
            "state": "best",
            "actor": "Reviewer A",
            "reviewer_id": "reviewer-a",
        }
    )
    for row in scenario["editorial_decisions"]:
        current = editorial.load()
        editorial.apply_decision(
            {
                "target_kind": "group",
                "group_id": row["group_id"],
                "state": row["state"],
                "actor": row["actor"],
                "expected_revision": int(current["revision"]),
            }
        )

    return project


def test_golden_project_cross_module_production_semantics(tmp_path: Path) -> None:
    project = _materialize(tmp_path)

    coverage = build_coverage_graph(project)
    e1_sc1 = _scene(coverage, "E1_SC1")
    e1_sc2 = _scene(coverage, "E1_SC2")
    e2_sc1 = _scene(coverage, "E2_SC1")

    assert {row["group_id"] for row in e1_sc1["take_groups"]} == {"G_E1_SC1_T1", "G_E1_SC1_T2"}
    assert [row["group_id"] for row in e1_sc2["take_groups"]] == ["G_E1_SC2_T1"]
    assert e1_sc2["take_groups"][0]["mapping_source"] == "human"
    assert [row["group_id"] for row in e2_sc1["take_groups"]] == ["G_E2_SC1_T1"]
    assert "G_UNPLACED" in coverage["unplaced_group_ids"]
    assert coverage["semantics"]["candidate_only_mapping_used"] is False

    plan = build_rough_cut_plan(project)
    sc1_plan = _scene(plan, "E1_SC1")
    first = _segment(sc1_plan, "E1_SC1_S1")
    second = _segment(sc1_plan, "E1_SC1_S2")
    assert first["selection_status"] == "explicit_best"
    assert second["selection_status"] == "explicit_best"
    assert first["primary_group_id"] == "G_E1_SC1_T1"
    assert second["primary_group_id"] == "G_E1_SC1_T1"
    ng = next(row for row in first["candidates"] if row["group_id"] == "G_E1_SC1_T2")
    assert ng["delivery_state"] == "keep"
    assert ng["supervisor_blocked"] is True
    assert first["summary"]["eligible"] == 1
    assert plan["semantics"]["keep_promoted_to_best"] is False
    assert plan["semantics"]["script_supervisor_ng_is_delivery_reject"] is False

    sc2_plan = _scene(plan, "E1_SC2")
    sc2_segment = _segment(sc2_plan, "E1_SC2_S1")
    assert sc2_segment["selection_status"] == "needs_editorial_choice"
    assert sc2_segment["primary_group_id"] == ""
    assert sc2_segment["candidates"][0]["delivery_state"] == "keep"

    assembly = build_assembly_timeline(project)
    sc1_assembly = _scene(assembly, "E1_SC1")
    assert len(sc1_assembly["blocks"]) == 1
    block = sc1_assembly["blocks"][0]
    assert block["group_id"] == "G_E1_SC1_T1"
    assert block["script_segment_ids"] == ["E1_SC1_S1", "E1_SC1_S2"]
    assert block["angle"]["status"] == "manual_preferred"
    assert block["angle"]["clip_id"] == "C_E1_SC1_T1_B"
    assert block["usable_range"]["status"] == "manual"
    assert block["usable_range"]["start"] == 1.0
    assert block["usable_range"]["end"] == 7.0
    assert block["duration"] == 6.0
    assert assembly["semantics"]["preview_only"] is True

    manifest = build_selection_manifest(project.config)
    rows = {
        (segment["script_segment"], row["group_id"]): row
        for segment in manifest["segments"]
        for row in segment["groups"]
    }
    assert rows[("E1_SC1_S1", "G_E1_SC1_T1")]["state"] == "best"
    assert rows[("E1_SC1_S1", "G_E1_SC1_T2")]["state"] == "keep"
    assert rows[("E1_SC1_S1", "G_E1_SC1_T2")]["decision_source"] == "automatic_mapping_fallback"
    assert rows[("E1_SC2_S1", "G_E1_SC2_T1")]["state"] == "keep"
    assert rows[("E1_SC2_S1", "G_E1_SC2_T1")]["decision_source"] == "editorial_group"
    assert rows[("E2_SC1_S1", "G_E2_SC1_T1")]["state"] == "best"
    assert manifest["decision_policy"]["individual_opinions_are_delivery_authority"] is False

    # Production read models must never expose Host media/device paths. Delivery
    # manifest artifact references are checked separately by the delivery path
    # normalization contract; decision rows themselves remain path-free here.
    serialized = json.dumps(
        {"coverage": coverage, "rough_cut": plan, "assembly": assembly},
        ensure_ascii=False,
    )
    assert "/Volumes/" not in serialized
    assert "/Users/" not in serialized
    assert "C:\\" not in serialized
    assert "/Volumes/" not in json.dumps(manifest["segments"], ensure_ascii=False)


def test_golden_project_reopen_preserves_authority_and_revisions(tmp_path: Path) -> None:
    project = _materialize(tmp_path)
    before_coverage = build_coverage_graph(project)
    before_plan = build_rough_cut_plan(project)
    before_manifest = build_selection_manifest(project.config)
    before_review = ReviewStore(project.config.output_dir / "review.json").load()
    before_editorial = EditorialStore(project.config.output_dir).load()
    before_slate = ScriptSupervisorStore(project.config.output_dir).load()

    reopened = GoldenProject(project.config, project.project_id, project.workspace_id)
    after_coverage = build_coverage_graph(reopened)
    after_plan = build_rough_cut_plan(reopened)
    after_manifest = build_selection_manifest(reopened.config)

    assert after_coverage["revision"] == before_coverage["revision"]
    assert after_plan["coverage_revision"] == before_plan["coverage_revision"]
    assert after_manifest["revisions"] == before_manifest["revisions"]
    assert ReviewStore(reopened.config.output_dir / "review.json").load()["revision"] == before_review["revision"]
    assert EditorialStore(reopened.config.output_dir).load()["revision"] == before_editorial["revision"]
    assert ScriptSupervisorStore(reopened.config.output_dir).load()["revision"] == before_slate["revision"]

    reopened_sc2 = _scene(after_coverage, "E1_SC2")["take_groups"][0]
    assert reopened_sc2["group_id"] == "G_E1_SC2_T1"
    assert reopened_sc2["mapping_source"] == "human"
    reopened_best = _segment(_scene(after_plan, "E1_SC1"), "E1_SC1_S1")
    assert reopened_best["primary_group_id"] == "G_E1_SC1_T1"


def test_golden_fixture_is_synthetic_and_not_a_workspace_snapshot() -> None:
    raw = FIXTURE.read_text(encoding="utf-8")
    payload = json.loads(raw)
    assert payload["contract"] == "mirrororder.golden_project.v1"
    assert len(payload["script"]["segments"]) == 7
    assert len(payload["groups"]) == 5
    for forbidden in ("/Volumes/", "/Users/", "C:\\", "registry.json", "device_id", "api_key"):
        assert forbidden not in raw
