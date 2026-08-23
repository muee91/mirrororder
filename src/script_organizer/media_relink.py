from __future__ import annotations

import json
import os
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import quote, unquote, urlparse


def _atomic_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _path_from_url(value: str, document_dir: Path) -> Path | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    parsed = urlparse(raw)
    if parsed.scheme and parsed.scheme != "file":
        return None
    if parsed.scheme == "file":
        return Path(unquote(parsed.path))
    return document_dir / unquote(parsed.path)


def _physical_source_path(value: str, document_dir: Path, scan_root: Path) -> Path | None:
    candidate = _path_from_url(value, document_dir)
    if candidate is None:
        return None
    if not candidate.is_absolute():
        candidate = scan_root / candidate
    # realpath is intentional: media-directory sync may scan a temporary tree of
    # symlinked camera folders. Exported XML must point to the original media,
    # never .multicam-sync/media-layout.
    return Path(os.path.realpath(str(candidate)))


def _relative_to_source(path: Path, source_root: Path) -> Path | None:
    try:
        return path.relative_to(source_root.resolve())
    except (OSError, ValueError):
        try:
            return path.resolve().relative_to(source_root.resolve())
        except (OSError, ValueError):
            return None


def _portable_url(root_name: str, relative_path: Path) -> str:
    portable = PurePosixPath(root_name) / PurePosixPath(relative_path.as_posix())
    return quote("./" + portable.as_posix(), safe="/:@-._~")


def _local_url(path: Path) -> str:
    return path.resolve().as_uri()


def _write_xml(tree: ET.ElementTree, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=target.parent)
    os.close(fd)
    temp_path = Path(temporary)
    try:
        try:
            ET.indent(tree, space="  ")
        except AttributeError:
            pass
        tree.write(temp_path, encoding="utf-8", xml_declaration=True)
        os.replace(temp_path, target)
    finally:
        temp_path.unlink(missing_ok=True)


def rewrite_fcpxml_media(
    source: str | Path,
    *,
    scan_root: str | Path,
    source_root: str | Path,
    output: str | Path | None = None,
    portable: bool = False,
    portable_root_name: str | None = None,
) -> dict[str, Any]:
    """Rewrite FCPXML media refs without changing timeline semantics.

    Local mode follows staging symlinks and writes canonical file:// URLs to the
    original media. Portable mode writes relative URLs rooted at one sibling
    media directory, e.g. ./Footage/day1/A1/C0001.mov. Apple documents relative
    media URLs as being resolved from the FCPXML document location.
    """

    source_path = Path(source)
    target = Path(output) if output is not None else source_path
    scan = Path(scan_root).resolve()
    media_root = Path(source_root).resolve()
    root_name = str(portable_root_name or media_root.name or "Media").strip() or "Media"
    tree = ET.parse(source_path)
    document_dir = source_path.parent
    rows: list[dict[str, Any]] = []

    for element in tree.getroot().iter():
        tag = element.tag.rsplit("}", 1)[-1]
        attribute = "src" if tag in {"asset", "media-rep"} else ("url" if tag == "locator" else "")
        if not attribute or attribute not in element.attrib:
            continue
        original = element.attrib[attribute]
        physical = _physical_source_path(original, document_dir, scan)
        if physical is None:
            continue
        relative = _relative_to_source(physical, media_root)
        if relative is None:
            # Ignore non-media locators/effects that do not live under the selected
            # source root. The sync engine's original-media refs are expected to
            # resolve under source_root and are included in the manifest below.
            continue
        rewritten = _portable_url(root_name, relative) if portable else _local_url(physical)
        element.set(attribute, rewritten)
        try:
            size = physical.stat().st_size if physical.is_file() else 0
        except OSError:
            size = 0
        rows.append(
            {
                "relative_path": relative.as_posix(),
                "filename": physical.name,
                "size_bytes": int(size),
                "reference": rewritten,
            }
        )

    _write_xml(tree, target)
    unique = {row["relative_path"]: row for row in rows}
    return {
        "path": str(target),
        "portable": bool(portable),
        "media_root_name": root_name,
        "rewritten": len(rows),
        "files": [unique[key] for key in sorted(unique)],
    }


