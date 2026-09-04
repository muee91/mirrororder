from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any
from uuid import uuid4

from .operations import (
    ProjectTransferCancelled,
    ProjectTransferError,
    collect_project_archive,
    copy_project_package,
    inspect_project_package,
)
from .request_store import ProjectTransferRequestStore

_INSTALLED = False
_DEVICE_IMPORT_TASK = "project_package_import"
_PROJECT_SAVE_TASK = "project_save_as"
_PROJECT_COLLECT_TASK = "project_collect"


def _current_service(service: Any) -> Any:
    current = getattr(service, "current", None)
    return current if current is not None else service


def _request_id(raw: object) -> str:
    value = str(raw or "").strip().lower()
    if len(value) != 32 or any(char not in "0123456789abcdef" for char in value):
        raise ValueError("project transfer task 需要有效 request_id")
    return value


def _request_store() -> ProjectTransferRequestStore:
    from ..device_runtime_settings import application_support_root

    return ProjectTransferRequestStore(application_support_root() / "project-transfer-requests")


def _workspace_config_path(current: Any) -> Path:
    workspace = getattr(current, "workspace", None)
    path = getattr(workspace, "config_path", None)
    if not path:
        raise ValueError("当前服务缺少 workspace config")
    return Path(path).expanduser().resolve()


def _workspace_id(current: Any) -> str:
    workspace = getattr(current, "workspace", None)
    return str(getattr(workspace, "workspace_id", "") or "")


