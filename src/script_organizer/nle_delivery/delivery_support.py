"""Shared request validation and FCPXML time/asset helpers for the NLE delivery adapters."""

from __future__ import annotations

import json
import os
import tempfile
import xml.etree.ElementTree as ET
from fractions import Fraction
from pathlib import Path
from typing import Any

from ..config import ProjectConfig


TIMELINE_DELIVERY_CONTRACT = "timeline_delivery_request.v1"
TIMELINE_FCPXML_NAME = "timeline_organized.fcpxml"
TIMELINE_REPORT_NAME = "timeline_delivery_report.json"


class UnsafeTimelineDelivery(RuntimeError):
    """Raised when a Timeline snapshot cannot be represented without losing edit semantics."""


def _load_json(path: Path, fallback: object) -> object:
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return fallback


def _tag(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def _parse_time(value: object) -> Fraction | None:
    if value is None:
        return None
    raw = str(value).strip().rstrip("s")
    if not raw:
        return None
    try:
        if "/" in raw:
            numerator, denominator = raw.split("/", 1)
            return Fraction(int(numerator), int(denominator))
        return Fraction(raw)
    except (ValueError, ZeroDivisionError):
        return None


def _format_time(value: Fraction) -> str:
    return f"{value.numerator}s" if value.denominator == 1 else f"{value.numerator}/{value.denominator}s"


def _non_negative_int(value: object, label: str) -> int:
    if isinstance(value, bool):
        raise UnsafeTimelineDelivery(f"{label} must be a non-negative integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise UnsafeTimelineDelivery(f"{label} must be a non-negative integer") from error
    if parsed < 0 or str(parsed) != str(value).strip():
        raise UnsafeTimelineDelivery(f"{label} must be a non-negative integer")
    return parsed


def _object(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise UnsafeTimelineDelivery(f"{label} must be an object")
    return value


def _authority(request: dict[str, Any]) -> dict[str, Any]:
    authority = _object(request.get("authority"), "authority")
    generation = str(authority.get("generation", "") or "").strip()
    if not generation:
        raise UnsafeTimelineDelivery("authority.generation is required")
    revision = _non_negative_int(authority.get("revision"), "authority.revision")
    return {"generation": generation, "revision": revision}


def _material_clip_map(config: ProjectConfig) -> dict[str, dict[str, Any]]:
    payload = _load_json(config.output_dir / "material_index.json", {})
    if not isinstance(payload, dict):
        raise UnsafeTimelineDelivery("material_index.json is not a valid object")
    result: dict[str, dict[str, Any]] = {}
    for raw in payload.get("clips", []):
        if not isinstance(raw, dict):
            continue
        clip_id = str(raw.get("clip_id", "") or "")
        asset_id = str(raw.get("source_asset_id", "") or "")
        if clip_id and asset_id:
            result[clip_id] = raw
    return result


def _source_assets(root: ET.Element) -> tuple[ET.Element, dict[str, ET.Element], dict[str, Fraction]]:
    resources = next((item for item in root if _tag(item) == "resources"), None)
    if resources is None:
        raise UnsafeTimelineDelivery("source FCPXML has no resources")
    assets: dict[str, ET.Element] = {}
    formats: dict[str, Fraction] = {}
    for item in resources:
        kind = _tag(item)
        item_id = str(item.get("id", "") or "")
        if kind == "asset" and item_id:
            assets[item_id] = item
        elif kind == "format" and item_id:
            duration = _parse_time(item.get("frameDuration"))
            if duration is not None and duration > 0:
                formats[item_id] = duration
    return resources, assets, formats


def _source_project_sequence(root: ET.Element) -> ET.Element | None:
    """Return the same first user Project sequence class used by the FCPXML reader."""
    for project in root.iter():
        if _tag(project) != "project":
            continue
        for element in project.iter():
            if _tag(element) == "sequence":
                return element
    return None


def _sequence_attributes(
    root: ET.Element,
    formats: dict[str, Fraction],
    frame_duration: Fraction,
) -> dict[str, str]:
    source_sequence = _source_project_sequence(root)
    if source_sequence is not None:
        source_format = str(source_sequence.get("format", "") or "")
        if source_format:
            source_duration = formats.get(source_format)
            if source_duration is None:
                raise UnsafeTimelineDelivery(f"source Project sequence format has no frameDuration: {source_format}")
            if source_duration != frame_duration:
                raise UnsafeTimelineDelivery(
                    "Timeline frame rate does not match the analyzed source Project sequence format"
                )
            attrs = {
                key: value
                for key, value in source_sequence.attrib.items()
                if key in {"tcFormat", "audioLayout", "audioRate"} and str(value).strip()
            }
            attrs["format"] = source_format
            attrs["tcStart"] = "0s"
            return attrs

    matches = [format_id for format_id, duration in formats.items() if duration == frame_duration]
    if not matches:
        raise UnsafeTimelineDelivery(
            f"source FCPXML has no format matching Timeline frame duration {_format_time(frame_duration)}"
        )
    if len(matches) != 1:
        raise UnsafeTimelineDelivery(
            "source FCPXML has multiple matching formats but no unambiguous Project sequence format"
        )
    return {"format": matches[0], "tcStart": "0s"}


def _asset_bounds(asset: ET.Element) -> tuple[Fraction, Fraction | None]:
    start = _parse_time(asset.get("start")) or Fraction(0)
    duration = _parse_time(asset.get("duration"))
    end = start + duration if duration is not None and duration >= 0 else None
    return start, end


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _write_xml_atomic(path: Path, tree: ET.ElementTree) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    os.close(fd)
    try:
        tree.write(temporary, encoding="utf-8", xml_declaration=True)
        ET.parse(temporary)
        os.replace(temporary, path)
    except Exception:
        Path(temporary).unlink(missing_ok=True)
        raise