def rewrite_premiere_media(
    source: str | Path,
    *,
    scan_root: str | Path,
    source_root: str | Path,
    output: str | Path | None = None,
) -> dict[str, Any]:
    """Canonicalize FCP7/Premiere pathurl values away from sync staging paths."""

    source_path = Path(source)
    target = Path(output) if output is not None else source_path
    scan = Path(scan_root).resolve()
    media_root = Path(source_root).resolve()
    tree = ET.parse(source_path)
    document_dir = source_path.parent
    rows: list[dict[str, Any]] = []
    for element in tree.getroot().iter("pathurl"):
        original = str(element.text or "")
        physical = _physical_source_path(original, document_dir, scan)
        if physical is None:
            continue
        relative = _relative_to_source(physical, media_root)
        if relative is None:
            continue
        uri = _local_url(physical)
        element.text = "file://localhost" + uri[len("file://"):]
        rows.append({"relative_path": relative.as_posix(), "filename": physical.name})
    _write_xml(tree, target)
    return {"path": str(target), "rewritten": len(rows), "files": rows}


def _export_name(report: dict[str, Any] | None) -> str:
    raw = str((report or {}).get("path", "") or "")
    return Path(raw).name if raw else ""


def write_relink_manifest(
    path: str | Path,
    *,
    source_root: str | Path,
    local_fcpxml: dict[str, Any],
    portable_fcpxml: dict[str, Any],
    capcut_fcpxml: dict[str, Any] | None = None,
    portable_capcut_fcpxml: dict[str, Any] | None = None,
    premiere_xml: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Write a device-neutral manifest; never persist the old machine root."""

    media_root = Path(source_root).resolve()
    files: dict[str, dict[str, Any]] = {}
    for report in (local_fcpxml, portable_fcpxml, capcut_fcpxml or {}, portable_capcut_fcpxml or {}, premiere_xml or {}):
        for row in report.get("files", []) if isinstance(report, dict) else []:
            relative = str(row.get("relative_path", "") or "")
            if relative:
                files.setdefault(
                    relative,
                    {
                        "relative_path": relative,
                        "filename": str(row.get("filename", "") or Path(relative).name),
                        "size_bytes": int(row.get("size_bytes", 0) or 0),
                    },
                )
    payload = {
        "version": 1,
        "media_root_name": media_root.name,
        "portable_layout": {
            "rule": "place the portable XML beside the media-root folder, or materialize it for a new root in MirrorOrder",
            "media_root": "./" + media_root.name,
        },
        "files": [files[key] for key in sorted(files)],
        "exports": {
            "fcpxml": _export_name(local_fcpxml),
            "fcpxml_portable": _export_name(portable_fcpxml),
            "capcut_fcpxml": _export_name(capcut_fcpxml),
            "capcut_fcpxml_portable": _export_name(portable_capcut_fcpxml),
            "premiere_xml": _export_name(premiere_xml),
        },
    }
    _atomic_json(Path(path), payload)
    return payload


def materialize_portable_fcpxml(
    portable_xml: str | Path,
    manifest: str | Path,
    new_media_root: str | Path,
    output: str | Path,
) -> dict[str, Any]:
    """Bind one portable FCPXML to a new machine's selected media root."""

    payload = json.loads(Path(manifest).read_text(encoding="utf-8"))
    root_name = str(payload.get("media_root_name", "") or "")
    new_root = Path(new_media_root).expanduser().resolve()
    tree = ET.parse(portable_xml)
    changed = 0
    missing: list[str] = []
    for element in tree.getroot().iter():
        tag = element.tag.rsplit("}", 1)[-1]
        attribute = "src" if tag in {"asset", "media-rep"} else ("url" if tag == "locator" else "")
        if not attribute or attribute not in element.attrib:
            continue
        raw = unquote(element.attrib[attribute])
        prefix = "./" + root_name + "/"
        if not raw.startswith(prefix):
            continue
        relative = raw[len(prefix):]
        target = new_root / Path(relative)
        if not target.is_file():
            missing.append(relative)
            continue
        element.set(attribute, _local_url(target))
        changed += 1
    target_path = Path(output)
    _write_xml(tree, target_path)
    return {
        "path": str(target_path),
        "rewritten": changed,
        "missing": sorted(set(missing)),
        "complete": not missing,
    }


__all__ = [
    "rewrite_fcpxml_media",
    "rewrite_premiere_media",
    "write_relink_manifest",
    "materialize_portable_fcpxml",
]
