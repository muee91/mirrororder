from __future__ import annotations

import json
import shutil
from collections import Counter
from pathlib import Path
from typing import Any

from .automation_store import AutomationStore, COMPLETED_STATUSES
from .config import ProjectConfig
from .delivery_semantics import resolve_delivery_state
from .editorial_store import EditorialStore
from .review_store import ReviewStore


class UnsafeFCPXMLExport(RuntimeError):
    pass


def _load(path: Path, fallback: object) -> object:
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return fallback


def _placement_for_group(review: dict[str, Any], group: dict[str, Any]) -> dict[str, Any]:
    group_id = str(group.get("group_id", "") or "")
    parent_group_id = str(group.get("parent_group_id", "") or "")
    placement = review.get("placements", {}).get(group_id, {})
    if not placement and parent_group_id:
        placement = review.get("placements", {}).get(parent_group_id, {})
    return placement if isinstance(placement, dict) else {}


def _automatic_manifest_state(candidate: dict[str, Any]) -> str:
    # Preserve the v2 manifest compatibility rule. This is explicitly marked as
    # an automatic mapping fallback in v3 and remains lower-authority than any
    # human review or Editorial Decision.
    return (
        "keep"
        if candidate.get("confidence") in {"exact_dialogue", "possible_dialogue", "manual"}
        else "unreviewed"
    )


def build_selection_manifest(config: ProjectConfig) -> dict[str, Any]:
    index = _load(config.output_dir / "material_index.json", {})
    script = _load(config.output_dir / "script.json", {})
    matches = _load(config.output_dir / "matches.json", {})
    automatic_groups = AutomationStore(config.output_dir).load().get("groups", {})
    if not isinstance(automatic_groups, dict):
        automatic_groups = {}
    review = ReviewStore(config.output_dir / "review.json").load()
    editorial = EditorialStore(config.output_dir).load()
    groups_by_id = {
        item.get("group_id"): item
        for item in index.get("groups", [])
        if isinstance(item, dict)
    }
    segment_rows = []
    state_counts: Counter[str] = Counter()
    source_counts: Counter[str] = Counter()

    for segment in script.get("segments", []):
        segment_id = segment.get("segment_id")

        # A manual script range is authoritative over stale automatic matching.
        # Episode-only placement stays contextual and intentionally does not erase
        # an automatic line candidate because the editor did not confirm a line.
        match_row = []
        for raw_candidate in matches.get("by_segment", {}).get(segment_id, []):
            if not isinstance(raw_candidate, dict):
                continue
            group_id = raw_candidate.get("group_id")
            group = groups_by_id.get(group_id, {})
            placement = _placement_for_group(review, group)
            placement_ids = [str(value) for value in placement.get("script_segment_ids", []) if value]
            if placement_ids and segment_id not in placement_ids:
                continue
            candidate = dict(raw_candidate)
            if placement_ids and segment_id in placement_ids:
                candidate["confidence"] = "manual"
            match_row.append(candidate)

        # Completed automation decisions are current production mapping facts.
        # review/editorial still resolve at higher authority below, and an exact
        # human placement suppresses stale automatic line assignments.
        existing_group_ids = {str(item.get("group_id", "") or "") for item in match_row}
        for group_id, raw_entry in automatic_groups.items():
            entry = raw_entry if isinstance(raw_entry, dict) else {}
            if str(entry.get("status", "") or "") not in COMPLETED_STATUSES:
                continue
            mapped_ids = [str(value) for value in entry.get("script_segment_ids", []) if value]
            if str(segment_id or "") not in mapped_ids or str(group_id) in existing_group_ids:
                continue
            group = groups_by_id.get(group_id, {})
            placement = _placement_for_group(review, group)
            placement_ids = [str(value) for value in placement.get("script_segment_ids", []) if value]
            if placement_ids and segment_id not in placement_ids:
                continue
            match_row.append(
                {
                    "group_id": group_id,
                    "confidence": "manual" if segment_id in placement_ids else "exact_dialogue",
                    "automation_status": str(entry.get("status", "") or ""),
                }
            )
            existing_group_ids.add(str(group_id))

        automatic_group_ids = {item.get("group_id") for item in match_row}
        for group_id, group in groups_by_id.items():
            placement = _placement_for_group(review, group)
            placement_ids = [str(value) for value in placement.get("script_segment_ids", []) if value]
            if segment_id in placement_ids and group_id not in automatic_group_ids:
                match_row.append({"group_id": group_id, "confidence": "manual"})

        selected = []
        for candidate in match_row:
            group_id = candidate.get("group_id")
            group = groups_by_id.get(group_id, {})
            automatic_state = _automatic_manifest_state(candidate)
            resolved = resolve_delivery_state(
                review=review,
                editorial=editorial,
                segment_id=str(segment_id or ""),
                group=group,
                automatic_state=automatic_state,
            )
            state_counts[resolved["state"]] += 1
            source_counts[resolved["decision_source"]] += 1
            selected.append(
                {
                    "group_id": group_id,
                    "state": resolved["state"],
                    "decision_source": resolved["decision_source"],
                    "decision_actor": resolved["decision_actor"],
                    "decision_updated_at": resolved["decision_updated_at"],
                    "legacy_state": resolved["legacy_state"],
                    "automatic_state": resolved["automatic_state"],
                }
            )
        selected.sort(
            key=lambda item: (
                {"best": 0, "keep": 1, "unreviewed": 2, "reject": 3}.get(item["state"], 2),
                str(item.get("group_id", "")),
            )
        )
        segment_rows.append(
            {
                "episode": segment.get("episode"),
                "scene": segment.get("scene_id"),
                "script_segment": segment_id,
                "text": segment.get("text", ""),
                "groups": selected,
            }
        )

    return {
        "version": 3,
        "contract": "delivery.v1",
        "project": config.name,
        "source_fcpxml": str(config.fcpxml) if config.fcpxml else "",
        "manual_review_path": str(config.output_dir / "review.json"),
        "editorial_path": str(config.output_dir / "editorial.json"),
        "revisions": {
            "review": int(review.get("revision", 0) or 0),
            "editorial": int(editorial.get("revision", 0) or 0),
        },
        "decision_policy": {
            "precedence": [
                "editorial_assignment",
                "editorial_group",
                "legacy_assignment",
                "legacy_assignment_inherited",
                "legacy_group_or_clip",
                "automatic_mapping_fallback",
            ],
            "individual_opinions_are_delivery_authority": False,
            "majority_vote_enabled": False,
            "automatic_mapping_fallback": "legacy_compatibility",
            "editorial_parent_inheritance": False,
        },
        "summary": {
            "states": dict(sorted(state_counts.items())),
            "sources": dict(sorted(source_counts.items())),
        },
        "segments": segment_rows,
    }


