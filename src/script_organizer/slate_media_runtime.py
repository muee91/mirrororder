from __future__ import annotations

from pathlib import Path
from typing import Any

from .media_identity import MEDIA_SUFFIXES, DeviceMediaStore, media_id_for_path
from .media_reader import infer_camera_label
from .media_role_store import MediaRoleStore

_INSTALLED = False
_MAX_DROP_FILES = 32


def _indexed_media(project: Any) -> dict[str, dict[str, str]]:
    rows: dict[str, dict[str, str]] = {}

    def add(value: object) -> None:
        if not isinstance(value, dict):
            return
        media_id = str(value.get("media_id", "") or "")
        if not media_id:
            return
        clip_id = str(value.get("clip_id", "") or "")
        current = rows.setdefault(
            media_id,
            {
                "clip_id": clip_id,
                "camera": str(value.get("camera", "") or "")[:40],
                "display_name": Path(str(value.get("source_media_path", "") or value.get("media_path", "") or value.get("name", "") or media_id)).name[:300],
            },
        )
        if not current.get("clip_id") and clip_id:
            current["clip_id"] = clip_id

    for clip in project.index.get("clips", []):
        add(clip)
    for group in project.index.get("groups", []):
        if not isinstance(group, dict):
            continue
        for member in group.get("members", []):
            add(member)
    return rows


def _bind_verified_drop(store: DeviceMediaStore, workspace_id: str, project_id: str, media_id: str, path: Path) -> None:
    """Bind one explicit content-verified drop outside shared project state."""
    if not media_id.startswith("M_"):
        raise ValueError("拖入素材必须具有内容 media_id")
    payload = store.load()
    workspaces = payload.setdefault("workspaces", {})
    workspace = workspaces.setdefault(workspace_id, {"projects": {}})
    projects = workspace.setdefault("projects", {})
    project = projects.setdefault(project_id, store._empty_project())
    project.setdefault("roots", [])
    project.setdefault("candidates", {})
    project.setdefault("confirmed_provisional", {})
    project.setdefault("bindings", {})[media_id] = str(path.resolve())
    store._save(payload)


def _safe_drop_item(project: Any, store: DeviceMediaStore, path_text: str) -> dict[str, Any]:
    path = Path(str(path_text or "")).expanduser()
    if not path.is_file():
        raise ValueError("拖入素材不存在或不是文件")
    if path.suffix.lower() not in MEDIA_SUFFIXES:
        raise ValueError(f"不支持的素材格式：{path.suffix or path.name}")
    media_id = media_id_for_path(path)
    if not media_id:
        raise ValueError("无法建立拖入素材的内容 identity")

    workspace_id = str(getattr(project, "workspace_id", "") or "")
    if not workspace_id:
        raise ValueError("当前项目缺少 workspace_id")
    project_id = str(project.project_id)
    _bind_verified_drop(store, workspace_id, project_id, media_id, path)

    indexed = _indexed_media(project).get(media_id, {})
    role = MediaRoleStore(project.config.output_dir).for_media(media_id)
    camera = str(role.get("camera_override", "") or indexed.get("camera", "") or infer_camera_label(path, project.config.camera_patterns) or "")[:40]
    display_name = Path(str(role.get("display_name", "") or indexed.get("display_name", "") or path.name)).name[:300]
    source_role = str(role.get("source_role", "sync_camera") or "sync_camera")[:40]

    return {
        "media_id": media_id,
        "clip_id": str(indexed.get("clip_id", "") or "")[:160],
        "camera": camera,
        "display_name": display_name,
        "source_role": source_role,
        "indexed": bool(indexed),
    }


def install_slate_media_runtime() -> None:
    """Install explicit Finder/Explorer drop resolution for Slate.

    This is a write-like local action, never a GET/read-path operation. Device
    paths are consumed only to establish one verified media identity and are
    persisted only in the device-local binding store. Responses and shared
    Slate records remain path-free.
    """
    global _INSTALLED
    if _INSTALLED:
        return

    from . import web_server

    original_make_handler = web_server.make_handler

    def make_handler_with_slate_media(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "slate-media-resolve"
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    body = web_server._body(self)
                    raw_paths = body.get("paths", []) if isinstance(body.get("paths"), list) else []
                    paths = [str(value) for value in raw_paths if str(value).strip()][: _MAX_DROP_FILES + 1]
                    if not paths:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "拖入素材不能为空")
                    if len(paths) > _MAX_DROP_FILES:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, f"单次最多拖入 {_MAX_DROP_FILES} 个素材")
                    store = DeviceMediaStore()
                    items: list[dict[str, Any]] = []
                    errors: list[dict[str, str]] = []
                    for path_text in paths:
                        try:
                            items.append(_safe_drop_item(project, store, path_text))
                        except ValueError as error:
                            errors.append({"name": Path(path_text).name[:300], "error": str(error)[:500]})
                    if not items:
                        raise web_server.ApiError(
                            web_server.HTTPStatus.BAD_REQUEST,
                            errors[0]["error"] if errors else "没有可用的拖入素材",
                        )
                    self._send_json(
                        {
                            "contract": "slate_media_resolve.v1",
                            "project_id": project.project_id,
                            "items": items,
                            "errors": errors,
                            "semantics": {
                                "explicit_device_action": True,
                                "device_paths_exposed": False,
                                "shared_identity": "media_id",
                                "writes_slate_record": False,
                                "editorial_authority": False,
                            },
                        }
                    )
                    return
                return super()._app_post(parsed)

        return Handler

    web_server.make_handler = make_handler_with_slate_media
    _INSTALLED = True


__all__ = ["install_slate_media_runtime"]
