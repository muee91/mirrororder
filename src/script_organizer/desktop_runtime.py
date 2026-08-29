from __future__ import annotations

from pathlib import Path
from typing import Any

from .device_runtime_settings import application_support_root, load_runtime_settings, save_runtime_settings
from .device_tasks import get_device_task_manager, initialize_device_tasks
from .identity_runtime import IdentityRuntime
from .local_vision_runtime import LocalVisionRuntime, LocalVisionRuntimeConfig
from .media_identity import DeviceMediaStore
from .runtime_diagnostics import environment_payload

_INSTALLED = False


def _current_service(service: Any) -> Any:
    current = getattr(service, "current", None)
    return current if current is not None else service


def _workspace_root(service: Any) -> Path:
    current = _current_service(service)
    workspace = getattr(current, "workspace", None)
    config_path = getattr(workspace, "config_path", None)
    return Path(config_path).parent if config_path else Path.cwd()


def _workspace_id(service: Any) -> str:
    current = _current_service(service)
    workspace = getattr(current, "workspace", None)
    return str(getattr(workspace, "workspace_id", "") or "")


def _normalize_roots(raw: object) -> list[str]:
    if not isinstance(raw, list):
        raise ValueError("media roots 必须是数组")
    roots: list[str] = []
    for value in raw:
        text = str(value or "").strip()
        if not text:
            continue
        path = Path(text).expanduser()
        if not path.is_dir():
            raise ValueError(f"媒体目录不存在或不可读取：{path}")
        resolved = str(path.resolve())
        if resolved not in roots:
            roots.append(resolved)
    if not roots:
        raise ValueError("至少选择一个媒体目录")
    return roots


def _media_summary(service: Any, project: Any) -> dict[str, Any]:
    store = DeviceMediaStore()
    workspace_id = _workspace_id(service)
    return store.summary(workspace_id, project.project_id, project.index)


def _local_runtime_payload(service: Any) -> dict[str, Any]:
    settings = load_runtime_settings()
    model = str(settings.get("local_vision_model", "") or "")
    vision = LocalVisionRuntime(LocalVisionRuntimeConfig.from_env(model)).public()
    identity = IdentityRuntime.public()
    root = _workspace_root(service)
    return {
        "contract": "local_runtime.v1",
        "local_vision_enabled": bool(settings.get("local_vision_enabled", False)),
        "local_vision_model": model,
        "face_identity_enabled": bool(settings.get("face_identity_enabled", False)),
        "speaker_identity_enabled": bool(settings.get("speaker_identity_enabled", False)),
        "vision": vision,
        "identity": identity,
        # Retain the historical field name used by the native status surface.
        # The current runtime uses llama.cpp, so this is the lightweight cached
        # model-size snapshot rather than a framework-specific live scan.
        "mlx_cache_bytes": int(vision.get("cache_bytes", 0) or 0),
        "model_root": str(application_support_root() / "models"),
        "environment": environment_payload([root]),
    }


def _apply_runtime_action(service: Any, payload: dict[str, Any]) -> dict[str, Any]:
    action = str(payload.get("action", "set") or "set").strip().lower()
    settings = load_runtime_settings()
    device_tasks = get_device_task_manager()
    submitted: dict[str, Any] | None = None
    if action == "set":
        update: dict[str, Any] = {}
        if "local_vision_enabled" in payload:
            update["local_vision_enabled"] = bool(payload.get("local_vision_enabled"))
        if "local_vision_model" in payload:
            update["local_vision_model"] = str(payload.get("local_vision_model", "") or "").strip()
        if "face_identity_enabled" in payload:
            update["face_identity_enabled"] = bool(payload.get("face_identity_enabled"))
        if "speaker_identity_enabled" in payload:
            update["speaker_identity_enabled"] = bool(payload.get("speaker_identity_enabled"))
        if update:
            old_model = str(settings.get("local_vision_model", "") or "")
            settings = save_runtime_settings(update)
            if not bool(settings.get("local_vision_enabled", False)) or str(settings.get("local_vision_model", "") or "") != old_model:
                LocalVisionRuntime.stop()
    elif action == "prepare":
        model = str(settings.get("local_vision_model", "") or "")
        submitted = device_tasks.submit(
            "local_vision_prepare",
            {"model": model},
            idempotency_key=f"local-vision:{model}",
            actor="desktop",
        )
    elif action == "prepare_identity":
        kind = str(payload.get("kind", "") or "").strip().lower()
        if kind not in {"face", "speaker"}:
            raise ValueError("identity kind 必须是 face 或 speaker")
        submitted = device_tasks.submit(
            "identity_runtime_prepare",
            {"kind": kind},
            idempotency_key=f"identity-runtime:{kind}",
            actor="desktop",
        )
    elif action == "stop":
        for task in device_tasks.list():
            if (
                task.get("type") == "local_vision_prepare"
                and task.get("status") in {"queued", "running"}
            ):
                device_tasks.cancel(str(task.get("task_id", "") or ""))
        LocalVisionRuntime.stop()
    else:
        raise ValueError("不支持的 local runtime action")
    result = _local_runtime_payload(service)
    if submitted is not None:
        result["device_task"] = submitted
    return result


