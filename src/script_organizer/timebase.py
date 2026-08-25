from __future__ import annotations

import xml.etree.ElementTree as ET
from fractions import Fraction
from pathlib import Path
from typing import Any


def _tag(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def _time(value: object) -> Fraction | None:
    raw = str(value or "").strip().rstrip("s")
    if not raw:
        return None
    try:
        if "/" in raw:
            left, right = raw.split("/", 1)
            value = Fraction(int(left), int(right))
        else:
            value = Fraction(raw)
    except (ValueError, ZeroDivisionError):
        return None
    return value if value > 0 else None


def fcpxml_project_timebase(path: str | Path) -> dict[str, Any]:
    """Return the active project sequence timebase without guessing.

    FCPXML stores frame duration, not frames-per-second. The Timeline Core uses a
    rational frame-rate, so invert the exact Fraction and keep 24000/1001-style
    rates intact. If the project sequence or referenced format cannot be proven,
    return unknown rather than silently assuming 24fps.
    """
    source = Path(path)
    if not source.is_file():
        return {"status": "unknown", "source": "fcpxml_sequence", "reason": "source_missing"}
    try:
        root = ET.parse(source).getroot()
    except (OSError, ET.ParseError):
        return {"status": "unknown", "source": "fcpxml_sequence", "reason": "parse_failed"}

    formats: dict[str, Fraction] = {}
    for element in root.iter():
        if _tag(element) != "format":
            continue
        format_id = str(element.get("id", "") or "")
        duration = _time(element.get("frameDuration"))
        if format_id and duration is not None:
            formats[format_id] = duration

    for project in root.iter():
        if _tag(project) != "project":
            continue
        sequence = next((item for item in project.iter() if _tag(item) == "sequence"), None)
        if sequence is None:
            continue
        format_id = str(sequence.get("format", "") or "")
        frame_duration = formats.get(format_id)
        if frame_duration is None:
            return {
                "status": "unknown",
                "source": "fcpxml_sequence",
                "reason": "sequence_format_missing",
                "format_id": format_id,
            }
        fps = Fraction(frame_duration.denominator, frame_duration.numerator)
        return {
            "status": "confirmed",
            "source": "fcpxml_sequence",
            "format_id": format_id,
            "frame_duration": f"{frame_duration.numerator}/{frame_duration.denominator}s",
            "numerator": fps.numerator,
            "denominator": fps.denominator,
        }
    return {"status": "unknown", "source": "fcpxml_sequence", "reason": "project_sequence_missing"}


def project_timebase(config: Any) -> dict[str, Any]:
    """Resolve a project editing timebase, failing closed when it is not proven."""
    source = getattr(config, "fcpxml", None)
    if source:
        return fcpxml_project_timebase(source)
    return {
        "status": "unknown",
        "source": "explicit_required",
        "reason": "media_directory_has_no_authoritative_sequence_timebase",
    }
