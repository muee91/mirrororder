from __future__ import annotations

import hashlib
import json
import os
import platform
import tempfile
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

MEDIA_SUFFIXES = {".mp4", ".mov", ".m4v", ".mxf", ".mts", ".avi", ".mkv", ".wav", ".aif", ".aiff", ".m4a"}
_SAMPLE_BYTES = 1024 * 1024


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


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


def device_state_dir() -> Path:
    override = os.environ.get("MIRRORORDER_DEVICE_STATE_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    if platform.system() == "Darwin":
        return Path.home() / "Library" / "Application Support" / "MirrorOrder"
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", Path.home())) / "MirrorOrder"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "mirrororder"


def provisional_media_id(value: str) -> str:
    """Fallback identity used only when source bytes are unavailable."""
    name = Path(str(value or "")).name.casefold()
    return "MP_" + hashlib.sha1(name.encode("utf-8")).hexdigest()[:20] if name else ""


@lru_cache(maxsize=8192)
def _content_media_id(path_text: str, size: int, mtime_ns: int) -> str:
    path = Path(path_text)
    digest = hashlib.sha1()
    digest.update(str(size).encode("ascii"))
    with path.open("rb") as handle:
        digest.update(handle.read(_SAMPLE_BYTES))
        if size > _SAMPLE_BYTES:
            handle.seek(max(0, size - _SAMPLE_BYTES))
            digest.update(handle.read(_SAMPLE_BYTES))
    return "M_" + digest.hexdigest()[:24]


def media_id_for_path(path: str | Path) -> str:
    candidate = Path(path)
    try:
        stat = candidate.stat()
        if not candidate.is_file():
            return ""
        return _content_media_id(str(candidate.resolve()), int(stat.st_size), int(stat.st_mtime_ns))
    except OSError:
        return ""


def media_identity(path: str | Path) -> str:
    return media_id_for_path(path) or provisional_media_id(str(path))


def binding_key(item: dict[str, Any]) -> str:
    media_id = str(item.get("media_id", "") or "")
    if media_id:
        return media_id
    source = str(item.get("source_media_path", "") or item.get("media_path", "") or item.get("name", ""))
    return provisional_media_id(source)


def iter_project_media(index: dict[str, Any]) -> list[dict[str, Any]]:
    """Return one shared identity row per physical media identity."""
    rows: dict[str, dict[str, Any]] = {}
    for clip in index.get("clips", []):
        if not isinstance(clip, dict):
            continue
        key = binding_key(clip)
        if not key:
            continue
        source_path = str(clip.get("source_media_path", "") or clip.get("media_path", "") or "")
        existing = rows.setdefault(
            key,
            {
                "media_id": key,
                "verified": key.startswith("M_"),
                "name": Path(source_path).name or str(clip.get("name", "")),
                "source_media_path": source_path,
                "clip_ids": [],
            },
        )
        clip_id = str(clip.get("clip_id", "") or "")
        if clip_id and clip_id not in existing["clip_ids"]:
            existing["clip_ids"].append(clip_id)
    return sorted(rows.values(), key=lambda row: (str(row.get("name", "")).casefold(), str(row.get("media_id", ""))))


class DeviceMediaStore:
    """Per-device media roots and bindings stored outside the shared workspace."""

    def __init__(self, path: Path | None = None):
        self.path = path or (device_state_dir() / "media-bindings.json")
        self._ensure()

    def _default(self) -> dict[str, Any]:
        return {
            "version": 1,
            "device_id": str(uuid.uuid4()),
            "device_name": platform.node() or "MirrorOrder Device",
            "projects": {},
            "updated_at": _now(),
        }

    def _ensure(self) -> None:
        if self.path.exists():
            return
        _atomic_json(self.path, self._default())

    def load(self) -> dict[str, Any]:
        try:
            with self.path.open(encoding="utf-8") as handle:
                payload = json.load(handle)
            if isinstance(payload, dict):
                payload.setdefault("version", 1)
                payload.setdefault("device_id", str(uuid.uuid4()))
                payload.setdefault("device_name", platform.node() or "MirrorOrder Device")
                payload.setdefault("projects", {})
                return payload
        except (OSError, ValueError):
            pass
        return self._default()

    def _save(self, payload: dict[str, Any]) -> None:
        payload["updated_at"] = _now()
        _atomic_json(self.path, payload)

    def project_snapshot(self, project_id: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        root = payload if payload is not None else self.load()
        projects = root.get("projects", {}) if isinstance(root.get("projects", {}), dict) else {}
        raw = projects.get(project_id, {}) if isinstance(projects.get(project_id, {}), dict) else {}
        return {
            "roots": [str(value) for value in raw.get("roots", []) if str(value)],
            "bindings": dict(raw.get("bindings", {})) if isinstance(raw.get("bindings", {}), dict) else {},
            "updated_at": str(raw.get("updated_at", "") or ""),
        }

    @staticmethod
    def resolve_from_snapshot(project: dict[str, Any], item: dict[str, Any]) -> str:
        key = binding_key(item)
        bound = str(project.get("bindings", {}).get(key, "") or "")
        if bound and Path(bound).is_file():
            return bound
        original = str(item.get("source_media_path", "") or item.get("media_path", "") or "")
        if original and Path(original).is_file():
            return original
        return ""

    def resolve(self, project_id: str, item: dict[str, Any]) -> str:
        return self.resolve_from_snapshot(self.project_snapshot(project_id), item)

    def summary(self, project_id: str, index: dict[str, Any]) -> dict[str, Any]:
        payload = self.load()
        project = self.project_snapshot(project_id, payload)
        inventory = iter_project_media(index)
        resolved = []
        missing = []
        for item in inventory:
            path = self.resolve_from_snapshot(project, item)
            row = {**item, "resolved_path": path, "local_exists": bool(path)}
            (resolved if path else missing).append(row)
        return {
            "version": 1,
            "device_id": payload.get("device_id", ""),
            "device_name": payload.get("device_name", ""),
            "state_path": str(self.path),
            "roots": project["roots"],
            "total": len(inventory),
            "resolved": len(resolved),
            "missing": len(missing),
            "items": resolved + missing,
        }

    def scan(self, project_id: str, index: dict[str, Any], roots: Iterable[str]) -> dict[str, Any]:
        payload = self.load()
        projects = payload.setdefault("projects", {})
        project = projects.setdefault(project_id, {"roots": [], "bindings": {}, "updated_at": ""})
        stored_roots = [str(value) for value in project.get("roots", []) if str(value)]
        for raw_root in roots:
            root = str(Path(raw_root).expanduser())
            if root and root not in stored_roots:
                stored_roots.append(root)
        project["roots"] = stored_roots

        inventory = iter_project_media(index)
        expected_by_id = {str(item["media_id"]): item for item in inventory if str(item.get("media_id", "")).startswith("M_")}
        provisional_by_name: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
        for item in inventory:
            if not str(item.get("media_id", "")).startswith("M_"):
                provisional_by_name[str(item.get("name", "")).casefold()].append(item)

        files: list[Path] = []
        for root_text in stored_roots:
            root = Path(root_text)
            if not root.exists() or not root.is_dir():
                continue
            files.extend(
                path
                for path in root.rglob("*")
                if path.is_file() and path.suffix.lower() in MEDIA_SUFFIXES and not path.name.startswith("._")
            )

        bindings = dict(project.get("bindings", {}))
        matched_verified = 0
        matched_provisional = 0
        for path in files:
            rows = provisional_by_name.get(path.name.casefold(), [])
            if len(rows) == 1:
                bindings[str(rows[0]["media_id"])] = str(path)
                matched_provisional += 1
            media_id = media_id_for_path(path)
            if media_id and media_id in expected_by_id:
                bindings[media_id] = str(path)
                matched_verified += 1

        project["bindings"] = bindings
        project["updated_at"] = _now()
        self._save(payload)
        summary = self.summary(project_id, index)
        summary["scan"] = {
            "files_seen": len(files),
            "verified_matches": matched_verified,
            "provisional_name_matches": matched_provisional,
        }
        return summary

    def forget_missing(self, project_id: str) -> None:
        payload = self.load()
        project = payload.setdefault("projects", {}).setdefault(project_id, {"roots": [], "bindings": {}})
        bindings = project.setdefault("bindings", {})
        project["bindings"] = {key: value for key, value in bindings.items() if Path(str(value)).is_file()}
        self._save(payload)
