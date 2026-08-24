from __future__ import annotations

from pathlib import Path
from typing import Any

from .media_identity import DeviceMediaStore
from .runtime_diagnostics import environment_payload

_INSTALLED = False


def _workspace_root(service: Any) -> Path:
    workspace = getattr(service, "workspace", None)
    config_path = getattr(workspace, "config_path", None)
    return Path(config_path).parent if config_path else Path.cwd()


def _workspace_id(service: Any) -> str:
    workspace = getattr(service, "workspace", None)
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


def install_desktop_runtime() -> None:
    """Expose Desktop-only diagnostic and device-local media binding adapters.

    The adapter delegates project lifecycle, environment diagnostics and media
    identity/binding semantics to the existing Python Core. It does not create a
    second source of business truth and never writes review/editorial authority.
    """
    global _INSTALLED
    if _INSTALLED:
        return

    from . import web_server

    original_make_handler = web_server.make_handler

    def make_handler_with_desktop(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if parts == ["api", "v1", "desktop-status"]:
                    self._local_only()
                    root = _workspace_root(service)
                    device = DeviceMediaStore().load()
                    self._send_json(
                        {
                            "contract": "desktop_status.v1",
                            "workspace": {
                                "workspace_id": _workspace_id(service),
                                "name": str(getattr(service.workspace, "name", "") or ""),
                                "path": str(root),
                                "projects": len(service.registry.list()),
                            },
                            "environment": environment_payload([root]),
                            "device_media": {
                                "version": int(device.get("version", 0) or 0),
                                "device_id": str(device.get("device_id", "") or ""),
                                "device_name": str(device.get("device_name", "") or ""),
                                "state_path": str(DeviceMediaStore().path),
                            },
                        }
                    )
                    return
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "media-binding"
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    self._send_json(
                        {
                            "contract": "media_binding.v1",
                            "project_id": project.project_id,
                            "summary": _media_summary(service, project),
                        }
                    )
                    return
                return super()._app_get(parsed)

            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if parts == ["api", "v1", "projects", "preflight"]:
                    self._local_only()
                    self._send_json(
                        {
                            "contract": "project_preflight.v1",
                            "preflight": service.registry.preflight_create(web_server._body(self)),
                        }
                    )
                    return
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "media-binding"
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    payload = web_server._body(self)
                    action = str(payload.get("action", "scan") or "scan").strip().lower()
                    roots = _normalize_roots(payload.get("roots", []))
                    store = DeviceMediaStore()
                    workspace_id = _workspace_id(service)
                    if action == "replace_and_scan":
                        store.replace_roots(workspace_id, project.project_id, roots)
                    elif action != "scan":
                        raise web_server.ApiError(
                            web_server.HTTPStatus.BAD_REQUEST,
                            "不支持的 media binding action",
                        )
                    if project.index.get("clips"):
                        summary = store.scan(workspace_id, project.project_id, project.index, roots)
                    else:
                        summary = store.probe_roots(workspace_id, project.project_id, roots)
                    # Re-apply device-local bindings immediately so subsequent
                    # media/review-model reads observe the new device state.
                    project.reload()
                    self._send_json(
                        {
                            "contract": "media_binding.v1",
                            "project_id": project.project_id,
                            "summary": summary,
                        }
                    )
                    return
                return super()._app_post(parsed)

        return Handler

    web_server.make_handler = make_handler_with_desktop
    _INSTALLED = True
