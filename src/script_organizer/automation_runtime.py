from __future__ import annotations

from typing import Any

from .automation_store import AutomationStore

_INSTALLED = False


def _apply(project: Any) -> dict[str, Any]:
    automation = AutomationStore(project.config.output_dir).load()
    groups = automation.get("groups", {}) if isinstance(automation.get("groups", {}), dict) else {}
    for group in project.index.get("groups", []):
        if not isinstance(group, dict):
            continue
        group_id = str(group.get("group_id", "") or "")
        if group_id in groups:
            group["automation"] = groups[group_id]
        else:
            group.pop("automation", None)
    project.groups = {
        item.get("group_id"): item
        for item in project.index.get("groups", [])
        if isinstance(item, dict)
    }
    return automation


def install_automation_runtime() -> None:
    """Attach auto-decision state without making it human review authority."""
    global _INSTALLED
    if _INSTALLED:
        return
    from . import web_server
    from .tasks import TASK_TYPES, TaskManager
    from .workspace import WorkspaceRegistry

    original_workspace_project = web_server.WorkspaceService.project
    original_project_payload = web_server.ProjectService.project_payload
    original_state = web_server.ProjectService.state
    original_capabilities = web_server.WorkspaceService.capabilities
    original_create = WorkspaceRegistry.create

    def workspace_project(service: Any, project_id: str) -> Any:
        project = original_workspace_project(service, project_id)
        # multicam_sync promotes a media-directory project.toml to its generated
        # FCPXML. WorkspaceService historically cached only by config path, so
        # explicitly refresh when those effective inputs change.
        fresh = service.registry.project_config(project_id)
        if (
            fresh.input_kind != project.config.input_kind
            or fresh.fcpxml != project.config.fcpxml
            or fresh.media_root != project.config.media_root
            or fresh.script != project.config.script
        ):
            service._projects.pop(project_id, None)
            project = original_workspace_project(service, project_id)
        _apply(project)
        return project

    def project_payload(project: Any) -> dict[str, Any]:
        payload = original_project_payload(project)
        automation = _apply(project)
        payload["automation"] = {
            "updated_at": automation.get("updated_at", ""),
            "analysis_revision": automation.get("analysis_revision", ""),
            "summary": automation.get("summary", {}),
            "model": automation.get("model", {}),
        }
        return payload

    def project_state(project: Any) -> dict[str, Any]:
        payload = original_state(project)
        automation = AutomationStore(project.config.output_dir).load()
        payload["automation_updated_at"] = automation.get("updated_at", "")
        return payload

    def capabilities(service: Any, agent: dict[str, Any]) -> dict[str, Any]:
        payload = original_capabilities(service, agent)
        payload["task_types"] = sorted(TASK_TYPES)
        return payload

    def create_and_prepare(registry: WorkspaceRegistry, payload: dict[str, Any]) -> dict[str, Any]:
        entry = original_create(registry, payload)
        manager = TaskManager(registry.project_config)
        task = manager.submit(
            str(entry["project_id"]),
            "prepare_project",
            {},
            idempotency_key=f"prepare_project:{entry['project_id']}:initial",
            actor="mirrororder-host",
        )
        result = dict(entry)
        result["prepare_task_id"] = task.get("task_id", "")
        return result

    web_server.WorkspaceService.project = workspace_project
    web_server.ProjectService.project_payload = project_payload
    web_server.ProjectService.state = project_state
    web_server.WorkspaceService.capabilities = capabilities
    WorkspaceRegistry.create = create_and_prepare
    _INSTALLED = True
