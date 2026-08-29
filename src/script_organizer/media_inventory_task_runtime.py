from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from uuid import uuid4

from .media_identity import DeviceMediaStore, media_id_for_path
from .media_reader import infer_camera_label
from .media_role_store import MediaRoleStore
from .resource_scheduler import ResourceCancelled

_INSTALLED = False
_TASK_TYPE = "media_inventory_scan"
_MAX_INVENTORY_FILES = 12000


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _atomic_json(path: Path, payload: object) -> None:
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


def _scope_key(workspace_id: str, project_id: str) -> str:
    raw = f"{workspace_id}\0{project_id}".encode("utf-8", errors="replace")
    return hashlib.sha256(raw).hexdigest()[:24]


def _snapshot_path(device: DeviceMediaStore, workspace_id: str, project_id: str) -> Path:
    return device.path.parent / "media-inventory" / f"{_scope_key(workspace_id, project_id)}.json"


def _request_path(device: DeviceMediaStore, request_id: str) -> Path:
    safe = "".join(char for char in request_id if char.isalnum() or char in {"-", "_"})[:80]
    if not safe:
        raise ValueError("media inventory request_id 无效")
    return device.path.parent / "media-inventory-requests" / f"{safe}.json"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _write_inventory_snapshot(
    device: DeviceMediaStore,
    workspace_id: str,
    project_id: str,
    roots: Iterable[str],
    *,
    media_rows: Iterable[tuple[str, str]] | None = None,
    media_files: Iterable[Path] | None = None,
) -> dict[str, Any]:
    root_values = [str(Path(value).expanduser()) for value in roots if str(value)]
    candidates: list[tuple[str, str]] = []
    source_count = 0
    if media_rows is not None:
        candidates = [(str(media_id), str(path)) for media_id, path in media_rows if str(media_id)]
        source_count = len(candidates)
    else:
        files = list(media_files) if media_files is not None else device._media_files(root_values)
        source_count = len(files)
        for path in files[:_MAX_INVENTORY_FILES]:
            media_id = media_id_for_path(path)
            if media_id:
                candidates.append((media_id, str(path)))

    rows: list[dict[str, str]] = []
    seen_media: set[str] = set()
    for media_id, path_text in candidates[:_MAX_INVENTORY_FILES]:
        if not media_id or media_id in seen_media:
            continue
        seen_media.add(media_id)
        rows.append({"media_id": media_id, "path": path_text})
    payload = {
        "version": 1,
        "workspace_id": workspace_id,
        "project_id": project_id,
        "updated_at": _now(),
        "roots": root_values,
        "items": rows,
        "truncated": source_count > _MAX_INVENTORY_FILES,
    }
    _atomic_json(_snapshot_path(device, workspace_id, project_id), payload)
    return payload


def _read_inventory_snapshot(
    device: DeviceMediaStore,
    workspace_id: str,
    project_id: str,
) -> dict[str, Any]:
    payload = _read_json(_snapshot_path(device, workspace_id, project_id))
    if payload.get("workspace_id") != workspace_id or payload.get("project_id") != project_id:
        return {}
    return payload


def _indexed_rows(project: Any) -> dict[str, dict[str, str]]:
    result: dict[str, dict[str, str]] = {}

    def add(row: object) -> None:
        if not isinstance(row, dict):
            return
        media_id = str(row.get("media_id", "") or "")
        if not media_id or media_id in result:
            return
        source = str(row.get("source_media_path", "") or row.get("media_path", "") or "")
        result[media_id] = {
            "display_name": (Path(source).name or str(row.get("name", "") or media_id))[:300],
            "inferred_camera": str(row.get("camera", "") or "")[:40],
        }

    for clip in project.index.get("clips", []):
        add(clip)
    for group in project.index.get("groups", []):
        if not isinstance(group, dict):
            continue
        for member in group.get("members", []):
            add(member)
    return result


