from __future__ import annotations

import hashlib
import json
import os
import platform
import tempfile
import uuid
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from threading import RLock
from typing import Any, Callable, Iterable

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows fallback
    fcntl = None

MEDIA_SUFFIXES = {".mp4", ".mov", ".m4v", ".mxf", ".mts", ".avi", ".mkv", ".wav", ".aif", ".aiff", ".m4a"}
_SAMPLE_BYTES = 1024 * 1024


class MediaScanCancelled(RuntimeError):
    """Raised before a device-local media scan commits any new binding state."""


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

    _thread_lock = RLock()

    def __init__(self, path: Path | None = None):
        self.path = path or (device_state_dir() / "media-bindings.json")
        self._ensure()

    @contextmanager
    def _write_lock(self):
        """Serialize media-binding read-modify-write within and across processes.

        后台扫描（分钟级枚举+哈希）与 UI 确认/加根（HTTP 线程）并发改写同一份
        media-bindings.json；无锁整文件回写会把并发写入无声丢失。
        """
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self.path.with_name(self.path.name + ".lock")
        with self._thread_lock, lock_path.open("a+", encoding="utf-8") as handle:
            if fcntl is not None:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                if fcntl is not None:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _default(self) -> dict[str, Any]:
        return {
            "version": 3,
            "device_id": str(uuid.uuid4()),
            "device_name": platform.node() or "MirrorOrder Device",
            "workspaces": {},
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
                payload["version"] = max(3, int(payload.get("version", 1) or 1))
                payload.setdefault("device_id", str(uuid.uuid4()))
                payload.setdefault("device_name", platform.node() or "MirrorOrder Device")
                payload.setdefault("workspaces", {})
                return payload
        except (OSError, ValueError):
            pass
        return self._default()

    def _save(self, payload: dict[str, Any]) -> None:
        payload["version"] = max(3, int(payload.get("version", 3) or 3))
        payload["updated_at"] = _now()
        _atomic_json(self.path, payload)

    @staticmethod
    def _empty_project() -> dict[str, Any]:
        return {
            "roots": [],
            "bindings": {},
            "candidates": {},
            "confirmed_provisional": {},
            "updated_at": "",
        }

    @staticmethod
    def _check_cancelled(cancelled: Callable[[], bool] | None) -> None:
        if cancelled and cancelled():
            raise MediaScanCancelled("素材扫描已取消")

    @classmethod
    def _media_files(
        cls,
        roots: Iterable[str],
        cancelled: Callable[[], bool] | None = None,
    ) -> list[Path]:
        files: list[Path] = []
        seen: set[str] = set()
        for root_text in roots:
            cls._check_cancelled(cancelled)
            root = Path(root_text).expanduser()
            if not root.exists() or not root.is_dir():
                continue
            try:
                candidates = root.rglob("*")
                for path in candidates:
                    cls._check_cancelled(cancelled)
                    if not path.is_file() or path.suffix.lower() not in MEDIA_SUFFIXES or path.name.startswith("._"):
                        continue
                    try:
                        key = str(path.resolve())
                    except OSError:
                        key = str(path)
                    if key in seen:
                        continue
                    seen.add(key)
                    files.append(path)
            except OSError:
                continue
        return files

    def project_snapshot(
        self,
        workspace_id: str,
        project_id: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        root = payload if payload is not None else self.load()
        workspaces = root.get("workspaces", {}) if isinstance(root.get("workspaces", {}), dict) else {}
        workspace = workspaces.get(workspace_id, {}) if isinstance(workspaces.get(workspace_id, {}), dict) else {}
        projects = workspace.get("projects", {}) if isinstance(workspace.get("projects", {}), dict) else {}
        raw = projects.get(project_id, {}) if isinstance(projects.get(project_id, {}), dict) else {}
        if not raw:
            legacy_projects = root.get("projects", {})
            legacy = legacy_projects.pop(project_id, None) if isinstance(legacy_projects, dict) else None
            if isinstance(legacy, dict):
                workspace = root.setdefault("workspaces", {}).setdefault(workspace_id, {"projects": {}})
                projects = workspace.setdefault("projects", {})
                projects[project_id] = legacy
                raw = legacy
                if payload is None:
                    self._save(root)
        return {
            "roots": [str(value) for value in raw.get("roots", []) if str(value)],
            "bindings": dict(raw.get("bindings", {})) if isinstance(raw.get("bindings", {}), dict) else {},
            "candidates": dict(raw.get("candidates", {})) if isinstance(raw.get("candidates", {}), dict) else {},
            "confirmed_provisional": (
                dict(raw.get("confirmed_provisional", {}))
                if isinstance(raw.get("confirmed_provisional", {}), dict)
                else {}
            ),
            "updated_at": str(raw.get("updated_at", "") or ""),
        }

    @staticmethod
    def resolve_from_snapshot(project: dict[str, Any], item: dict[str, Any]) -> str:
        key = binding_key(item)
        bindings = project.get("bindings", {}) if isinstance(project.get("bindings", {}), dict) else {}
        bound = str(bindings.get(key, "") or "")
        if key.startswith("MP_"):
            confirmed = (
                project.get("confirmed_provisional", {})
                if isinstance(project.get("confirmed_provisional", {}), dict)
                else {}
            )
            if bound and str(confirmed.get(key, "") or "") == bound and Path(bound).is_file():
                return bound
            # A provisional identity is filename-derived. Even the original path
            # is not safe evidence of content identity after files move or are
            # replaced, so it must be explicitly confirmed on this device.
            return ""
        if key.startswith("M_"):
            if bound and Path(bound).is_file() and media_id_for_path(bound) == key:
                return bound
            original = str(item.get("source_media_path", "") or item.get("media_path", "") or "")
            if original and Path(original).is_file() and media_id_for_path(original) == key:
                return original
            return ""
        original = str(item.get("source_media_path", "") or item.get("media_path", "") or "")
        if bound and Path(bound).is_file():
            return bound
        if original and Path(original).is_file():
            return original
        return ""

    def resolve(self, workspace_id: str, project_id: str, item: dict[str, Any]) -> str:
        return self.resolve_from_snapshot(self.project_snapshot(workspace_id, project_id), item)

    def summary(self, workspace_id: str, project_id: str, index: dict[str, Any]) -> dict[str, Any]:
        project = self.project_snapshot(workspace_id, project_id)
        payload = self.load()
        inventory = iter_project_media(index)
        resolved = []
        missing = []
        candidates = project.get("candidates", {}) if isinstance(project.get("candidates", {}), dict) else {}
        for item in inventory:
            path = self.resolve_from_snapshot(project, item)
            candidate = str(candidates.get(str(item.get("media_id", "")), "") or "")
            if candidate and not Path(candidate).is_file():
                candidate = ""
            row = {
                **item,
                "resolved_path": path,
                "local_exists": bool(path),
                "candidate_path": candidate,
                "needs_confirmation": bool(candidate and not item.get("verified", False) and not path),
            }
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
            "pending_analysis": bool(project["roots"] and not inventory),
        }

    def scan(
        self,
        workspace_id: str,
        project_id: str,
        index: dict[str, Any],
        roots: Iterable[str],
        *,
        media_rows: list[tuple[str, str]] | None = None,
        replace: bool = False,
        cancelled: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        """Scan candidate roots and atomically commit bindings only on success.

        Replacement reconnect is intentionally transactional: existing roots and
        bindings stay untouched while candidate media are enumerated and hashed.
        A wrong folder, cancellation, or scan error therefore cannot destroy the
        last known-good device-local binding state.
        """
        payload = self.load()
        workspaces = payload.setdefault("workspaces", {})
        workspace = workspaces.setdefault(workspace_id, {"projects": {}})
        projects = workspace.setdefault("projects", {})
        current = projects.get(project_id)
        if not isinstance(current, dict):
            legacy_projects = payload.get("projects", {})
            legacy = legacy_projects.get(project_id) if isinstance(legacy_projects, dict) else None
            current = legacy if isinstance(legacy, dict) else self._empty_project()

        existing_roots = [str(value) for value in current.get("roots", []) if str(value)]
        selected_roots: list[str] = [] if replace else list(existing_roots)
        for raw_root in roots:
            root = str(Path(raw_root).expanduser().resolve())
            if root and root not in selected_roots:
                selected_roots.append(root)
        if not selected_roots:
            raise ValueError("至少选择一个媒体目录")

        inventory = iter_project_media(index)
        expected_by_id = {
            str(item["media_id"]): item
            for item in inventory
            if str(item.get("media_id", "")).startswith("M_")
        }
        provisional_by_name: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
        for item in inventory:
            if not str(item.get("media_id", "")).startswith("M_"):
                provisional_by_name[str(item.get("name", "")).casefold()].append(item)

        self._check_cancelled(cancelled)
        files = self._media_files(selected_roots, cancelled)
        files_by_name: defaultdict[str, list[Path]] = defaultdict(list)
        for path in files:
            self._check_cancelled(cancelled)
            files_by_name[path.name.casefold()].append(path)

        existing_bindings = {} if replace else dict(current.get("bindings", {}))
        existing_confirmed = {} if replace else dict(current.get("confirmed_provisional", {}))
        # Version-2 stores could contain provisional bindings created solely by
        # a filename match. Ignore and remove every unconfirmed MP_ binding so
        # upgrading immediately closes the unsafe path instead of waiting for a
        # manual re-scan.
        bindings = {
            key: value
            for key, value in existing_bindings.items()
            if not str(key).startswith("MP_") or str(existing_confirmed.get(str(key), "") or "") == str(value)
        }
        candidates: dict[str, str] = {}
        matched_verified = 0
        provisional_candidates = 0

        for name, rows in provisional_by_name.items():
            self._check_cancelled(cancelled)
            paths = files_by_name.get(name, [])
            if len(rows) == 1 and len(paths) == 1:
                media_id = str(rows[0]["media_id"])
                path = str(paths[0])
                candidates[media_id] = path
                provisional_candidates += 1

        for path in files:
            self._check_cancelled(cancelled)
            media_id = media_id_for_path(path)
            if media_id and media_rows is not None:
                media_rows.append((media_id, str(path)))
            if media_id and media_id in expected_by_id:
                bindings[media_id] = str(path)
                matched_verified += 1

        self._check_cancelled(cancelled)
        next_project = {
            **current,
            "roots": selected_roots,
            "bindings": bindings,
            "candidates": candidates,
            "confirmed_provisional": {
                key: value
                for key, value in existing_confirmed.items()
                if str(key).startswith("MP_") and Path(str(value)).is_file()
            },
            "updated_at": _now(),
        }
        # 提交在锁内进行，并与最新状态合并：扫描期间发生的人工确认/加根
        # 不能被这份过期快照覆盖。bindings 按 key 并集（扫描到的同 key 经
        # 内容哈希重验，等价覆盖）；replace 语义下扫描结果即全部。
        with self._write_lock():
            fresh = self.load()
            fresh_workspaces = fresh.setdefault("workspaces", {})
            fresh_workspace = fresh_workspaces.setdefault(workspace_id, {"projects": {}})
            fresh_projects = fresh_workspace.setdefault("projects", {})
            fresh_current = fresh_projects.get(project_id)
            fresh_current = fresh_current if isinstance(fresh_current, dict) else self._empty_project()
            if replace:
                merged_bindings = dict(next_project["bindings"])
                merged_confirmed = dict(next_project["confirmed_provisional"])
            else:
                fresh_bindings = fresh_current.get("bindings")
                fresh_bindings = fresh_bindings if isinstance(fresh_bindings, dict) else {}
                fresh_confirmed = fresh_current.get("confirmed_provisional")
                fresh_confirmed = fresh_confirmed if isinstance(fresh_confirmed, dict) else {}
                merged_bindings = dict(next_project["bindings"])
                for key, value in fresh_bindings.items():
                    if key in merged_bindings:
                        continue  # 扫描已重验覆盖（同 key 内容哈希等价）
                    if str(key).startswith("MP_"):
                        # 与 scan 的过滤规则一致：未确认的 MP_ 绑定不可信，
                        # 只保留已人工确认且文件仍存在的。
                        if fresh_confirmed.get(key) == value and Path(str(value)).is_file():
                            merged_bindings[key] = value
                        continue
                    # 扫描范围外的绑定保留：resolve 时的内容哈希校验仍兜底。
                    merged_bindings[key] = value
                merged_confirmed = {
                    **fresh_confirmed,
                    **next_project["confirmed_provisional"],
                }
            next_project["bindings"] = merged_bindings
            next_project["confirmed_provisional"] = merged_confirmed
            fresh_projects[project_id] = next_project
            legacy_projects = fresh.get("projects", {})
            if isinstance(legacy_projects, dict):
                legacy_projects.pop(project_id, None)
            self._save(fresh)
        summary = self.summary(workspace_id, project_id, index)
        summary["scan"] = {
            "files_seen": len(files),
            "verified_matches": matched_verified,
            "provisional_name_matches": 0,
            "provisional_name_candidates": provisional_candidates,
        }
        return summary

    def confirm_provisional(
        self,
        workspace_id: str,
        project_id: str,
        media_id: str,
        candidate_path: str,
    ) -> dict[str, Any]:
        """Confirm one filename-derived media candidate on this device.

        Confirmation is deliberately device-local. It does not promote an MP_
        identity into a shared content identity and never mutates project JSON.
        """
        key = str(media_id or "").strip()
        if not key.startswith("MP_"):
            raise ValueError("只有 provisional media identity 需要人工确认")
        path = Path(str(candidate_path or "")).expanduser()
        if provisional_media_id(path.name) != key:
            raise ValueError("候选文件名与 provisional media identity 不一致")
        with self._write_lock():
            payload = self.load()
            workspaces = payload.setdefault("workspaces", {})
            workspace = workspaces.setdefault(workspace_id, {"projects": {}})
            project = workspace.setdefault("projects", {}).setdefault(project_id, self._empty_project())
            candidates = project.setdefault("candidates", {})
            expected = str(candidates.get(key, "") or "")
            if not expected or str(path) != expected:
                raise ValueError("候选素材已变化，请重新扫描后再确认")
            if not path.is_file():
                raise ValueError("候选素材已离线，请重新扫描")
            project.setdefault("bindings", {})[key] = str(path)
            project.setdefault("confirmed_provisional", {})[key] = str(path)
            project["updated_at"] = _now()
            self._save(payload)
            return self.project_snapshot(workspace_id, project_id, payload)

    def add_roots(self, workspace_id: str, project_id: str, roots: Iterable[str]) -> dict[str, Any]:
        """Register host-local roots before the first analysis creates an index."""
        with self._write_lock():
            payload = self.load()
            workspaces = payload.setdefault("workspaces", {})
            workspace = workspaces.setdefault(workspace_id, {"projects": {}})
            projects = workspace.setdefault("projects", {})
            project = projects.setdefault(project_id, self._empty_project())
            stored = [str(value) for value in project.get("roots", []) if str(value)]
            for raw_root in roots:
                root = str(Path(raw_root).expanduser().resolve())
                if root and root not in stored:
                    stored.append(root)
            project["roots"] = stored
            project["updated_at"] = _now()
            self._save(payload)
            return self.project_snapshot(workspace_id, project_id, payload)

    def replace_roots(self, workspace_id: str, project_id: str, roots: Iterable[str]) -> dict[str, Any]:
        """Replace one project's device-local roots and discard stale bindings."""
        with self._write_lock():
            payload = self.load()
            workspaces = payload.setdefault("workspaces", {})
            workspace = workspaces.setdefault(workspace_id, {"projects": {}})
            projects = workspace.setdefault("projects", {})
            project = projects.setdefault(project_id, self._empty_project())
            selected: list[str] = []
            for raw_root in roots:
                root = str(Path(raw_root).expanduser().resolve())
                if root and root not in selected:
                    selected.append(root)
            project["roots"] = selected
            project["bindings"] = {}
            project["candidates"] = {}
            project["confirmed_provisional"] = {}
        project["updated_at"] = _now()
        self._save(payload)
        return self.project_snapshot(workspace_id, project_id, payload)

    def remove_project(self, workspace_id: str, project_id: str) -> None:
        with self._write_lock():
            payload = self.load()
            workspaces = payload.setdefault("workspaces", {})
            workspace = workspaces.get(workspace_id)
            if not isinstance(workspace, dict):
                return
            projects = workspace.get("projects")
            if not isinstance(projects, dict) or project_id not in projects:
                return
            projects.pop(project_id, None)
            self._save(payload)

    def probe_roots(
        self,
        workspace_id: str,
        project_id: str,
        roots: Iterable[str],
        *,
        media_files: list[Path] | None = None,
        replace: bool = False,
        cancelled: Callable[[], bool] | None = None,
    ) -> dict[str, Any]:
        """Enumerate roots before a project index exists, then commit on success.

        A new media-directory project has no material_index.json until the first
        sync/analysis completes. Replacement still stays transactional: the old
        device roots are preserved until the proposed roots have been enumerated.
        """
        current = self.project_snapshot(workspace_id, project_id)
        selected: list[str] = [] if replace else [str(value) for value in current.get("roots", []) if str(value)]
        for raw_root in roots:
            root = str(Path(raw_root).expanduser().resolve())
            if root and root not in selected:
                selected.append(root)
        if not selected:
            raise ValueError("至少选择一个媒体目录")
        files = self._media_files(selected, cancelled)
        self._check_cancelled(cancelled)
        snapshot = self.replace_roots(workspace_id, project_id, selected) if replace else self.add_roots(workspace_id, project_id, selected)
        if media_files is not None:
            media_files.extend(files)
        payload = self.load()
        count = len(files)
        return {
            "version": 1,
            "device_id": payload.get("device_id", ""),
            "device_name": payload.get("device_name", ""),
            "state_path": str(self.path),
            "roots": snapshot.get("roots", []),
            "total": count,
            "resolved": count,
            "missing": 0,
            "items": [],
            "pending_analysis": True,
            "scan": {
                "files_seen": count,
                "verified_matches": 0,
                "provisional_name_matches": 0,
                "provisional_name_candidates": 0,
            },
        }

    def forget_missing(self, workspace_id: str, project_id: str) -> None:
        with self._write_lock():
            payload = self.load()
            workspace = payload.setdefault("workspaces", {}).setdefault(workspace_id, {"projects": {}})
            project = workspace.setdefault("projects", {}).setdefault(project_id, self._empty_project())
            bindings = project.setdefault("bindings", {})
            confirmed = project.setdefault("confirmed_provisional", {})
            candidates = project.setdefault("candidates", {})
            project["bindings"] = {key: value for key, value in bindings.items() if Path(str(value)).is_file()}
            project["confirmed_provisional"] = {
                key: value
                for key, value in confirmed.items()
                if Path(str(value)).is_file() and project["bindings"].get(key) == value
            }
            project["candidates"] = {
                key: value for key, value in candidates.items() if Path(str(value)).is_file()
            }
            self._save(payload)
