from __future__ import annotations

from pathlib import Path
from typing import Any


_INSTALLED = False


def _current_service(service: Any) -> Any:
    current = getattr(service, "current", None)
    return current if current is not None else service


def project_local_location(service: Any, project_id: str) -> dict[str, Any]:
    """Resolve device-local project paths for explicit Desktop actions only.

    These absolute paths are intentionally returned only by a Host-local route.
    They are never persisted into project/shared artifacts or workspace registry
    fields beyond the existing relative project config reference.
    """

    current = _current_service(service)
    config = current.registry.project_config(project_id)
    project_dir = Path(config.project_dir).resolve()
    output_dir = Path(config.output_dir).resolve()
    return {
        "contract": "project_local_location.v1",
        "project_id": project_id,
        "project_dir": str(project_dir),
        "output_dir": str(output_dir),
        "project_exists": project_dir.is_dir(),
        "output_exists": output_dir.is_dir(),
        "device_paths_exposed": True,
        "scope": "device_local_response",
    }


def install_project_location_runtime() -> None:
    global _INSTALLED
    if _INSTALLED:
        return

    from . import web_server

    original_make_handler = web_server.make_handler

    def make_handler_with_project_location(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "local-location"
                ):
                    self._local_only()
                    try:
                        payload = project_local_location(service, parts[3])
                    except KeyError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.NOT_FOUND, "项目不存在") from error
                    self._send_json(payload)
                    return
                return super()._app_get(parsed)

        return Handler

    web_server.make_handler = make_handler_with_project_location
    _INSTALLED = True


__all__ = ["install_project_location_runtime", "project_local_location"]
