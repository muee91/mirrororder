from __future__ import annotations

from pathlib import Path

import pytest

from script_organizer.editorial_store import EditorialConflictError, EditorialStore


def test_individual_opinions_merge_by_reviewer_without_overwriting_peers(tmp_path: Path) -> None:
    store = EditorialStore(tmp_path)

    first = store.apply_opinion(
        {
            "target_kind": "group",
            "group_id": "G_1",
            "state": "best",
            "actor": "剪辑A",
            "reviewer_id": "reviewer-editor-a",
        }
    )
    second = store.apply_opinion(
        {
            "target_kind": "group",
            "group_id": "G_1",
            "state": "keep",
            "actor": "导演B",
            "reviewer_id": "reviewer-director-b",
        }
    )

    assert first["revision"] == 1
    assert second["revision"] == 2
    group = store.for_group("G_1")
    opinions = {row["reviewer_id"]: row["state"] for row in group["opinions"]["group"]}
    assert opinions == {"reviewer-editor-a": "best", "reviewer-director-b": "keep"}

    store.apply_opinion(
        {
            "target_kind": "group",
            "group_id": "G_1",
            "state": "unreviewed",
            "actor": "剪辑A",
            "reviewer_id": "reviewer-editor-a",
        }
    )
    opinions = {row["reviewer_id"]: row["state"] for row in store.for_group("G_1")["opinions"]["group"]}
    assert opinions == {"reviewer-director-b": "keep"}


def test_same_display_name_does_not_collapse_distinct_reviewer_ids(tmp_path: Path) -> None:
    store = EditorialStore(tmp_path)
    for reviewer_id, state in (("reviewer-1", "best"), ("reviewer-2", "keep")):
        store.apply_opinion(
            {
                "target_kind": "group",
                "group_id": "G_1",
                "state": state,
                "actor": "小王",
                "reviewer_id": reviewer_id,
            }
        )

    rows = store.for_group("G_1")["opinions"]["group"]
    assert len(rows) == 2
    assert {row["reviewer_id"] for row in rows} == {"reviewer-1", "reviewer-2"}
    assert {row["actor"] for row in rows} == {"小王"}


def test_assignment_opinion_keeps_script_target_explicit(tmp_path: Path) -> None:
    store = EditorialStore(tmp_path)
    store.apply_opinion(
        {
            "target_kind": "assignment",
            "segment_id": "S_27_18",
            "group_id": "G_27_03",
            "state": "keep",
            "actor": "制片",
            "reviewer_id": "reviewer-producer",
        }
    )

    rows = store.for_group("G_27_03")["opinions"]["assignments"]
    assert len(rows) == 1
    assert rows[0]["target"] == {
        "kind": "assignment",
        "group_id": "G_27_03",
        "segment_id": "S_27_18",
    }
    assert rows[0]["actor"] == "制片"
    assert rows[0]["reviewer_id"] == "reviewer-producer"
    assert rows[0]["state"] == "keep"


def test_final_editorial_decision_rejects_stale_revision(tmp_path: Path) -> None:
    store = EditorialStore(tmp_path)
    store.apply_opinion(
        {
            "target_kind": "group",
            "group_id": "G_1",
            "state": "keep",
            "actor": "剪辑A",
            "reviewer_id": "reviewer-editor-a",
        }
    )
    revision = store.load()["revision"]

    saved = store.apply_decision(
        {
            "target_kind": "group",
            "group_id": "G_1",
            "state": "best",
            "actor": "主剪",
            "expected_revision": revision,
        }
    )
    assert saved["revision"] == revision + 1
    assert store.for_group("G_1")["decision"]["group"]["state"] == "best"

    with pytest.raises(EditorialConflictError):
        store.apply_decision(
            {
                "target_kind": "group",
                "group_id": "G_1",
                "state": "reject",
                "actor": "主剪",
                "expected_revision": revision,
            }
        )


def test_editorial_store_never_writes_legacy_review_file(tmp_path: Path) -> None:
    store = EditorialStore(tmp_path)
    saved = store.apply_opinion(
        {
            "target_kind": "group",
            "group_id": "G_1",
            "state": "keep",
            "actor": "审核人",
            "reviewer_id": "reviewer-a",
        }
    )

    assert saved["version"] == 2
    assert (tmp_path / "editorial.json").is_file()
    assert not (tmp_path / "review.json").exists()
    assert not (tmp_path / "auto_decisions.json").exists()


def test_runtime_keeps_final_decision_host_local_and_review_v1_versioned() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "src" / "script_organizer" / "editorial_runtime.py").read_text(encoding="utf-8")
    cli = (root / "src" / "script_organizer" / "cli.py").read_text(encoding="utf-8")
    runtime_stack = (root / "src" / "script_organizer" / "runtime_stack.py").read_text(encoding="utf-8")
    adapter = (root / "web" / "review_model.js").read_text(encoding="utf-8")

    assert 'parts[4] == "opinions"' in runtime
    assert 'parts[4] == "editorial-decision"' in runtime
    assert "self._local_only()" in runtime
    assert '"editorial_decision_write_scope": "host_local"' in runtime
    assert "install_production_runtime()" in cli
    assert runtime_stack.index("install_review_read_model_runtime()") < runtime_stack.index("install_editorial_runtime()")
    assert "state.editorialRevision = Number(revisions.editorial || 0);" in adapter
    assert "next.editorial_revision" in adapter
