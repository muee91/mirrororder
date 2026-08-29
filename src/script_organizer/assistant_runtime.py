from __future__ import annotations

from pathlib import Path
from threading import Thread
from typing import Any

from .agent_tools import AgentToolRegistry
from .assistant_orchestrator import AssistantOrchestrator
from .assistant_store import AssistantStore
from .audit_store import AuditStore
from .learning_dataset import write_learning_dataset
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


def _assistant_snapshot(service: Any, project_id: str) -> dict[str, Any]:
    """Read assistant.v1 exactly as persisted; GET never rebuilds or saves it."""
    project = service.project(project_id)
    return AssistantStore(project.config.output_dir).load()


def _refresh_after_review(service: Any, project_id: str) -> None:
    """Cheap derived-state refresh after human review authority changes.

    This never changes review/editorial/automation. It only rebuilds the R&D
    learning projection from the latest human truth and refreshes assistant.v1.
    """
    try:
        project = service.project(project_id)
        audit = AuditStore(project.config.output_dir).load()
        if audit.get("groups"):
            write_learning_dataset(project.config, audit)
        _orchestrator(service, project_id).cycle(trigger="review", allow_actions=False)
    except Exception:
        return


def _safe_assistant(payload: dict[str, Any]) -> dict[str, Any]:
    """Team Web / external agents receive production issues, never App chat."""
    return {
        "version": int(payload.get("version", 1) or 1),
        "contract": str(payload.get("contract", "assistant.v1") or "assistant.v1"),
        "revision": int(payload.get("revision", 0) or 0),
        "updated_at": str(payload.get("updated_at", "") or ""),
        "summary": str(payload.get("summary", "") or ""),
        "items": payload.get("items", []) if isinstance(payload.get("items"), list) else [],
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
        try:
            assistant = AssistantStore(project.config.output_dir).load()
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
            "tools": sorted(AgentToolRegistry.SAFE_ACTIONS),
        }
        payload["agent_api"] = {
            "contract": "agent.v1",
            "project_route": "/api/agent/v1/projects/{project_id}",
            "scopes": ["read", "analyze", "propose"],
        }
        return payload

    def update_with_assistant(
        manager: Any,
        config: Any,
        task_id: str,
        status: str | None = None,
        stage: str | None = None,
        progress: dict[str, Any] | None = None,
        result: dict[str, Any] | None = None,
        error: str = "",
        message: str = "",
    ) -> None:
        original_update(
            manager,
            config,
            task_id,
            status=status,
            stage=stage,
            progress=progress,
            result=result,
            error=error,
            message=message,
        )
        if status != "completed":
            return
        try:
            task = manager._task(manager._load(config), task_id)
        except Exception:
            return
        task_type = str(task.get("type", "") or "")
        if task_type not in _TRIGGER_TASKS:
            return
        project_id = str(task.get("project_id", "") or "")
        workspace_id = str(getattr(manager, "workspace_id", "") or "")
        if not project_id or not workspace_id:
            return

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

    def make_handler_with_assistant(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if len(parts) >= 5 and parts[:3] == ["api", "v1", "projects"] and parts[4] == "assistant":
                    project_id = parts[3]
                    if len(parts) == 5:
                        payload = _assistant_snapshot(service, project_id)
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

                review_write = (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "review"
                )
                proposal_apply = (
                    len(parts) == 6
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4:] == ["proposals", "apply"]
                )
                if review_write or proposal_apply:
                    project_id = parts[3]
                    result = super()._app_post(parsed)
                    Thread(
                        target=_refresh_after_review,
                        args=(service, project_id),
                        daemon=True,
                        name=f"mirror-assistant-review-{project_id}",
                    ).start()
                    return result
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
                    payload = _safe_assistant(_assistant_snapshot(service, project_id))
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
