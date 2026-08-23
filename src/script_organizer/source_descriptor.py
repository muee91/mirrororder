from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from .config import ProjectConfig


def _configured_path(config: ProjectConfig, section: str, key: str, fallback: object) -> tuple[str, str]:
    raw_section = config.extra.get(section, {}) if isinstance(config.extra, dict) else {}
    raw_value = raw_section.get(key) if isinstance(raw_section, dict) else None
    fallback_text = str(raw_value if raw_value not in {None, ""} else fallback or "").strip()
    if not fallback_text:
        return "", ""
    raw_path = Path(fallback_text).expanduser()
    candidate = raw_path if raw_path.is_absolute() else config.project_dir / raw_path
    relative_path = ""
    try:
        relative = candidate.resolve().relative_to(config.project_dir.resolve())
        relative_path = "./" + relative.as_posix()
    except (OSError, ValueError):
        pass
    try:
        digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
    except OSError:
        digest = ""
    return relative_path, digest


def shared_source_descriptor(config: ProjectConfig) -> dict[str, Any]:
    """Portable source facts suitable for shared derived project artifacts."""
    fcpxml, fcpxml_sha256 = _configured_path(config, "input", "fcpxml", config.fcpxml)
    script, script_sha256 = _configured_path(config, "input", "script", config.script)
    return {
        "kind": config.input_kind,
        "fcpxml": fcpxml,
        "fcpxml_sha256": fcpxml_sha256,
        "script": script,
        "script_sha256": script_sha256,
        # Media-directory roots are device-local resolver state. Never serialize
        # them into material_index.json, even while this Host is analyzing.
        "media_root": "",
        "media_binding": "device-local" if config.is_media_directory else "not-required",
    }


def redact_device_media_paths(index: dict[str, Any]) -> None:
    """Remove Host-only paths before a media-directory index becomes shared."""
    for clip in index.get("clips", []):
        if not isinstance(clip, dict):
            continue
        clip["media_path"] = ""
        clip["exists"] = False
        clip.pop("source_media_path", None)
        clip.pop("resolved_media_path", None)
    for group in index.get("groups", []):
        if not isinstance(group, dict):
            continue
        for member in group.get("members", []):
            if not isinstance(member, dict):
                continue
            member["media_path"] = ""
            member["exists"] = False
            member.pop("source_media_path", None)
            member.pop("resolved_media_path", None)
