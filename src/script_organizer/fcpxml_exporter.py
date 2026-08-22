from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from .config import ProjectConfig
from .review_store import ReviewStore, effective_group_state


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


def build_selection_manifest(config: ProjectConfig) -> dict[str, Any]:
    index = _load(config.output_dir / "material_index.json", {})
    script = _load(config.output_dir / "script.json", {})
    matches = _load(config.output_dir / "matches.json", {})
    review = ReviewStore(config.output_dir / "review.json").load()
    groups_by_id = {item.get("group_id"): item for item in index.get("groups", []) if isinstance(item, dict)}
    segment_rows = []
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
            member_ids = [member.get("clip_id") for member in group.get("members", [])]
            automatic_state = "keep" if candidate.get("confidence") in {"exact_dialogue", "possible_dialogue", "manual"} else "unreviewed"
            parent_group_id = str(group.get("parent_group_id", "") or "")
            state = effective_group_state(review, group_id, member_ids, parent_group_id)
            assignment = review.get("assignments", {}).get(segment_id, {}).get(group_id, {})
            if not assignment and parent_group_id:
                assignment = review.get("assignments", {}).get(segment_id, {}).get(parent_group_id, {})
            if assignment.get("state") in {"best", "keep", "reject", "unreviewed"}:
                state = assignment["state"]
            if state == "unreviewed":
                state = automatic_state
            selected.append({"group_id": group_id, "state": state, "automatic_state": automatic_state})
        selected.sort(key=lambda item: {"best": 0, "keep": 1, "unreviewed": 2, "reject": 3}.get(item["state"], 2))
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
        "version": 2,
        "project": config.name,
        "source_fcpxml": str(config.fcpxml) if config.fcpxml else "",
        "manual_review_path": str(config.output_dir / "review.json"),
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
        "keywords_written": False,
        "multicam_structure_modified": False,
    }
    if preserve_source and config.fcpxml:
        # The organizer never rewrites a user's synced multicam timeline. The
        # copied file is intentionally byte-for-byte source preservation.
        shutil.copyfile(config.fcpxml, output_fcpxml)
        report["warning"] = "organized.fcpxml is an unchanged copy; keyword/rating injection is not claimed safe for this source structure."
    elif preserve_source:
        report["warning"] = "媒体目录项目没有输入FCPXML；仅导出 selection_manifest，不生成 organized.fcpxml。"
    else:
        raise UnsafeFCPXMLExport("Refusing to synthesize an FCPXML without a structure-specific safe exporter.")
    with (config.output_dir / "export_report.json").open("w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    return report
