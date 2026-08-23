from __future__ import annotations

from pathlib import Path
from threading import Thread
from typing import Any

from .script_supervisor_store import (
    SUPERVISOR_CONTRACT,
    ScriptSupervisorConflictError,
    ScriptSupervisorStore,
)


_INSTALLED = False


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _safe_entry(value: object) -> dict[str, Any]:
    raw = _as_dict(value)
    if not raw:
        return {}
    usable_range = _as_dict(raw.get("usable_range"))
    angles = _as_dict(raw.get("angles"))
    return {
        "group_id": str(raw.get("group_id", "") or ""),
        "scene": str(raw.get("scene", "") or ""),
        "shot": str(raw.get("shot", "") or ""),
        "take_number": raw.get("take_number"),
        "status": str(raw.get("status", "unmarked") or "unmarked"),
        "note": str(raw.get("note", "") or ""),
        "usable_range": {
            "start": usable_range.get("start"),
            "end": usable_range.get("end"),
        } if usable_range else {},
        "preferred_clip_id": str(raw.get("preferred_clip_id", "") or ""),
        "angles": {
            str(clip_id): {
                "shot_type": str(_as_dict(row).get("shot_type", "unknown") or "unknown"),
                "note": str(_as_dict(row).get("note", "") or ""),
            }
            for clip_id, row in angles.items()
            if isinstance(row, dict)
        },
        "actor": str(raw.get("actor", "") or ""),
        "updated_at": str(raw.get("updated_at", "") or ""),
    }


def _safe_board(payload: dict[str, Any]) -> dict[str, Any]:
    entries = payload.get("entries", {}) if isinstance(payload.get("entries"), dict) else {}
    return {
        "version": int(payload.get("version", 1) or 1),
        "contract": str(payload.get("contract", SUPERVISOR_CONTRACT) or SUPERVISOR_CONTRACT),
        "revision": int(payload.get("revision", 0) or 0),
        "updated_at": str(payload.get("updated_at", "") or ""),
        "entries": {
            str(group_id): _safe_entry(row)
            for group_id, row in entries.items()
            if isinstance(row, dict)
        },
    }


def install_script_supervisor_runtime() -> None:
    """Install the shared human script-supervisor annotation layer.

    App Production is the write surface. Team Web receives only per-Take safe
    annotations through review.v1. Agent API may read the board, but there is no
    agent write route. These annotations are production evidence, not Editorial
    Decision and not a replacement for review.json placement authority.
    """

    global _INSTALLED
    if _INSTALLED:
        return

    from . import review_read_model, web_server

    original_build = review_read_model.build_review_read_model
    original_state = web_server.ProjectService.state
    original_capabilities = web_server.WorkspaceService.capabilities
    original_make_handler = web_server.make_handler

    def build_with_supervisor(project: Any, **kwargs: Any) -> dict[str, Any]:
        payload = original_build(project, **kwargs)
        board = ScriptSupervisorStore(project.config.output_dir).load()
        entries = board.get("entries", {}) if isinstance(board.get("entries"), dict) else {}
        for take in payload.get("take_groups", []):
            if not isinstance(take, dict):
                continue
            group_id = str(take.get("group_id", "") or "")
            take["script_supervisor"] = _safe_entry(entries.get(group_id))
        payload.setdefault("revisions", {})["script_supervisor"] = int(board.get("revision", 0) or 0)
        payload.setdefault("capabilities", {}).update(
            {
                "script_supervisor_v1": True,
                "script_supervisor_write_scope": "host_local",
                "script_supervisor_is_editorial_authority": False,
            }
        )
        payload.setdefault("summary", {})["script_supervisor"] = ScriptSupervisorStore(
            project.config.output_dir
        ).summary()
        return payload

    def state_with_supervisor(project: Any) -> dict[str, Any]:
        payload = original_state(project)
        store = ScriptSupervisorStore(project.config.output_dir)
        board = store.load()
        payload["script_supervisor_revision"] = int(board.get("revision", 0) or 0)
        payload["script_supervisor_updated_at"] = str(board.get("updated_at", "") or "")
        payload["script_supervisor_summary"] = store.summary()
        return payload

    def capabilities_with_supervisor(service: Any, agent: dict[str, Any]) -> dict[str, Any]:
        payload = original_capabilities(service, agent)
        payload["script_supervisor"] = {
            "contract": SUPERVISOR_CONTRACT,
            "read": True,
            "agent_write": False,
            "app_write": True,
            "editorial_authority": False,
        }
        return payload

    def make_handler_with_supervisor(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "script-supervisor"
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    self._send_json(_safe_board(ScriptSupervisorStore(project.config.output_dir).load()))
                    return
                return super()._app_get(parsed)

            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "script-supervisor"
                ):
                    self._local_only()
                    project_id = parts[3]
                    project = service.project(project_id)
                    store = ScriptSupervisorStore(project.config.output_dir)
                    body = web_server._body(self)
                    try:
                        saved = store.apply(body)
                    except ScriptSupervisorConflictError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.CONFLICT, str(error)) from error
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                    self._send_json(_safe_board(saved))

                    # Human production annotations can change rough-cut planning
                    # and assistant context. Refresh only cheap derived state;
                    # never submit expensive tasks from this write path.
                    try:
                        from .assistant_runtime import _orchestrator

                        Thread(
                            target=lambda: _orchestrator(service, project_id).cycle(
                                trigger="script-supervisor", allow_actions=False
                            ),
                            daemon=True,
                            name=f"mirror-assistant-supervisor-{project_id}",
                        ).start()
                    except Exception:
                        pass
                    return
                return super()._app_post(parsed)

            def _agent_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 6
                    and parts[:4] == ["api", "agent", "v1", "projects"]
                    and parts[5] == "script-supervisor"
                ):
                    project_id = parts[4]
                    agent = self._agent("read", project_id)
                    project = service.project(project_id)
                    service.tokens.audit(agent, "read:script-supervisor", project_id)
                    self._send_json(_safe_board(ScriptSupervisorStore(project.config.output_dir).load()))
                    return
                return super()._agent_get(parsed)

        return Handler

    review_read_model.build_review_read_model = build_with_supervisor
    web_server.ProjectService.state = state_with_supervisor
    web_server.WorkspaceService.capabilities = capabilities_with_supervisor
    web_server.make_handler = make_handler_with_supervisor
    _INSTALLED = True