def install_desktop_runtime() -> None:
    """Expose Desktop-only parity adapters over existing Python Core stores.

    These routes are Host-local management surfaces. They delegate diagnostics,
    project lifecycle, runtime preparation, collaboration access and device-local
    media binding to existing Core implementations and never gain Review or
    Editorial Decision authority.
    """
    global _INSTALLED
    if _INSTALLED:
        return

    from . import web_server

    device_tasks = initialize_device_tasks()
    original_make_handler = web_server.make_handler

    def make_handler_with_desktop(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                current = _current_service(service)
                if parts == ["api", "v1", "device-tasks"]:
                    self._local_only()
                    self._send_json({"contract": "device_tasks.v1", "tasks": device_tasks.list()})
                    return
                if parts == ["api", "v1", "desktop-status"]:
                    self._local_only()
                    root = _workspace_root(current)
                    device_store = DeviceMediaStore()
                    device = device_store.load()
                    workspace = getattr(current, "workspace", None)
                    self._send_json(
                        {
                            "contract": "desktop_status.v1",
                            "workspace": {
                                "workspace_id": _workspace_id(current),
                                "name": str(getattr(workspace, "name", "") or ""),
                                "path": str(root),
                                "projects": len(current.registry.list()),
                            },
                            "environment": environment_payload([root]),
                            "device_media": {
                                "version": int(device.get("version", 0) or 0),
                                "device_id": str(device.get("device_id", "") or ""),
                                "device_name": str(device.get("device_name", "") or ""),
                                "state_path": str(device_store.path),
                            },
                        }
                    )
                    return
                if parts == ["api", "v1", "desktop-local-runtime"]:
                    self._local_only()
                    self._send_json(_local_runtime_payload(current))
                    return
                if parts == ["api", "v1", "desktop-collaboration"]:
                    self._local_only()
                    self._send_json(
                        {
                            "contract": "desktop_collaboration.v1",
                            "workspace_id": _workspace_id(current),
                            "users": current.collaborators.list_users(),
                            "audit": current.collaborators.audit(),
                        }
                    )
                    return
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "media-binding"
                ):
                    self._local_only()
                    project = current.project(parts[3])
                    self._send_json(
                        {
                            "contract": "media_binding.v1",
                            "project_id": project.project_id,
                            "summary": _media_summary(current, project),
                        }
                    )
                    return
                return super()._app_get(parsed)

            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                current = _current_service(service)
                if parts == ["api", "v1", "device-tasks"]:
                    self._local_only()
                    payload = web_server._body(self)
                    try:
                        task = device_tasks.submit(
                            str(payload.get("type", "") or ""),
                            payload.get("targets", {}),
                            str(payload.get("idempotency_key", "") or ""),
                            str(payload.get("actor", "desktop") or "desktop"),
                        )
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                    self._send_json(task, web_server.HTTPStatus.ACCEPTED)
                    return
                if (
                    len(parts) == 4
                    and parts[:3] == ["api", "v1", "device-tasks"]
                    and parts[3]
                ):
                    self._local_only()
                    try:
                        self._send_json(device_tasks.cancel(parts[3]))
                    except KeyError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.NOT_FOUND, "device task 不存在") from error
                    return
                if parts == ["api", "v1", "projects", "preflight"]:
                    self._local_only()
                    self._send_json(
                        {
                            "contract": "project_preflight.v1",
                            "preflight": current.registry.preflight_create(web_server._body(self)),
                        }
                    )
                    return
                if parts == ["api", "v1", "desktop-local-runtime"]:
                    self._local_only()
                    self._send_json(_apply_runtime_action(current, web_server._body(self)))
                    return
                if (
                    len(parts) == 4
                    and parts[:3] == ["api", "v1", "desktop-collaboration"]
                    and parts[3]
                ):
                    self._local_only()
                    user = current.collaborators.update_user(parts[3], web_server._body(self))
                    self._send_json(
                        {
                            "contract": "desktop_collaboration.v1",
                            "workspace_id": _workspace_id(current),
                            "user": user,
                            "users": current.collaborators.list_users(),
                            "audit": current.collaborators.audit(),
                        }
                    )
                    return
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "media-binding"
                ):
                    self._local_only()
                    project = current.project(parts[3])
                    payload = web_server._body(self)
                    action = str(payload.get("action", "scan") or "scan").strip().lower()
                    store = DeviceMediaStore()
                    workspace_id = _workspace_id(current)
                    if action == "confirm_provisional":
                        store.confirm_provisional(
                            workspace_id,
                            project.project_id,
                            str(payload.get("media_id", "") or ""),
                            str(payload.get("candidate_path", "") or ""),
                        )
                        summary = store.summary(workspace_id, project.project_id, project.index)
                        project.reload()
                        self._send_json(
                            {
                                "contract": "media_binding.v1",
                                "project_id": project.project_id,
                                "summary": summary,
                            }
                        )
                        return
                    if action in {"scan", "replace_and_scan"}:
                        raise web_server.ApiError(
                            web_server.HTTPStatus.SERVICE_UNAVAILABLE,
                            "素材扫描 durable runtime 未安装；禁止退回同步扫描",
                        )
                    raise web_server.ApiError(
                        web_server.HTTPStatus.BAD_REQUEST,
                        "不支持的 media binding action",
                    )
                return super()._app_post(parsed)

        return Handler

    web_server.make_handler = make_handler_with_desktop
    _INSTALLED = True
