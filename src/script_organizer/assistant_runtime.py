from __future__ import annotations

from pathlib import Path
from threading import Thread
from typing import Any

from .assistant_orchestrator import AssistantOrchestrator
from .model_connections import load_model_connections, save_model_connections
from .model_registry import ModelRegistry


_INSTALLED = False
_TRIGGER_TASKS = {
    "prepare_project",
    "incremental_analyze",
    "auto_resolve",
    "transcribe",
    "audit",
    "identity_index",
    "evidence_extract",
}


def _workspace_for_service(service: Any) -> Any:
    workspace = getattr(service, "workspace", None)
    if workspace is not None:
        return workspace
    current = getattr(service, "current", None)
    if current is None:
        raise RuntimeError("请求尚未选择工作区")
    return current.workspace


def _orchestrator(service: Any, project_id: str) -> AssistantOrchestrator:
    project = service.project(project_id)
    workspace = _workspace_for_service(service)
    return AssistantOrchestrator(
        workspace.workspace_id,
        project_id,
        project.config,
        task_manager=service.tasks,
    )


def _safe_assistant(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": int(payload.get("version", 1) or 1),
        "contract": str(payload.get("contract", "assistant.v1") or "assistant.v1"),
        "revision": int(payload.get("revision", 0) or 0),
        "updated_at": str(payload.get("updated_at", "") or ""),
        "summary": str(payload.get("summary", "") or ""),
        "items": payload.get("items", []) if isinstance(payload.get("items"), list) else [],
        "messages": payload.get("messages", []) if isinstance(payload.get("messages"), list) else [],
    }


