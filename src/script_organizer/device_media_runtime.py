from __future__ import annotations

from typing import Any

from .media_identity import DeviceMediaStore

_INSTALLED = False


def _decorate_member(store: DeviceMediaStore, project_id: str, item: dict[str, Any]) -> None:
    source_path = str(item.get("source_media_path", "") or item.get("media_path", "") or "")
    if source_path:
        item["source_media_path"] = source_path
    lookup = dict(item)
    lookup["media_path"] = source_path
    resolved = store.resolve(project_id, lookup)
    item["resolved_media_path"] = resolved
    item["local_exists"] = bool(resolved)
    item["media_path"] = resolved or source_path
    item["exists"] = bool(resolved)


def _apply_project(store: DeviceMediaStore, project: Any) -> None:
    for clip in project.index.get("clips", []):
        if isinstance(clip, dict):
            _decorate_member(store, project.project_id, clip)
    for group in project.index.get("groups", []):
        if not isinstance(group, dict):
            continue
        for member in group.get("members", []):
            if isinstance(member, dict):
                _decorate_member(store, project.project_id, member)
    project.clips = {
        item.get("clip_id"): item
        for item in project.index.get("clips", [])
        if isinstance(item, dict)
    }
    project.groups = {
        item.get("group_id"): item
        for item in project.index.get("groups", [])
        if isinstance(item, dict)
    }


def install_device_media_runtime() -> None:
    """Patch runtime paths while leaving synchronized project files untouched."""
    global _INSTALLED
    if _INSTALLED:
        return
    from . import web_server

    original_reload = web_server.ProjectService.reload
    original_payload = web_server.ProjectService.project_payload
    original_workspace_project = web_server.WorkspaceService.project
    store = DeviceMediaStore()

    def reload_with_local_media(project: Any) -> None:
        original_reload(project)
        _apply_project(store, project)

    def workspace_project_with_local_media(service: Any, project_id: str) -> Any:
        project = original_workspace_project(service, project_id)
        # The binding file is device-local and can change while shared analysis
        # files remain byte-identical. Refresh on every API access so media GET,
        # groups and project metadata all see a just-completed scan immediately.
        _apply_project(store, project)
        return project

    def payload_with_local_media(project: Any) -> dict[str, Any]:
        payload = original_payload(project)
        _apply_project(store, project)
        summary = store.summary(project.project_id, project.index)
        payload["local_media"] = {
            key: summary[key]
            for key in ("device_id", "device_name", "roots", "total", "resolved", "missing")
        }
        return payload

    web_server.ProjectService.reload = reload_with_local_media
    web_server.ProjectService.project_payload = payload_with_local_media
    web_server.WorkspaceService.project = workspace_project_with_local_media
    _INSTALLED = True
