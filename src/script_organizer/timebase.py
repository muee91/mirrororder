from __future__ import annotations

import xml.etree.ElementTree as ET
from fractions import Fraction
from pathlib import Path
from typing import Any, BinaryIO
from xml.parsers import expat


def first_frame_at_or_after(seconds: float, numerator: int, denominator: int) -> int:
    nearest = round(seconds * numerator / denominator)
    return nearest + int(nearest * denominator / numerator < seconds)


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


def _validate_xml_declaration(stream: BinaryIO) -> None:
    # Expat accepts an empty version token; the Rust timebase contract rejects
    # it. Inspect only the prolog with the parser, preserving XML quoting,
    # whitespace and encoding handling instead of matching raw file text.
    parser = expat.ParserCreate()
    root_seen = False

    def declaration(version: str, _encoding: str | None, _standalone: int) -> None:
        if not version:
            raise ET.ParseError("Empty XML version")

    def root(_name: str, _attributes: dict[str, str]) -> None:
        nonlocal root_seen
        root_seen = True

    parser.XmlDeclHandler = declaration
    parser.StartElementHandler = root
    while not root_seen:
        chunk = stream.read(4096)
        parser.Parse(chunk, not chunk)
        if not chunk:
            break
    stream.seek(0)


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
        with source.open("rb") as stream:
            _validate_xml_declaration(stream)
            root = ET.parse(stream).getroot()
    except (OSError, ET.ParseError, expat.ExpatError):
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