def export(config: ProjectConfig, preserve_source: bool = True) -> dict[str, Any]:
    manifest = build_selection_manifest(config)
    manifest_path = config.output_dir / "selection_manifest.json"
    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)

    output_fcpxml = config.output_dir / "organized.fcpxml"
    report: dict[str, Any] = {
        "organized_fcpxml": str(output_fcpxml),
        "selection_manifest": str(manifest_path),
        "selection_contract": manifest.get("contract", ""),
        "selection_manifest_version": manifest.get("version", 0),
        "selection_summary": manifest.get("summary", {}),
        "keywords_written": False,
        "multicam_structure_modified": False,
    }
    if preserve_source and config.fcpxml:
        # The organizer never rewrites a user's synced multicam timeline. The
        # copied file is intentionally byte-for-byte source preservation.
        shutil.copyfile(config.fcpxml, output_fcpxml)
        report["warning"] = (
            "organized.fcpxml is an unchanged copy; delivery.v1 decisions are "
            "recorded in selection_manifest.json and are not yet injected into FCPXML."
        )
    elif preserve_source:
        report["warning"] = (
            "媒体目录项目没有输入FCPXML；delivery.v1 仅导出 selection_manifest，"
            "不生成 organized.fcpxml。"
        )
    else:
        raise UnsafeFCPXMLExport("Refusing to synthesize an FCPXML without a structure-specific safe exporter.")
    with (config.output_dir / "export_report.json").open("w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    return report
