from __future__ import annotations

import urllib.parse
from pathlib import Path
from typing import Any

from .coverage_graph import COVERAGE_CONTRACT, build_coverage_graph, continuity_risks, coverage_revision


_INSTALLED = False


def _filters(parsed: Any) -> tuple[str | None, int | None]:
    query = urllib.parse.parse_qs(parsed.query)
    scene_id = str((query.get("scene_id") or [""])[0] or "").strip() or None
    raw_episode = str((query.get("episode") or [""])[0] or "").strip()
    if not raw_episode:
        return scene_id, None
    try:
        episode = int(raw_episode)
    except ValueError as error:
        raise ValueError("episode 必须是整数") from error
    if episode <= 0 or episode > 9999:
        raise ValueError("episode 必须是正整数")
    return scene_id, episode


def install_coverage_runtime() -> None:
    """Install read-only scene coverage/continuity projection.

    Coverage is a Production planning read model. App access is Host-local;
    external agents may read it with the existing read scope. There is no write
    route, and Editorial Decision remains annotation rather than delivery state.
    """

    global _INSTALLED
    if _INSTALLED:
        return

    from . import web_server

    original_state = web_server.ProjectService.state
    original_capabilities = web_server.WorkspaceService.capabilities
    original_make_handler = web_server.make_handler

    def state_with_coverage(project: Any) -> dict[str, Any]:
        payload = original_state(project)
        try:
            payload["coverage_revision"] = coverage_revision(project)
        except Exception:
            payload.setdefault("coverage_revision", "")
        return payload

    def capabilities_with_coverage(service: Any, agent: dict[str, Any]) -> dict[str, Any]:
        payload = original_capabilities(service, agent)
        payload["coverage"] = {
            "contract": COVERAGE_CONTRACT,
            "read": True,
            "write": False,
            "continuity": True,
            "delivery_authority": False,
        }
        return payload

    def make_handler_with_coverage(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] in {"coverage", "continuity"}
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    try:
                        scene_id, episode = _filters(parsed)
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                    graph = build_coverage_graph(project, scene_id=scene_id, episode=episode)
                    if parts[4] == "continuity":
                        self._send_json(
                            {
                                "contract": "continuity.v1",
                                "coverage_revision": graph["revision"],
                                "project_id": graph["project_id"],
                                "filters": graph["filters"],
                                "risks": continuity_risks(graph),
                            }
                        )
                    else:
                        self._send_json(graph)
                    return
                return super()._app_get(parsed)

            def _agent_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 6
                    and parts[:4] == ["api", "agent", "v1", "projects"]
                    and parts[5] in {"coverage", "continuity"}
                ):
                    project_id = parts[4]
                    agent = self._agent("read", project_id)
                    project = service.project(project_id)
                    try:
                        scene_id, episode = _filters(parsed)
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                    graph = build_coverage_graph(project, scene_id=scene_id, episode=episode)
                    if parts[5] == "continuity":
                        response = {
                            "contract": "continuity.v1",
                            "coverage_revision": graph["revision"],
                            "project_id": graph["project_id"],
                            "filters": graph["filters"],
                            "risks": continuity_risks(graph),
                        }
                    else:
                        response = graph
                    service.tokens.audit(agent, "read:" + parts[5], project_id)
                    self._send_json(response)
                    return
                return super()._agent_get(parsed)

        return Handler

    web_server.ProjectService.state = state_with_coverage
    web_server.WorkspaceService.capabilities = capabilities_with_coverage
    web_server.make_handler = make_handler_with_coverage
    _INSTALLED = True
