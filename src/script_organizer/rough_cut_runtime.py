from __future__ import annotations

from pathlib import Path
from typing import Any

from .coverage_runtime import _filters
from .rough_cut_plan import ROUGH_CUT_CONTRACT, build_rough_cut_plan


_INSTALLED = False


def install_rough_cut_runtime() -> None:
    """Expose rough_cut_plan.v1 without creating any delivery write path."""

    global _INSTALLED
    if _INSTALLED:
        return

    from . import web_server

    original_capabilities = web_server.WorkspaceService.capabilities
    original_make_handler = web_server.make_handler

    def capabilities_with_rough_cut(service: Any, agent: dict[str, Any]) -> dict[str, Any]:
        payload = original_capabilities(service, agent)
        payload["rough_cut_plan"] = {
            "contract": ROUGH_CUT_CONTRACT,
            "read": True,
            "write": False,
            "timeline_write": False,
            "fcpxml_write": False,
        }
        return payload

    def make_handler_with_rough_cut(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "rough-cut-plan"
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    try:
                        scene_id, episode = _filters(parsed)
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                    self._send_json(build_rough_cut_plan(project, scene_id=scene_id, episode=episode))
                    return
                return super()._app_get(parsed)

            def _agent_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 6
                    and parts[:4] == ["api", "agent", "v1", "projects"]
                    and parts[5] == "rough-cut-plan"
                ):
                    project_id = parts[4]
                    agent = self._agent("read", project_id)
                    project = service.project(project_id)
                    try:
                        scene_id, episode = _filters(parsed)
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                    response = build_rough_cut_plan(project, scene_id=scene_id, episode=episode)
                    service.tokens.audit(agent, "read:rough-cut-plan", project_id)
                    self._send_json(response)
                    return
                return super()._agent_get(parsed)

        return Handler

    web_server.WorkspaceService.capabilities = capabilities_with_rough_cut
    web_server.make_handler = make_handler_with_rough_cut
    _INSTALLED = True
