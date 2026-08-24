from __future__ import annotations

import urllib.parse
from pathlib import Path
from typing import Any

from .identity_library import IdentityLibrary
from .identity_role_inference import install_identity_role_inference
from .workspace_db import WorkspaceDatabase

_INSTALLED = False


def _library(project: Any) -> IdentityLibrary:
    workspace_id = str(getattr(project, "workspace_id", "") or "").strip()
    if not workspace_id:
        raise ValueError("identity library 需要稳定 workspace_id")
    return IdentityLibrary(WorkspaceDatabase(workspace_id), str(project.project_id))


def install_identity_api_runtime() -> None:
    """Expose device-local identity labels to the native Desktop App.

    This is intentionally a thin localhost adapter over IdentityLibrary.  It
    never exposes embeddings and never promotes inferred role candidates to
    human-confirmed labels without an explicit POST from the App.
    """

    global _INSTALLED
    if _INSTALLED:
        return

    install_identity_role_inference()

    from . import web_server

    original_capabilities = web_server.WorkspaceService.capabilities
    original_make_handler = web_server.make_handler

    def capabilities_with_identity(service: Any, agent: dict[str, Any]) -> dict[str, Any]:
        payload = original_capabilities(service, agent)
        payload["identity_library"] = {
            "read": True,
            "app_write": True,
            "agent_write": False,
            "device_local": True,
            "embeddings_exposed": False,
            "role_candidates_require_confirmation": True,
        }
        return payload

    def make_handler_with_identity(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "identities"
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    query = urllib.parse.parse_qs(parsed.query)
                    kind = str((query.get("kind") or [""])[0] or "").strip()
                    try:
                        rows = _library(project).list(kind)
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                    self._send_json(
                        {
                            "contract": "identity_library.v1",
                            "project_id": str(project.project_id),
                            "kind": kind,
                            "identities": rows,
                            "semantics": {
                                "device_local": True,
                                "embeddings_exposed": False,
                                "suggestions_are_authority": False,
                                "human_confirmation_required": True,
                            },
                        }
                    )
                    return
                return super()._app_get(parsed)

            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "identities"
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    body = web_server._body(self)
                    identity_id = str(body.get("identity_id", "") or "").strip()
                    if not identity_id:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "identity_id 不能为空")
                    try:
                        row = _library(project).update(
                            identity_id,
                            label=str(body.get("label", "") or ""),
                            role_name=str(body.get("role_name", "") or ""),
                        )
                    except KeyError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.NOT_FOUND, "identity 不存在") from error
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                    self._send_json(
                        {
                            "contract": "identity_library.v1",
                            "project_id": str(project.project_id),
                            "identity": row,
                        }
                    )
                    return
                return super()._app_post(parsed)

        return Handler

    web_server.WorkspaceService.capabilities = capabilities_with_identity
    web_server.make_handler = make_handler_with_identity
    _INSTALLED = True


__all__ = ["install_identity_api_runtime"]
