from __future__ import annotations

import json
import shutil
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from fractions import Fraction
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
    # Automatic mapping remains a lower-authority fallback than any explicit
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
        "version": 4,
        "contract": "delivery.v1",
        "project": config.name,
        "source": {
            "input_kind": config.input_kind,
            "fcpxml_name": config.fcpxml.name if config.fcpxml else "",
        },
        "artifacts": {
            "review": "review.json",
            "editorial": "editorial.json",
        },
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
        "semantics": {
            "device_paths_exposed": False,
            "artifact_refs_are_project_output_relative": True,
            "source_path_is_host_local_only": True,
        },
    }


def _tag(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def _parse_time(value: object) -> Fraction | None:
    raw = str(value or "").strip().rstrip("s")
    if not raw:
        return None
    try:
        if "/" in raw:
            numerator, denominator = raw.split("/", 1)
            result = Fraction(int(numerator), int(denominator))
        else:
            result = Fraction(raw)
    except (ValueError, ZeroDivisionError):
        return None
    return result


def _seconds(value: object) -> Fraction | None:
    try:
        result = Fraction(str(value))
    except (ValueError, ZeroDivisionError):
        return None
    return result if result >= 0 else None


def _format_time(value: Fraction) -> str:
    return f"{value.numerator}s" if value.denominator == 1 else f"{value.numerator}/{value.denominator}s"


def _quantize(value: Fraction, frame_duration: Fraction) -> Fraction:
    frames = round(value / frame_duration)
    return max(0, frames) * frame_duration


def _decision_label(segment: dict[str, Any], group: dict[str, Any]) -> str:
    state = str(group.get("state", "") or "").lower()
    display = {"best": "Best", "keep": "Keep", "reject": "Reject"}.get(state, state.title())
    episode = segment.get("episode")
    segment_id = str(segment.get("script_segment", "") or "")
    parts = ["镜序", display]
    if isinstance(episode, int) and episode > 0:
        parts.append(f"E{episode}")
    if segment_id:
        parts.append(segment_id)
    return "｜".join(parts)


def _decision_targets(index: dict[str, Any], manifest: dict[str, Any]) -> list[dict[str, Any]]:
    clips = {
        str(item.get("clip_id", "")): item
        for item in index.get("clips", [])
        if isinstance(item, dict) and item.get("clip_id")
    }
    groups = {
        str(item.get("group_id", "")): item
        for item in index.get("groups", [])
        if isinstance(item, dict) and item.get("group_id")
    }
    targets: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str, str, str]] = set()
    for segment in manifest.get("segments", []):
        if not isinstance(segment, dict):
            continue
        for decision in segment.get("groups", []):
            if not isinstance(decision, dict) or decision.get("state") not in {"best", "keep", "reject"}:
                continue
            group_id = str(decision.get("group_id", "") or "")
            group = groups.get(group_id)
            if group is None:
                raise UnsafeFCPXMLExport(f"delivery decision references unknown group: {group_id}")
            members = [item for item in group.get("members", []) if isinstance(item, dict)]
            if not members:
                raise UnsafeFCPXMLExport(f"delivery group has no media members: {group_id}")
            for member in members:
                clip_id = str(member.get("clip_id", "") or "")
                clip = clips.get(clip_id)
                if clip is None:
                    raise UnsafeFCPXMLExport(f"delivery member is missing from material index clips: {clip_id}")
                asset_id = str(clip.get("source_asset_id", "") or "")
                if not asset_id:
                    raise UnsafeFCPXMLExport(f"delivery clip has no stable FCPXML source asset id: {clip_id}")
                start = _seconds(member.get("source_start", clip.get("source_start")))
                end = _seconds(member.get("source_end", clip.get("source_end")))
                duration = _seconds(member.get("duration", clip.get("duration")))
                if start is None:
                    raise UnsafeFCPXMLExport(f"delivery clip has no safe source start: {clip_id}")
                if end is not None and end > start:
                    duration = end - start
                if duration is None or duration <= 0:
                    raise UnsafeFCPXMLExport(f"delivery clip has no safe source duration: {clip_id}")
                label = _decision_label(segment, decision)
                key = (asset_id, str(start), str(duration), label, group_id)
                if key in seen:
                    continue
                seen.add(key)
                targets.append(
                    {
                        "asset_id": asset_id,
                        "clip_id": clip_id,
                        "group_id": group_id,
                        "start": start,
                        "duration": duration,
                        "label": label,
                        "state": decision.get("state"),
                        "decision_source": decision.get("decision_source", ""),
                    }
                )
    return targets


