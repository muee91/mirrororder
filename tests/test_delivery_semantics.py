from __future__ import annotations

import json
from pathlib import Path

from script_organizer.config import ProjectConfig
from script_organizer.delivery_semantics import resolve_delivery_state
from script_organizer.fcpxml_exporter import build_selection_manifest


def _group(group_id: str = "G_1", parent_group_id: str = "") -> dict:
    return {
        "group_id": group_id,
        "parent_group_id": parent_group_id,
        "members": [{"clip_id": "C_1"}],
    }


def _review(*, assignment: str = "", group_state: str = "") -> dict:
    payload = {
        "version": 2,
        "revision": 1,
        "assignments": {},
        "groups": {},
        "clips": {},
        "placements": {},
    }
    if assignment:
        payload["assignments"] = {
            "S_1": {"G_1": {"state": assignment, "actor": "legacy-editor"}}
        }
    if group_state:
        payload["groups"] = {"G_1": {"state": group_state, "actor": "legacy-editor"}}
    return payload


def test_assignment_editorial_decision_overrides_legacy_and_automatic() -> None:
    editorial = {
        "decisions": {
            "assignment|S_1|G_1": {
                "target": {"kind": "assignment", "segment_id": "S_1", "group_id": "G_1"},
                "state": "reject",
                "actor": "主剪",
                "updated_at": "2026-08-24T01:00:00+00:00",
            }
        },
        "opinions": {},
    }
    result = resolve_delivery_state(
        review=_review(assignment="best"),
        editorial=editorial,
        segment_id="S_1",
        group=_group(),
        automatic_state="keep",
    )
    assert result["state"] == "reject"
    assert result["decision_source"] == "editorial_assignment"
    assert result["decision_actor"] == "主剪"
    assert result["automatic_state"] == "keep"


def test_group_editorial_decision_is_used_when_assignment_has_no_final_decision() -> None:
    editorial = {
        "decisions": {
            "group|G_1": {
                "target": {"kind": "group", "group_id": "G_1", "segment_id": ""},
                "state": "best",
                "actor": "导演",
            }
        }
    }
    result = resolve_delivery_state(
        review=_review(group_state="keep"),
        editorial=editorial,
        segment_id="S_1",
        group=_group(),
        automatic_state="keep",
    )
    assert result["state"] == "best"
    assert result["decision_source"] == "editorial_group"


def test_without_final_decision_legacy_review_remains_compatible() -> None:
    result = resolve_delivery_state(
        review=_review(assignment="best"),
        editorial={"opinions": {}, "decisions": {}},
        segment_id="S_1",
        group=_group(),
        automatic_state="keep",
    )
    assert result["state"] == "best"
    assert result["decision_source"] == "legacy_assignment"
    assert result["legacy_state"] == "best"


def test_individual_opinions_never_vote_a_delivery_decision() -> None:
    editorial = {
        "opinions": {
            "assignment|S_1|G_1": {
                "target": {"kind": "assignment", "segment_id": "S_1", "group_id": "G_1"},
                "reviewers": {
                    "id:a": {"state": "best", "actor": "A", "reviewer_id": "a"},
                    "id:b": {"state": "best", "actor": "B", "reviewer_id": "b"},
                    "id:c": {"state": "best", "actor": "C", "reviewer_id": "c"},
                },
            }
        },
        "decisions": {},
    }
    result = resolve_delivery_state(
        review=_review(),
        editorial=editorial,
        segment_id="S_1",
        group=_group(),
        automatic_state="keep",
    )
    assert result["state"] == "keep"
    assert result["decision_source"] == "automatic_mapping_fallback"


def test_editorial_decision_does_not_silently_inherit_from_parent_split_group() -> None:
    editorial = {
        "decisions": {
            "group|G_PARENT": {
                "target": {"kind": "group", "group_id": "G_PARENT", "segment_id": ""},
                "state": "reject",
                "actor": "主剪",
            }
        }
    }
    result = resolve_delivery_state(
        review=_review(),
        editorial=editorial,
        segment_id="S_1",
        group=_group("G_CHILD", "G_PARENT"),
        automatic_state="keep",
    )
    assert result["state"] == "keep"
    assert result["decision_source"] == "automatic_mapping_fallback"


