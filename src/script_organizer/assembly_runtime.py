from __future__ import annotations

from pathlib import Path
from typing import Any

from . import coverage_runtime
from .assembly_timeline import ASSEMBLY_CONTRACT, build_assembly_timeline
from .coverage_graph import coverage_revision
from .coverage_runtime import _filters
from .sync_timeline_runtime import (
    apply_sync_manual_offset,
    build_sync_delivery_artifacts,
    build_sync_timeline,
    sync_timeline_cache_key,
    undo_sync_manual_offset,
)


_INSTALLED = False
_BOUND_BUILD_SYNC_TIMELINE = build_sync_timeline


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
            revision = payload.get("coverage_revision")
            if not (isinstance(revision, str) and revision and coverage_revision is coverage_runtime.coverage_revision):
                revision = coverage_revision(project)
            payload["assembly_source_revision"] = revision
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
        sync_cache = web_server._JsonResponseCache()

        class Handler(BaseHandler):
            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if len(parts) == 5 and parts[:3] == ["api", "v1", "projects"] and parts[4] == "resolve-delivery":
                    self._local_only()
                    web_server._body(self)
                    from .desktop_runtime import _current_service
                    from .nle_delivery.resolve_delivery import submit_resolve_delivery

                    current = _current_service(service)
                    project = current.project(parts[3])
                    try:
                        task = submit_resolve_delivery(current.workspace, project.project_id, current.tasks.list(project.project_id))
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.CONFLICT, str(error)) from error
                    self._send_json(task, web_server.HTTPStatus.ACCEPTED)
                    return
                if len(parts) == 5 and parts[:3] == ["api", "v1", "projects"] and parts[4] == "sync-offsets":
                    self._local_only()
                    body = web_server._body(self)
                    project = service.project(parts[3])
                    try:
                        updated = apply_sync_manual_offset(project, service.tasks.list(parts[3]), body)
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.CONFLICT, str(error)) from error
                    self._send_json(updated)
                    return
                if len(parts) == 6 and parts[:3] == ["api", "v1", "projects"] and parts[4:] == ["sync-offsets", "undo"]:
                    self._local_only()
                    body = web_server._body(self)
                    project = service.project(parts[3])
                    try:
                        updated = undo_sync_manual_offset(project, service.tasks.list(parts[3]), body)
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.CONFLICT, str(error)) from error
                    self._send_json(updated)
                    return
                if len(parts) == 5 and parts[:3] == ["api", "v1", "projects"] and parts[4] == "sync-delivery-enriched":
                    self._local_only()
                    body = web_server._body(self)
                    project = service.project(parts[3])
                    from .nle_delivery.delivery_markers import build_enriched_sync_fcpxml_bundle

                    try:
                        manifest = build_enriched_sync_fcpxml_bundle(project, service.tasks.list(parts[3]), body)
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.CONFLICT, str(error)) from error
                    self._send_json(manifest)
                    return
                return super()._app_post(parsed)

            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "sync-timeline"
                ):
                    self._local_only()
                    project_id = parts[3]
                    project = service.project(project_id)
                    tasks = service.tasks.list(project_id)
                    self._send_json_bytes(sync_cache.render(
                        lambda: sync_timeline_cache_key(project_id, project, tasks)
                        if build_sync_timeline is _BOUND_BUILD_SYNC_TIMELINE else None,
                        lambda: build_sync_timeline(project, tasks),
                    ))
                    return
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "sync-delivery-artifacts"
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    self._send_json(build_sync_delivery_artifacts(project, service.tasks.list(parts[3])))
                    return
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
                    and parts[5] == "sync-timeline"
                ):
                    project_id = parts[4]
                    agent = self._agent("read", project_id)
                    project = service.project(project_id)
                    service.tokens.audit(agent, "read:sync-timeline", project_id)
                    self._send_json(build_sync_timeline(project, service.tasks.list(project_id)))
                    return
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