def _inject_selection_keywords(
    input_xml: Path,
    output_fcpxml: Path,
    index: dict[str, Any],
    manifest: dict[str, Any],
) -> dict[str, int]:
    targets = _decision_targets(index, manifest)
    if not targets:
        shutil.copyfile(input_xml, output_fcpxml)
        return {"keywords": 0, "ranges": 0}
    try:
        tree = ET.parse(input_xml)
    except (OSError, ET.ParseError) as error:
        raise UnsafeFCPXMLExport(f"cannot parse source FCPXML safely: {error}") from error
    root = tree.getroot()

    formats: dict[str, Fraction] = {}
    assets: dict[str, ET.Element] = {}
    for element in root.iter():
        kind = _tag(element)
        if kind == "format":
            format_id = str(element.get("id", "") or "")
            frame_duration = _parse_time(element.get("frameDuration"))
            if format_id and frame_duration is not None and frame_duration > 0:
                formats[format_id] = frame_duration
        elif kind == "asset":
            asset_id = str(element.get("id", "") or "")
            if asset_id:
                assets[asset_id] = element

    browser_clips: defaultdict[str, list[ET.Element]] = defaultdict(list)
    for event in root.iter():
        if _tag(event) != "event":
            continue
        for child in list(event):
            if _tag(child) == "asset-clip" and child.get("ref"):
                browser_clips[str(child.get("ref"))].append(child)

    keywords = 0
    for target in targets:
        asset_id = str(target["asset_id"])
        asset = assets.get(asset_id)
        clip_elements = browser_clips.get(asset_id, [])
        if asset is None or not clip_elements:
            raise UnsafeFCPXMLExport(
                f"cannot safely map delivery range to an Event Browser asset-clip: {asset_id}"
            )
        format_id = str(asset.get("format", "") or "")
        frame_duration = formats.get(format_id)
        if frame_duration is None:
            raise UnsafeFCPXMLExport(f"asset {asset_id} has no frameDuration-bearing format")
        start = _quantize(target["start"], frame_duration)
        duration = _quantize(target["duration"], frame_duration)
        if duration <= 0:
            raise UnsafeFCPXMLExport(f"delivery range quantized to zero frames: {target['clip_id']}")
        start_text = _format_time(start)
        duration_text = _format_time(duration)
        label = str(target["label"])
        for clip_element in clip_elements:
            duplicate = any(
                _tag(child) == "keyword"
                and child.get("value") == label
                and child.get("start") == start_text
                and child.get("duration") == duration_text
                for child in list(clip_element)
            )
            if duplicate:
                continue
            ET.SubElement(
                clip_element,
                "keyword",
                {"start": start_text, "duration": duration_text, "value": label},
            )
            keywords += 1

    output_fcpxml.parent.mkdir(parents=True, exist_ok=True)
    tree.write(output_fcpxml, encoding="utf-8", xml_declaration=True)
    try:
        ET.parse(output_fcpxml)
    except ET.ParseError as error:
        output_fcpxml.unlink(missing_ok=True)
        raise UnsafeFCPXMLExport(f"generated FCPXML failed XML validation: {error}") from error
    return {"keywords": keywords, "ranges": len(targets)}


def export(config: ProjectConfig, preserve_source: bool = True) -> dict[str, Any]:
    manifest = build_selection_manifest(config)
    manifest_path = config.output_dir / "selection_manifest.json"
    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)

    output_fcpxml = config.output_dir / "organized.fcpxml"
    report: dict[str, Any] = {
        "version": 2,
        "contract": "delivery_export_report.v1",
        "artifact_scope": "project_output",
        "organized_fcpxml": "organized.fcpxml",
        "selection_manifest": "selection_manifest.json",
        "selection_contract": manifest.get("contract", ""),
        "selection_manifest_version": manifest.get("version", 0),
        "selection_summary": manifest.get("summary", {}),
        "keywords_written": False,
        "keyword_count": 0,
        "decision_ranges_written": 0,
        "multicam_structure_modified": False,
        "device_paths_exposed": False,
    }
    if preserve_source and config.fcpxml:
        index = _load(config.output_dir / "material_index.json", {})
        if not isinstance(index, dict):
            raise UnsafeFCPXMLExport("material_index.json is not a valid object")
        injected = _inject_selection_keywords(config.fcpxml, output_fcpxml, index, manifest)
        report["keywords_written"] = injected["keywords"] > 0
        report["keyword_count"] = injected["keywords"]
        report["decision_ranges_written"] = injected["ranges"]
        if injected["keywords"]:
            report["warning"] = (
                "organized.fcpxml preserves the source project/multicam structure and adds only "
                f"{injected['keywords']} frame-aligned Event Browser decision keywords."
            )
        else:
            report["warning"] = (
                "organized.fcpxml is an unchanged copy because delivery.v1 contains no Best/Keep/Reject ranges to inject."
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