def _safe_role(value: object) -> dict[str, Any]:
    raw = value if isinstance(value, dict) else {}
    if not raw:
        return {}
    return {
        "media_id": str(raw.get("media_id", "") or ""),
        "display_name": str(raw.get("display_name", "") or "")[:300],
        "camera_override": str(raw.get("camera_override", "") or "")[:40],
        "source_role": str(raw.get("source_role", "sync_camera") or "sync_camera")[:40],
        "role_label": str(raw.get("role_label", "") or "")[:80],
        "sync_policy": str(raw.get("sync_policy", "auto") or "auto")[:40],
        "scene_id": str(raw.get("scene_id", "") or "")[:160],
        "note": str(raw.get("note", "") or "")[:1200],
        "actor": str(raw.get("actor", "") or "")[:80],
        "updated_at": str(raw.get("updated_at", "") or "")[:80],
    }


def inventory_payload(project: Any, device: DeviceMediaStore, roles: MediaRoleStore) -> dict[str, Any]:
    """Return a path-free inventory projection without touching media bytes."""

    workspace_id = str(getattr(project, "workspace_id", "") or "")
    project_id = str(project.project_id)
    device_state = device.project_snapshot(workspace_id, project_id)
    snapshot = _read_inventory_snapshot(device, workspace_id, project_id)
    current_roots = [str(value) for value in device_state.get("roots", []) if str(value)]
    cached_roots = [str(value) for value in snapshot.get("roots", []) if str(value)]
    scan_required = not snapshot or sorted(current_roots) != sorted(cached_roots)

    indexed = _indexed_rows(project)
    saved = roles.load()
    labels = saved.get("media", {}) if isinstance(saved.get("media"), dict) else {}
    rows_by_id: dict[str, dict[str, Any]] = {}

    for raw in snapshot.get("items", []) if isinstance(snapshot.get("items"), list) else []:
        if not isinstance(raw, dict):
            continue
        media_id = str(raw.get("media_id", "") or "")
        path_text = str(raw.get("path", "") or "")
        if not media_id:
            continue
        path = Path(path_text)
        indexed_row = indexed.get(media_id, {})
        rows_by_id[media_id] = {
            "media_id": media_id,
            "display_name": (path.name or indexed_row.get("display_name") or media_id)[:300],
            "folder_label": path.parent.name[:120] if path_text else "",
            "inferred_camera": (
                indexed_row.get("inferred_camera")
                or infer_camera_label(path, project.config.camera_patterns)
                if path_text
                else indexed_row.get("inferred_camera", "")
            ),
            "indexed": media_id in indexed,
            "label": _safe_role(labels.get(media_id)),
        }

    for media_id, indexed_row in indexed.items():
        rows_by_id.setdefault(
            media_id,
            {
                "media_id": media_id,
                "display_name": indexed_row.get("display_name", media_id),
                "folder_label": "",
                "inferred_camera": indexed_row.get("inferred_camera", ""),
                "indexed": True,
                "label": _safe_role(labels.get(media_id)),
            },
        )

    for media_id, raw_role in labels.items():
        key = str(media_id)
        if key in rows_by_id or not isinstance(raw_role, dict):
            continue
        role = _safe_role(raw_role)
        rows_by_id[key] = {
            "media_id": key,
            "display_name": str(role.get("display_name", "") or key)[:300],
            "folder_label": "",
            "inferred_camera": "",
            "indexed": key in indexed,
            "label": role,
        }

    rows = list(rows_by_id.values())
    rows.sort(
        key=lambda row: (
            0 if row["label"] else 1,
            0 if not row["indexed"] else 1,
            str(row["display_name"]).casefold(),
            str(row["media_id"]),
        )
    )
    auxiliary = sum(
        1
        for row in rows
        if (
            str(row["label"].get("source_role", "") or "") not in {"", "sync_camera"}
            or str(row["label"].get("sync_policy", "") or "") == "exclude"
        )
    )
    return {
        "contract": "media_inventory.v1",
        "project_id": project_id,
        "role_revision": int(saved.get("revision", 0) or 0),
        "inventory_updated_at": str(snapshot.get("updated_at", "") or ""),
        "scan_required": bool(scan_required),
        "summary": {
            "files": len(rows),
            "indexed": sum(1 for row in rows if row["indexed"]),
            "unindexed": sum(1 for row in rows if not row["indexed"]),
            "labeled": sum(1 for row in rows if row["label"]),
            "auxiliary": auxiliary,
        },
        "items": rows,
        "semantics": {
            "paths_exposed": False,
            "device_local_scan": True,
            "read_path_scans_media": False,
            "snapshot_rebuildable": True,
            "media_id_shared_identity": True,
            "unindexed_media_may_be_labeled": True,
            "camera_override_is_shared_human_fact": True,
            "auxiliary_without_timecode_or_audio_is_valid": True,
        },
    }


