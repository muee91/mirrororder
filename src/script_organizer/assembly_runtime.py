from __future__ import annotations

from pathlib import Path
from typing import Any

from .assembly_timeline import ASSEMBLY_CONTRACT, build_assembly_timeline
from .coverage_graph import coverage_revision
from .coverage_runtime import _filters


_INSTALLED = False


def install_assembly_runtime() -> None:
    """Install read-only assembly preview for App Production and read-scoped agents."""

    global _INSTALLED
    if _INSTALLED:
        return

    from . import web_server

    original_state = web_server.ProjectService.state
    original_capabilities = web_server.WorkspaceService.capabilities
    original_make_handler = web_server.make_handler

    def state_with_assembly(project: Any) -> dict[str, Any]:
        payload = original_state(project)
        try:
            payload["assembly_source_revision"] = coverage_revision(project)
        except Exception:
            payload.setdefault("assembly_source_revision", "")
        return payload

    def capabilities_with_assembly(service: Any, agent: dict[str, Any]) -> dict[str, Any]:
        payload = original_capabilities(service, agent)
        payload["assembly_timeline"] = {
            "contract": ASSEMBLY_CONTRACT,
            "read": True,
            "write": False,
            "preview_only": True,
            "fcpxml_write": False,
        }
        return payload

    def make_handler_with_assembly(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "assembly-timeline"
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    try:
                        scene_id, episode = _filters(parsed)
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                    self._send_json(build_assembly_timeline(project, scene_id=scene_id, episode=episode))
                    return
                return super()._app_get(parsed)

            def _agent_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 6
                    and parts[:4] == ["api", "agent", "v1", "projects"]
                    and parts[5] == "assembly-timeline"
                ):
                    project_id = parts[4]
                    agent = self._agent("read", project_id)
                    project = service.project(project_id)
                    try:
                        scene_id, episode = _filters(parsed)
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                    service.tokens.audit(agent, "read:assembly-timeline", project_id)
                    self._send_json(build_assembly_timeline(project, scene_id=scene_id, episode=episode))
                    return
                return super()._agent_get(parsed)

        return Handler

    web_server.ProjectService.state = state_with_assembly
    web_server.WorkspaceService.capabilities = capabilities_with_assembly
    web_server.make_handler = make_handler_with_assembly
    _INSTALLED = True
