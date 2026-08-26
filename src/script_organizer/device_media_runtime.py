from __future__ import annotations

from typing import Any

from .media_identity import DeviceMediaStore, iter_project_media

_INSTALLED = False


def _decorate_member(store: DeviceMediaStore, snapshot: dict[str, Any], item: dict[str, Any]) -> None:
    source_path = str(item.get("source_media_path", "") or item.get("media_path", "") or "")
    if source_path:
        item["source_media_path"] = source_path
    lookup = dict(item)
    lookup["media_path"] = source_path
    resolved = store.resolve_from_snapshot(snapshot, lookup)
    item["resolved_media_path"] = resolved
    item["local_exists"] = bool(resolved)
    item["media_path"] = resolved or source_path
    item["exists"] = bool(resolved)


def _apply_project(store: DeviceMediaStore, project: Any, workspace_id: str) -> None:
    snapshot = store.project_snapshot(workspace_id, project.project_id)
    for clip in project.index.get("clips", []):
        if isinstance(clip, dict):
            _decorate_member(store, snapshot, clip)
    for group in project.index.get("groups", []):
        if not isinstance(group, dict):
            continue
        for member in group.get("members", []):
            if isinstance(member, dict):
                _decorate_member(store, snapshot, member)
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


def _attach_project_media_runtime(store: DeviceMediaStore, project: Any, workspace_id: str) -> None:
    """Attach lazy device-media resolution without scanning every media file.

    The project index can contain hundreds of large files. Resolving every
    content identity while constructing a project blocks the first review
    projection, especially when the media lives on an external volume. The
    playback boundary still calls ``resolve_media_path`` and performs the
    exact media_id check for the one clip being opened.
    """
    project._device_media_store = store
    project._device_media_workspace_id = workspace_id


def _resolve_project_media_path(project: Any, clip: dict[str, Any]) -> str:
    store = getattr(project, "_device_media_store", None)
    workspace_id = str(getattr(project, "_device_media_workspace_id", "") or "")
    if not isinstance(store, DeviceMediaStore) or not workspace_id:
        return str(clip.get("media_path", "") or "")
    source_path = str(clip.get("source_media_path", "") or clip.get("media_path", "") or "")
    lookup = dict(clip)
    lookup["media_path"] = source_path
    snapshot = store.project_snapshot(workspace_id, str(project.project_id))
    return store.resolve_from_snapshot(snapshot, lookup)


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
        workspace_id = str(getattr(project, "workspace_id", "") or "")
        if workspace_id:
            _attach_project_media_runtime(store, project, workspace_id)

    def workspace_project_with_local_media(service: Any, project_id: str) -> Any:
        project = original_workspace_project(service, project_id)
        project.workspace_id = service.workspace.workspace_id
        _attach_project_media_runtime(store, project, service.workspace.workspace_id)
        return project

    def payload_with_local_media(project: Any) -> dict[str, Any]:
        payload = original_payload(project)
        workspace_id = str(getattr(project, "workspace_id", "") or "")
        if not workspace_id:
            return payload
        # Keep project/review-model first paint bounded. The explicit
        # ``media-status`` command remains the full verification surface;
        # playback resolves and verifies one clip on demand.
        snapshot = store.project_snapshot(workspace_id, project.project_id)
        device_payload = store.load()
        payload["local_media"] = {
            "device_id": device_payload.get("device_id", ""),
            "device_name": device_payload.get("device_name", ""),
            "roots": snapshot["roots"],
            "total": len(iter_project_media(project.index)),
            "verification": "on-demand",
        }
        return payload

    def resolve_media_path(project: Any, clip: dict[str, Any]) -> str:
        return _resolve_project_media_path(project, clip)

    web_server.ProjectService.reload = reload_with_local_media
    web_server.ProjectService.project_payload = payload_with_local_media
    web_server.ProjectService.resolve_media_path = resolve_media_path
    web_server.WorkspaceService.project = workspace_project_with_local_media
    _INSTALLED = True