def _collect_media_files(config: Any, workspace_id: str, project_id: str) -> list[tuple[str, Path]]:
    from ..media_identity import DeviceMediaStore

    try:
        index = json.loads((config.output_dir / "material_index.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ProjectTransferError("收集原始媒体前需要有效 material_index.json") from error
    if not isinstance(index, dict) or not isinstance(index.get("clips"), list):
        raise ProjectTransferError("收集原始媒体前需要有效素材索引")
    store = DeviceMediaStore()
    snapshot = store.project_snapshot(workspace_id, project_id)
    result: list[tuple[str, Path]] = []
    seen: set[str] = set()
    missing: list[str] = []
    for raw in index["clips"]:
        if not isinstance(raw, dict):
            continue
        media_id = str(raw.get("media_id", "") or "").strip()
        if not media_id or media_id in seen:
            continue
        seen.add(media_id)
        # DeviceMediaStore is the media-identity authority here: M_ identities
        # are content-verified and MP_ identities require an explicit local
        # confirmation. Do not add a path-exists fallback or the archive could
        # silently collect replaced media under the wrong identity.
        resolved = store.resolve_from_snapshot(snapshot, raw)
        if not resolved or not Path(resolved).is_file():
            missing.append(media_id)
            continue
        result.append((media_id, Path(resolved).resolve()))
    if missing:
        preview = "、".join(missing[:8])
        suffix = f" 等 {len(missing)} 条" if len(missing) > 8 else ""
        raise ProjectTransferError(f"当前设备未定位全部收集媒体：{preview}{suffix}")
    if not result:
        raise ProjectTransferError("当前项目没有可按 media_id 收集的本机媒体")
    return result


def _device_import_run(manager: Any, task_id: str, task: dict[str, Any]) -> None:
    from ..workspace import WorkspaceConfig, WorkspaceRegistry

    store = _request_store()
    try:
        if task.get("status") == "cancelled":
            return
        manager._update(task_id, status="running", stage="import_preflight", message="开始导入外部镜序项目")
        if manager._cancel_requested(task_id):
            manager._update(task_id, status="cancelled", stage="cancelled", message="项目导入已取消")
            return
        request_id = _request_id((task.get("targets") or {}).get("request_id"))
        request = store.load(request_id, expected_kind="import_project")
        workspace_path = Path(str(request.get("workspace_config_path", "") or "")).expanduser().resolve()
        source_path = Path(str(request.get("source_path", "") or "")).expanduser().resolve()
        workspace = WorkspaceConfig.from_file(workspace_path)
        registry = WorkspaceRegistry(workspace)
        inspection = inspect_project_package(source_path, require_external_suffix=True)
        project_id = inspection.manifest.project_id
        if not project_id:
            raise ProjectTransferError("外部项目缺少稳定 project.id，不能导入")
        if any(item.get("project_id") == project_id for item in registry.list()):
            raise ProjectTransferError("工作区已存在相同 project_id；请先对外部项目执行另存为")
        target = registry.config.registry_path.parent / project_id
        manager._update(task_id, stage="import_copy", message="正在复制项目包到当前工作区")
        copy_project_package(
            inspection.root,
            target,
            include_cache=True,
            require_external_source=True,
            cancelled=lambda: manager._cancel_requested(task_id),
            destination_extension=None,
        )
        try:
            entry = registry.register_existing(project_id, target / "project.toml")
        except Exception:
            shutil.rmtree(target, ignore_errors=True)
            raise
        store.remove(request_id)
        manager._update(
            task_id,
            status="completed",
            stage="completed",
            result={
                "project_id": project_id,
                "name": str(entry.get("name", "") or inspection.manifest.name),
                "imported": True,
            },
            message="外部镜序项目已导入工作区",
        )
    except ProjectTransferCancelled:
        manager._update(task_id, status="cancelled", stage="cancelled", message="项目导入已取消")
    except Exception as error:
        if manager._cancel_requested(task_id):
            manager._update(task_id, status="cancelled", stage="cancelled", message="项目导入已取消")
        else:
            manager._update(
                task_id,
                status="failed",
                stage="failed",
                error=str(error),
                message="项目导入失败",
            )
    finally:
        manager._threads.pop(task_id, None)


def _project_transfer_run(manager: Any, project_id: str, task_id: str, task: dict[str, Any]) -> None:
    store = _request_store()
    config = manager.project_loader(project_id)
    try:
        manager._update(config, task_id, status="running", stage="transfer_preflight", message="项目传输开始")
        if manager._cancel_requested(config, task_id):
            manager._update(config, task_id, status="cancelled", stage="cancelled", message="项目传输已取消")
            return
        task_type = str(task.get("type", "") or "")
        request_id = _request_id((task.get("targets") or {}).get("request_id"))
        expected = "save_project_as" if task_type == _PROJECT_SAVE_TASK else "collect_project"
        request = store.load(request_id, expected_kind=expected)
        if str(request.get("project_id", "") or "") != project_id:
            raise ProjectTransferError("project transfer request 与项目身份不一致")

        if task_type == _PROJECT_SAVE_TASK:
            manager._update(config, task_id, stage="save_as", message="正在另存项目包")
            result = copy_project_package(
                config.project_dir,
                str(request.get("destination", "") or ""),
                include_cache=bool(request.get("include_cache", False)),
                new_project_id=str(request.get("new_project_id", "") or ""),
                new_name=str(request.get("new_name", "") or ""),
                cancelled=lambda: manager._cancel_requested(config, task_id),
            )
            result["operation"] = "save_project_as"
        elif task_type == _PROJECT_COLLECT_TASK:
            include_media = bool(request.get("include_media", False))
            manager._update(
                config,
                task_id,
                stage="collect",
                message="正在收集项目" + ("与本机媒体" if include_media else ""),
            )
            media_files = (
                _collect_media_files(
                    config,
                    str(request.get("workspace_id", "") or ""),
                    project_id,
                )
                if include_media
                else []
            )
            result = collect_project_archive(
                config.project_dir,
                str(request.get("destination", "") or ""),
                include_cache=bool(request.get("include_cache", False)),
                media_files=media_files,
                cancelled=lambda: manager._cancel_requested(config, task_id),
            )
            result["operation"] = "collect_project"
        else:
            raise ProjectTransferError("不支持的 project transfer task")
        store.remove(request_id)
        manager._update(
            config,
            task_id,
            status="completed",
            stage="completed",
            result=result,
            message="项目传输完成",
        )
    except ProjectTransferCancelled:
        manager._update(config, task_id, status="cancelled", stage="cancelled", message="项目传输已取消")
    except Exception as error:
        if manager._cancel_requested(config, task_id):
            manager._update(config, task_id, status="cancelled", stage="cancelled", message="项目传输已取消")
        else:
            manager._update(
                config,
                task_id,
                status="failed",
                stage="failed",
                error=str(error),
                message="项目传输失败",
            )
    finally:
        manager._threads.pop(task_id, None)


def install_project_transfer_runtime() -> None:
    global _INSTALLED
    if _INSTALLED:
        return

    from .. import device_tasks, tasks as task_runtime, web_server
    from ..workspace import project_id_for

    device_tasks.DEVICE_TASK_TYPES.add(_DEVICE_IMPORT_TASK)
    task_runtime.TASK_TYPES.update({_PROJECT_SAVE_TASK, _PROJECT_COLLECT_TASK})

    original_device_targets = device_tasks._targets
    original_device_run = device_tasks.DeviceTaskManager._run
    original_project_run = task_runtime.TaskManager._run
    original_make_handler = web_server.make_handler

    def device_targets_with_project_import(task_type: str, raw: object) -> dict[str, Any]:
        if task_type == _DEVICE_IMPORT_TASK:
            source = raw if isinstance(raw, dict) else {}
            return {"request_id": _request_id(source.get("request_id"))}
        return original_device_targets(task_type, raw)

    def device_run_with_project_import(manager: Any, task_id: str) -> None:
        task = manager._task(manager._load(), task_id)
        if task.get("type") != _DEVICE_IMPORT_TASK:
            return original_device_run(manager, task_id)
        _device_import_run(manager, task_id, task)

    def project_run_with_transfer(manager: Any, project_id: str, task_id: str) -> None:
        config = manager.project_loader(project_id)
        task = manager._task(manager._load(config), task_id)
        if task.get("type") not in {_PROJECT_SAVE_TASK, _PROJECT_COLLECT_TASK}:
            return original_project_run(manager, project_id, task_id)
        _project_transfer_run(manager, project_id, task_id, task)

    device_tasks._targets = device_targets_with_project_import
    device_tasks.DeviceTaskManager._run = device_run_with_project_import
    task_runtime.TaskManager._run = project_run_with_transfer

    def make_handler_with_project_transfer(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                current = _current_service(service)
                if parts == ["api", "v1", "project-packages", "inspect"]:
                    self._local_only()
                    payload = web_server._body(self)
                    try:
                        inspection = inspect_project_package(
                            str(payload.get("path", "") or ""),
                            require_external_suffix=True,
                        )
                    except (OSError, ValueError) as error:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                    self._send_json(
                        {
                            "contract": "project_package_inspect.v1",
                            "package": inspection.public(),
                        }
                    )
                    return

                if parts == ["api", "v1", "project-packages", "import"]:
                    self._local_only()
                    payload = web_server._body(self)
                    try:
                        inspection = inspect_project_package(
                            str(payload.get("path", "") or ""),
                            require_external_suffix=True,
                        )
                        if not inspection.manifest.project_id:
                            raise ProjectTransferError("外部项目缺少稳定 project.id，不能导入")
                        if any(
                            item.get("project_id") == inspection.manifest.project_id
                            for item in current.registry.list()
                        ):
                            raise ProjectTransferError("工作区已存在相同 project_id；请先另存外部项目")
                        store = _request_store()
                        request_id = store.create(
                            "import_project",
                            {
                                "workspace_config_path": str(_workspace_config_path(current)),
                                "source_path": str(inspection.root),
                            },
                        )
                        manager = device_tasks.get_device_task_manager()
                        try:
                            task = manager.submit(
                                _DEVICE_IMPORT_TASK,
                                {"request_id": request_id},
                                idempotency_key=f"project-import:{request_id}",
                                actor="desktop",
                            )
                        except Exception:
                            store.remove(request_id)
                            raise
                    except (OSError, ValueError) as error:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                    self._send_json(
                        {
                            "contract": "project_package_import.v1",
                            "package": inspection.public(),
                            "task": task,
                        },
                        web_server.HTTPStatus.ACCEPTED,
                    )
                    return

                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] in {"save-as", "collect"}
                ):
                    self._local_only()
                    project_id = parts[3]
                    try:
                        config = current.registry.project_config(project_id)
                    except KeyError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.NOT_FOUND, "项目不存在") from error
                    payload = web_server._body(self)
                    destination = str(payload.get("destination", "") or "").strip()
                    if not destination:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "需要目标路径")
                    if parts[4] == "save-as":
                        new_name = str(payload.get("name", "") or "").strip() or f"{config.name} 副本"
                        requested_id = str(payload.get("project_id", "") or "").strip()
                        new_project_id = project_id_for(requested_id or f"{new_name}-{uuid4().hex[:8]}")
                        request_id = _request_store().create(
                            "save_project_as",
                            {
                                "project_id": project_id,
                                "destination": destination,
                                "new_project_id": new_project_id,
                                "new_name": new_name,
                                "include_cache": bool(payload.get("include_cache", False)),
                            },
                        )
                        task_type = _PROJECT_SAVE_TASK
                    else:
                        request_id = _request_store().create(
                            "collect_project",
                            {
                                "workspace_id": _workspace_id(current),
                                "project_id": project_id,
                                "destination": destination,
                                "include_cache": bool(payload.get("include_cache", False)),
                                "include_media": bool(payload.get("include_media", False)),
                            },
                        )
                        task_type = _PROJECT_COLLECT_TASK
                    try:
                        task = current.tasks.submit(
                            project_id,
                            task_type,
                            {"request_id": request_id},
                            idempotency_key=f"{task_type}:{request_id}",
                            actor="desktop",
                        )
                    except ValueError as error:
                        _request_store().remove(request_id)
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                    self._send_json(
                        {
                            "contract": "project_transfer_task.v1",
                            "project_id": project_id,
                            "operation": parts[4],
                            "task": task,
                        },
                        web_server.HTTPStatus.ACCEPTED,
                    )
                    return
                return super()._app_post(parsed)

        return Handler

    web_server.make_handler = make_handler_with_project_transfer
    _INSTALLED = True


__all__ = ["install_project_transfer_runtime"]