def test_build_selection_manifest_v4_applies_editorial_decision_without_device_paths(tmp_path: Path) -> None:
    output = tmp_path / "output"
    output.mkdir()
    config = ProjectConfig(
        config_path=tmp_path / "project.toml",
        name="Delivery Demo",
        fcpxml=tmp_path / "private-source.fcpxml",
        script=tmp_path / "script.txt",
        output_dir=output,
        transcript_dir=tmp_path / "transcripts",
        input_kind="fcpxml",
    )
    (output / "material_index.json").write_text(
        json.dumps({
            "groups": [
                {
                    "group_id": "G_1",
                    "parent_group_id": "",
                    "members": [{"clip_id": "C_1"}],
                }
            ]
        }),
        encoding="utf-8",
    )
    (output / "script.json").write_text(
        json.dumps({
            "segments": [
                {
                    "segment_id": "S_1",
                    "episode": 1,
                    "scene_id": "SC_1",
                    "text": "你好",
                }
            ]
        }, ensure_ascii=False),
        encoding="utf-8",
    )
    candidate = {
        "group_id": "G_1",
        "confidence": "exact_dialogue",
        "total_score": 0.95,
    }
    (output / "matches.json").write_text(
        json.dumps({"by_segment": {"S_1": [candidate]}}),
        encoding="utf-8",
    )
    (output / "review.json").write_text(
        json.dumps({
            "version": 2,
            "revision": 4,
            "assignments": {"S_1": {"G_1": {"state": "best", "actor": "legacy"}}},
            "groups": {},
            "clips": {},
            "placements": {},
        }),
        encoding="utf-8",
    )
    (output / "editorial.json").write_text(
        json.dumps({
            "version": 2,
            "revision": 7,
            "opinions": {
                "assignment|S_1|G_1": {
                    "target": {"kind": "assignment", "segment_id": "S_1", "group_id": "G_1"},
                    "reviewers": {
                        "id:a": {"state": "best", "actor": "A", "reviewer_id": "a"},
                    },
                }
            },
            "decisions": {
                "assignment|S_1|G_1": {
                    "target": {"kind": "assignment", "segment_id": "S_1", "group_id": "G_1"},
                    "state": "reject",
                    "actor": "主剪",
                    "updated_at": "2026-08-24T01:00:00+00:00",
                }
            },
        }, ensure_ascii=False),
        encoding="utf-8",
    )

    manifest = build_selection_manifest(config)
    row = manifest["segments"][0]["groups"][0]
    assert manifest["version"] == 4
    assert manifest["contract"] == "delivery.v1"
    assert manifest["source"] == {"input_kind": "fcpxml", "fcpxml_name": "private-source.fcpxml"}
    assert manifest["artifacts"] == {"review": "review.json", "editorial": "editorial.json"}
    assert manifest["revisions"] == {"review": 4, "editorial": 7}
    assert manifest["decision_policy"]["majority_vote_enabled"] is False
    assert row["state"] == "reject"
    assert row["decision_source"] == "editorial_assignment"
    assert row["decision_actor"] == "主剪"
    assert row["legacy_state"] == ""
    assert row["automatic_state"] == "keep"
    assert manifest["summary"]["sources"] == {"editorial_assignment": 1}
    assert manifest["semantics"]["device_paths_exposed"] is False
    raw = json.dumps(manifest, ensure_ascii=False)
    assert str(tmp_path) not in raw
    assert "manual_review_path" not in raw
    assert "editorial_path" not in raw
    assert "source_fcpxml" not in raw


def test_selection_manifest_v4_documents_delivery_contract() -> None:
    root = Path(__file__).resolve().parents[1]
    exporter = (root / "src" / "script_organizer" / "fcpxml_exporter.py").read_text(encoding="utf-8")
    semantics = (root / "src" / "script_organizer" / "delivery_semantics.py").read_text(encoding="utf-8")

    assert '"version": 4' in exporter
    assert '"contract": "delivery.v1"' in exporter
    assert '"device_paths_exposed": False' in exporter
    assert '"artifact_refs_are_project_output_relative": True' in exporter
    assert '"majority_vote_enabled": False' in exporter
    assert '"individual_opinions_are_delivery_authority": False' in exporter
    assert "manual_review_path" not in exporter
    assert "editorial_path" not in exporter
    assert "source_fcpxml" not in exporter
    assert "editorial_decision_for" in semantics
    assert "opinions" not in semantics.split("def resolve_delivery_state", 1)[1]