def _store_scan_request(
    device: DeviceMediaStore,
    *,
    workspace_id: str,
    project_id: str,
    roots: list[str],
    replace: bool,
) -> str:
    request_id = uuid4().hex
    _atomic_json(
        _request_path(device, request_id),
        {
            "version": 1,
            "request_id": request_id,
            "workspace_id": workspace_id,
            "project_id": project_id,
            "roots": roots,
            "replace": bool(replace),
            "created_at": _now(),
        },
    )
    return request_id


def _load_scan_request(device: DeviceMediaStore, request_id: str) -> dict[str, Any]:
    payload = _read_json(_request_path(device, request_id))
    if payload.get("request_id") != request_id:
        raise ValueError("素材扫描请求不存在或已失效")
    return payload


def _safe_task_result(summary: object, inventory: dict[str, Any]) -> dict[str, Any]:
    raw = summary if isinstance(summary, dict) else {}
    scan = raw.get("scan", {}) if isinstance(raw.get("scan"), dict) else {}
    return {
        "device_local": True,
        "paths_exposed": False,
        "files_seen": int(scan.get("files_seen", 0) or inventory.get("summary", {}).get("files", 0) or 0),
        "resolved": int(raw.get("resolved", 0) or 0),
        "missing": int(raw.get("missing", 0) or 0),
        "pending_analysis": bool(raw.get("pending_analysis", False)),
        "inventory_updated_at": str(inventory.get("inventory_updated_at", "") or ""),
    }