def install_assistant_runtime() -> None:
    """Install the first-party MirrorOrder assistant control plane.

    Native App may run cycles, inspect model status and ask the assistant. Team
    Web only consumes the sanitized assistant queue. External agents use the
    existing Bearer-scoped agent.v1 API and still cannot write review authority.
    """

    global _INSTALLED
    if _INSTALLED:
        return

    from . import tasks as tasks_module, web_server

    original_state = web_server.ProjectService.state
    original_capabilities = web_server.WorkspaceService.capabilities
    original_make_handler = web_server.make_handler
    original_update = tasks_module.TaskManager._update

    def state_with_assistant(project: Any) -> dict[str, Any]:
        payload = original_state(project)
        workspace_id = str(getattr(project, "workspace_id", "") or "")
        if workspace_id:
            try:
                assistant = AssistantOrchestrator(workspace_id, project.project_id, project.config).status()
                payload["assistant_revision"] = int(assistant.get("revision", 0) or 0)
                payload["assistant_updated_at"] = str(assistant.get("updated_at", "") or "")
                payload["assistant_attention"] = sum(
                    1 for item in assistant.get("items", [])
                    if isinstance(item, dict) and int(item.get("priority", 0) or 0) >= 80
                )
            except Exception:
                payload.setdefault("assistant_revision", 0)
        return payload

    def capabilities_with_assistant(service: Any, agent: dict[str, Any]) -> dict[str, Any]:
        payload = original_capabilities(service, agent)
        payload["assistant"] = {
            "contract": "assistant.v1",
            "orchestrator": True,
            "read": True,
            "request_cycle": "analyze" in set(agent.get("scopes", [])),
            "direct_review_write": False,
            "tools": ["run_priority_audit", "collect_learning_cases", "noop"],
        }
        payload["agent_api"] = {
            "contract": "agent.v1",
            "project_route": "/api/agent/v1/projects/{project_id}",
            "scopes": ["read", "analyze", "propose"],
        }
        return payload

    def update_with_assistant(manager: Any, config: Any, task_id: str, **changes: Any) -> Any:
        result = original_update(manager, config, task_id, **changes)
        status = str(changes.get("status", "") or "")
        if status != "completed":
            return result
        try:
            task = manager._task(manager._load(config), task_id)
        except Exception:
            return result
        task_type = str(task.get("type", "") or "")
        if task_type not in _TRIGGER_TASKS:
            return result
        project_id = str(task.get("project_id", "") or "")
        workspace_id = str(getattr(manager, "workspace_id", "") or "")
        if not project_id or not workspace_id:
            return result

        def reconcile() -> None:
            try:
                AssistantOrchestrator(
                    workspace_id,
                    project_id,
                    config,
                    task_manager=manager,
                ).cycle(
                    trigger=f"task:{task_type}",
                    allow_actions=task_type in {"prepare_project", "incremental_analyze", "auto_resolve", "transcribe"},
                )
            except Exception:
                return

        Thread(target=reconcile, daemon=True, name=f"mirror-assistant-{project_id}").start()
        return result

    def make_handler_with_assistant(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if len(parts) >= 5 and parts[:3] == ["api", "v1", "projects"] and parts[4] == "assistant":
                    project_id = parts[3]
                    assistant = _orchestrator(service, project_id)
                    if len(parts) == 5:
                        payload = assistant.status()
                        if self.client_address[0] not in {"127.0.0.1", "::1"}:
                            payload = _safe_assistant(payload)
                        self._send_json(payload)
                        return
                    if len(parts) == 6 and parts[5] == "models":
                        self._local_only()
                        self._send_json(
                            {
                                "models": ModelRegistry().public(),
                                "connections": load_model_connections(include_secrets=False),
                                "agent_api": {
                                    "contract": "agent.v1",
                                    "base": f"/api/agent/v1/projects/{project_id}",
                                    "capabilities": "/api/agent/v1/capabilities",
                                },
                            }
                        )
                        return
                return super()._app_get(parsed)

            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if len(parts) == 6 and parts[:3] == ["api", "v1", "projects"] and parts[4] == "assistant":
                    self._local_only()
                    project_id = parts[3]
                    body = web_server._body(self)
                    if parts[5] == "models":
                        saved = save_model_connections(body)
                        self._send_json(
                            {
                                "connections": saved,
                                "models": ModelRegistry().public(),
                            }
                        )
                        return
                    assistant = _orchestrator(service, project_id)
                    if parts[5] == "cycle":
                        payload = assistant.cycle(
                            trigger="app",
                            allow_actions=True,
                            force_plan=bool(body.get("force_plan", False)),
                        )
                        self._send_json(payload)
                        return
                    if parts[5] == "message":
                        self._send_json(assistant.answer(str(body.get("message", "") or "")))
                        return
                return super()._app_post(parsed)

            def _agent_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 6
                    and parts[:4] == ["api", "agent", "v1", "projects"]
                    and parts[5] == "assistant"
                ):
                    project_id = parts[4]
                    agent = self._agent("read", project_id)
                    payload = _safe_assistant(_orchestrator(service, project_id).status())
                    service.tokens.audit(agent, "read:assistant", project_id)
                    self._send_json(payload)
                    return
                return super()._agent_get(parsed)

            def _agent_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 7
                    and parts[:4] == ["api", "agent", "v1", "projects"]
                    and parts[5:] == ["assistant", "cycle"]
                ):
                    project_id = parts[4]
                    agent = self._agent("analyze", project_id)
                    payload = _orchestrator(service, project_id).cycle(
                        trigger="agent",
                        allow_actions=True,
                        force_plan=False,
                    )
                    service.tokens.audit(agent, "analyze:assistant-cycle", project_id)
                    self._send_json(_safe_assistant(payload), web_server.HTTPStatus.ACCEPTED)
                    return
                return super()._agent_post(parsed)

        return Handler

    web_server.ProjectService.state = state_with_assistant
    web_server.WorkspaceService.capabilities = capabilities_with_assistant
    web_server.make_handler = make_handler_with_assistant
    tasks_module.TaskManager._update = update_with_assistant
    _INSTALLED = True