def install_media_inventory_task_runtime() -> None:
    """Make media-directory enumeration durable and keep inventory GET read-only."""

    global _INSTALLED
    if _INSTALLED:
        return

    from . import tasks as task_runtime, web_server
    from .desktop_runtime import _current_service, _normalize_roots, _workspace_id

    original_scan = DeviceMediaStore.scan
    original_probe = DeviceMediaStore.probe_roots
    original_remove_project = DeviceMediaStore.remove_project
    original_task_run = task_runtime.TaskManager._run
    original_make_handler = web_server.make_handler

    def scan_with_snapshot(
        store: DeviceMediaStore,
        workspace_id: str,
        project_id: str,
        index: dict[str, Any],
        roots: Iterable[str],
    ) -> dict[str, Any]:
        media_rows: list[tuple[str, str]] = []
        summary = original_scan(
            store,
            workspace_id,
            project_id,
            index,
            roots,
            media_rows=media_rows,
        )
        state = store.project_snapshot(workspace_id, project_id)
        _write_inventory_snapshot(
            store,
            workspace_id,
            project_id,
            state.get("roots", []),
            media_rows=media_rows,
        )
        return summary

    def probe_with_snapshot(
        store: DeviceMediaStore,
        workspace_id: str,
        project_id: str,
        roots: Iterable[str],
    ) -> dict[str, Any]:
        media_files: list[Path] = []
        summary = original_probe(
            store,
            workspace_id,
            project_id,
            roots,
            media_files=media_files,
        )
        state = store.project_snapshot(workspace_id, project_id)
        _write_inventory_snapshot(
            store,
            workspace_id,
            project_id,
            state.get("roots", []),
            media_files=media_files,
        )
        return summary

    def remove_project_with_snapshot(store: DeviceMediaStore, workspace_id: str, project_id: str) -> None:
        original_remove_project(store, workspace_id, project_id)
        try:
            _snapshot_path(store, workspace_id, project_id).unlink(missing_ok=True)
        except OSError:
            pass

    DeviceMediaStore.scan = scan_with_snapshot
    DeviceMediaStore.probe_roots = probe_with_snapshot
    DeviceMediaStore.remove_project = remove_project_with_snapshot

    task_runtime.TASK_TYPES.add(_TASK_TYPE)

    def run_with_media_inventory(manager: Any, project_id: str, task_id: str) -> None:
        config = manager.project_loader(project_id)
        try:
            task = manager._task(manager._load(config), task_id)
        except Exception:
            return original_task_run(manager, project_id, task_id)
        if str(task.get("type", "")) != _TASK_TYPE:
            return original_task_run(manager, project_id, task_id)

        try:
            manager._update(config, task_id, status="running", stage="starting", message="素材扫描任务开始")
            if manager._cancel_requested(config, task_id):
                manager._update(config, task_id, status="cancelled", stage="cancelled", message="素材扫描已取消")
                return
            if not str(getattr(manager, "workspace_id", "") or ""):
                raise ValueError("素材扫描任务缺少 workspace_id")
            targets = task.get("targets", {}) if isinstance(task.get("targets"), dict) else {}
            request_id = str(targets.get("request_id", "") or "")
            if not request_id:
                raise ValueError("素材扫描任务缺少 request_id")
            store = DeviceMediaStore()
            request = _load_scan_request(store, request_id)
            workspace_id = str(manager.workspace_id)
            if request.get("workspace_id") != workspace_id or request.get("project_id") != project_id:
                raise ValueError("素材扫描请求与当前项目不匹配")
            roots = [str(value) for value in request.get("roots", []) if str(value)]
            if not roots:
                raise ValueError("素材扫描请求没有媒体目录")
            if bool(request.get("replace", False)):
                store.replace_roots(workspace_id, project_id, roots)
                try:
                    _snapshot_path(store, workspace_id, project_id).unlink(missing_ok=True)
                except OSError:
                    pass

            with manager._resource(config, task, "cpu", "media_inventory", "素材扫描"):
                try:
                    index = json.loads((config.output_dir / "material_index.json").read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    index = {}
                if isinstance(index, dict) and (index.get("clips") or index.get("groups")):
                    summary = store.scan(workspace_id, project_id, index, roots)
                else:
                    summary = store.probe_roots(workspace_id, project_id, roots)

            project = type("InventoryProject", (), {})()
            project.project_id = project_id
            project.workspace_id = workspace_id
            project.index = index if isinstance(index, dict) else {}
            project.config = config
            inventory = inventory_payload(project, store, MediaRoleStore(config.output_dir))
            result = _safe_task_result(summary, inventory)
            if manager._cancel_requested(config, task_id):
                manager._update(
                    config,
                    task_id,
                    status="cancelled",
                    stage="cancelled",
                    result=result,
                    message="素材扫描阶段完成后已停止",
                )
                return
            manager._update(
                config,
                task_id,
                status="completed",
                stage="completed",
                result=result,
                message=f"素材扫描完成 · {result['files_seen']} 个文件",
            )
        except ResourceCancelled:
            manager._update(config, task_id, status="cancelled", stage="cancelled", message="等待素材扫描资源时已取消")
        except Exception as error:
            manager._update(config, task_id, status="failed", stage="failed", error=str(error), message="素材扫描失败")
        finally:
            manager._threads.pop(task_id, None)

    task_runtime.TaskManager._run = run_with_media_inventory

    def make_handler_with_media_inventory(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "media-inventory"
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    self._send_json(
                        inventory_payload(
                            project,
                            DeviceMediaStore(),
                            MediaRoleStore(project.config.output_dir),
                        )
                    )
                    return
                return super()._app_get(parsed)

            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "media-binding"
                ):
                    body = web_server._body(self)
                    action = str(body.get("action", "scan") or "scan").strip().lower()
                    if action not in {"scan", "replace_and_scan"}:
                        return super()._app_post(parsed)
                    self._local_only()
                    current = _current_service(service)
                    project = current.project(parts[3])
                    roots = _normalize_roots(body.get("roots", []))
                    store = DeviceMediaStore()
                    workspace_id = _workspace_id(current)
                    request_id = _store_scan_request(
                        store,
                        workspace_id=workspace_id,
                        project_id=project.project_id,
                        roots=roots,
                        replace=action == "replace_and_scan",
                    )
                    task = current.tasks.submit(
                        project.project_id,
                        _TASK_TYPE,
                        {"request_id": request_id},
                        idempotency_key=f"media_inventory_scan:{project.project_id}:{request_id}",
                        actor="desktop",
                    )
                    self._send_json(
                        {
                            "contract": "media_inventory_scan.v1",
                            "project_id": project.project_id,
                            "task": task,
                        },
                        web_server.HTTPStatus.ACCEPTED,
                    )
                    return
                return super()._app_post(parsed)

        return Handler

    web_server.make_handler = make_handler_with_media_inventory
    _INSTALLED = True


__all__ = ["install_media_inventory_task_runtime", "inventory_payload"]
