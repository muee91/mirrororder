from __future__ import annotations

import os
import re
import shutil
import tempfile
import time
import urllib.parse
from pathlib import Path
from typing import Any

from .automation_store import AutomationStore
from .device_runtime_settings import application_support_root, load_runtime_settings, save_runtime_settings
from .identity_library import IdentityLibrary
from .identity_runtime import IdentityRuntime
from .local_vision_runtime import LocalVisionRuntime, LocalVisionRuntimeConfig
from .runtime_diagnostics import environment_payload
from .workspace_db import WorkspaceDatabase

_INSTALLED = False
_SCRIPT_SUFFIXES = {".docx", ".txt", ".md", ".markdown"}
_AGENT_TASK_TYPES = {"incremental_analyze", "transcribe", "evidence_extract"}


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


def _replace_project_script(config_path: Path, raw_script: object) -> Path:
    source = Path(str(raw_script or "")).expanduser().resolve()
    if not source.is_file() or source.suffix.lower() not in _SCRIPT_SUFFIXES:
        raise ValueError("剧本必须是可读取的 DOCX、TXT 或 Markdown 文件")
    script = config_path.parent / "inputs" / f"script{source.suffix.lower()}"
    script.parent.mkdir(parents=True, exist_ok=True)
    temporary_copy = script.with_suffix(script.suffix + ".tmp")
    shutil.copy2(source, temporary_copy)
    os.replace(temporary_copy, script)
    text = config_path.read_text(encoding="utf-8")
    lines = text.splitlines()
    in_input = False
    replaced = False
    escaped = ("./inputs/" + script.name).replace("\\", "\\\\").replace('"', '\\"')
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            in_input = stripped == "[input]"
            continue
        if in_input and re.match(r"^\s*script\s*=", line):
            indent = line[: len(line) - len(line.lstrip())]
            lines[index] = f'{indent}script = "{escaped}"'
            replaced = True
            break
    if not replaced:
        raise ValueError("项目配置缺少 [input].script")

    fd, temporary = tempfile.mkstemp(prefix=config_path.name + ".", suffix=".tmp", dir=config_path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, config_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return script


def _directory_bytes(path: Path) -> int:
    total = 0
    try:
        for item in path.rglob("*"):
            if item.is_file():
                try:
                    total += item.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


def _runtime_payload() -> dict[str, Any]:
    settings = load_runtime_settings()
    runtime = LocalVisionRuntime(
        LocalVisionRuntimeConfig.from_env(str(settings.get("local_vision_model", "") or ""))
    )
    root = application_support_root() / "models"
    return {
        "local_vision_enabled": bool(settings.get("local_vision_enabled")),
        "local_vision_model": str(settings.get("local_vision_model", "") or ""),
        "face_identity_enabled": bool(settings.get("face_identity_enabled")),
        "speaker_identity_enabled": bool(settings.get("speaker_identity_enabled")),
        "identity_processing_mode": str(settings.get("identity_processing_mode", "after_prepare")),
        "vision": runtime.public(),
        "identity": IdentityRuntime.public(),
        "mlx_cache_bytes": _directory_bytes(root / "huggingface"),
        "model_root": str(root),
        "environment": environment_payload(),
    }


def _project_relative_script(project: Any) -> str:
    try:
        relative = project.config.script.resolve().relative_to(project.config.project_dir.resolve())
        return "./" + relative.as_posix()
    except (OSError, ValueError):
        return ""


def _workspace_for_service(service: Any) -> Any:
    workspace = getattr(service, "workspace", None)
    if workspace is not None:
        return workspace
    current = getattr(service, "current", None)
    if current is None:
        raise RuntimeError("请求尚未选择工作区")
    return current.workspace


def _identity_library_for(service: Any, project_id: str) -> IdentityLibrary:
    service.registry.get(project_id)
    workspace = _workspace_for_service(service)
    return IdentityLibrary(WorkspaceDatabase(workspace.workspace_id), project_id)


def _queue_identity_jobs(service: Any, kinds: list[str]) -> list[dict[str, Any]]:
    queued = []
    for entry in service.registry.list():
        project_id = str(entry.get("project_id", "") or "")
        if not project_id:
            continue
        for kind in kinds:
            try:
                task = service.tasks.submit(
                    project_id,
                    "identity_index",
                    {"kind": kind},
                    idempotency_key=f"identity-enable:{project_id}:{kind}:{time.time_ns()}",
                    actor="mirrororder-app",
                )
                queued.append({"project_id": project_id, "kind": kind, "task_id": task.get("task_id", "")})
            except Exception as error:
                queued.append({"project_id": project_id, "kind": kind, "error": str(error)})
    return queued


def install_automation_runtime() -> None:
    """Attach production automation while preserving App/Web/Agent boundaries."""
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
    original_make_handler = web_server.make_handler
    original_task_submit = TaskManager.submit

    def guarded_task_submit(
        manager: TaskManager,
        project_id: str,
        task_type: str,
        targets: dict[str, Any] | None = None,
        idempotency_key: str = "",
        actor: str = "human",
    ) -> dict[str, Any]:
        if str(actor).startswith("agent:") and task_type not in _AGENT_TASK_TYPES:
            raise ValueError("外部智能体只能提交 incremental_analyze、transcribe 或 evidence_extract")
        return original_task_submit(manager, project_id, task_type, targets, idempotency_key, actor)

    def workspace_project(service: Any, project_id: str) -> Any:
        project = original_workspace_project(service, project_id)
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
        payload["script_path"] = _project_relative_script(project)
        payload["automation"] = {
            "updated_at": automation.get("updated_at", ""),
            "analysis_revision": automation.get("analysis_revision", ""),
            "summary": automation.get("summary", {}),
            "model": automation.get("model", {}),
        }
        workspace_id = str(getattr(project, "workspace_id", "") or "")
        if workspace_id:
            try:
                review = project.review.load()
                database = WorkspaceDatabase(workspace_id)
                database.sync_project_summary(
                    project.project_id,
                    name=project.config.name,
                    input_kind=project.config.input_kind,
                    config_path=str(project.config.config_path),
                    analysis_revision=str(payload.get("analysis_revision", "") or ""),
                    review_revision=int(review.get("revision", 0) or 0),
                    stats=payload.get("stats", {}) if isinstance(payload.get("stats"), dict) else {},
                )
                payload["intelligence"] = database.project_intelligence(project.project_id)
            except Exception:
                payload["intelligence"] = {
                    "takes": 0,
                    "framed_takes": 0,
                    "semantic_takes": 0,
                    "pending_semantic": 0,
                    "face_observations": 0,
                    "speaker_observations": 0,
                }
        return payload

    def project_state(project: Any) -> dict[str, Any]:
        payload = original_state(project)
        automation = AutomationStore(project.config.output_dir).load()
        payload["automation_updated_at"] = automation.get("updated_at", "")
        return payload

    def capabilities(service: Any, agent: dict[str, Any]) -> dict[str, Any]:
        payload = original_capabilities(service, agent)
        payload["task_types"] = sorted(_AGENT_TASK_TYPES)
        return payload

    def create_and_prepare(registry: WorkspaceRegistry, payload: dict[str, Any]) -> dict[str, Any]:
        entry = original_create(registry, payload)
        manager = TaskManager(registry.project_config, registry.config.workspace_id)
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

    def make_handler_with_project_inputs(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if parts == ["api", "v1", "local-runtime"]:
                    self._local_only()
                    self._send_json(_runtime_payload())
                    return
                if parts == ["api", "v1", "workspace-database"]:
                    self._local_only()
                    workspace = _workspace_for_service(service)
                    database = WorkspaceDatabase(workspace.workspace_id)
                    health = database.health()
                    health["projects"] = {
                        str(entry.get("project_id", "")): database.project_intelligence(str(entry.get("project_id", "")))
                        for entry in service.registry.list()
                        if entry.get("project_id")
                    }
                    self._send_json(health)
                    return
                if len(parts) == 5 and parts[:3] == ["api", "v1", "projects"] and parts[4] == "identities":
                    self._local_only()
                    project_id = parts[3]
                    query = urllib.parse.parse_qs(parsed.query)
                    kind = str((query.get("kind") or [""])[0] or "")
                    library = _identity_library_for(service, project_id)
                    self._send_json({"identities": library.list(kind)})
                    return
                return super()._app_get(parsed)

            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                # Production task submission/cancellation is App-only. LAN Web
                # can still read task status and use review endpoints; future
                # team AI requests use a bounded review-analysis API instead.
                if (
                    len(parts) >= 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "tasks"
                ):
                    self._local_only()
                    return super()._app_post(parsed)
                if parts == ["api", "v1", "project-preflight"]:
                    self._local_only()
                    self._send_json(service.registry.preflight_create(web_server._body(self)))
                    return
                if parts == ["api", "v1", "local-runtime"]:
                    self._local_only()
                    payload = web_server._body(self)
                    action = str(payload.get("action", "set") or "set")
                    queued: list[dict[str, Any]] = []
                    if action == "set":
                        before = load_runtime_settings()
                        settings = save_runtime_settings(payload)
                        if not settings.get("local_vision_enabled"):
                            LocalVisionRuntime.stop()
                        if settings.get("identity_processing_mode") == "after_prepare":
                            newly_enabled = []
                            if settings.get("face_identity_enabled") and not before.get("face_identity_enabled"):
                                newly_enabled.append("face")
                            if settings.get("speaker_identity_enabled") and not before.get("speaker_identity_enabled"):
                                newly_enabled.append("speaker")
                            if newly_enabled:
                                queued = _queue_identity_jobs(service, newly_enabled)
                    elif action == "prepare":
                        settings = save_runtime_settings({
                            "local_vision_enabled": True,
                            **({"local_vision_model": payload["local_vision_model"]} if payload.get("local_vision_model") else {}),
                        })
                        runtime = LocalVisionRuntime(
                            LocalVisionRuntimeConfig.from_env(str(settings.get("local_vision_model", "") or ""))
                        )
                        if not runtime.prepare_async():
                            raise web_server.ApiError(
                                web_server.HTTPStatus.SERVICE_UNAVAILABLE,
                                runtime.public().get("last_error") or "本地视觉运行时不可用",
                            )
                    elif action == "prepare_identity":
                        kind = str(payload.get("kind", "") or "")
                        if kind not in {"face", "speaker"}:
                            raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "身份识别类型必须是 face 或 speaker")
                        save_runtime_settings({
                            "face_identity_enabled" if kind == "face" else "speaker_identity_enabled": True
                        })
                        IdentityRuntime.prepare_async(kind)
                    elif action == "stop":
                        LocalVisionRuntime.stop()
                    else:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "未知本机运行时操作")
                    response = _runtime_payload()
                    if queued:
                        response["identity_tasks"] = queued
                    self._send_json(response, web_server.HTTPStatus.ACCEPTED)
                    return
                if len(parts) == 5 and parts[:3] == ["api", "v1", "projects"] and parts[4] == "identities":
                    self._local_only()
                    project_id = parts[3]
                    payload = web_server._body(self)
                    library = _identity_library_for(service, project_id)
                    action = str(payload.get("action", "update") or "update")
                    if action == "update":
                        updated = library.update(
                            str(payload.get("identity_id", "") or ""),
                            label=str(payload.get("label", "") or ""),
                            role_name=str(payload.get("role_name", "") or ""),
                        )
                        self._send_json(updated)
                    elif action == "merge":
                        sources = payload.get("source_identity_ids", [])
                        if not isinstance(sources, list):
                            raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "source_identity_ids 必须是数组")
                        merged = library.merge(
                            str(payload.get("target_identity_id", "") or ""),
                            [str(value) for value in sources],
                        )
                        self._send_json(merged)
                    elif action == "index":
                        kind = str(payload.get("kind", "both") or "both")
                        if kind not in {"face", "speaker", "both"}:
                            raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "kind 必须是 face、speaker 或 both")
                        raw_groups = payload.get("group_ids", [])
                        if not isinstance(raw_groups, list):
                            raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "group_ids 必须是数组")
                        task = service.tasks.submit(
                            project_id,
                            "identity_index",
                            {"kind": kind, "group_ids": [str(value) for value in raw_groups if str(value)]},
                            idempotency_key=f"identity-manual:{project_id}:{kind}:{time.time_ns()}",
                            actor="mirrororder-app",
                        )
                        self._send_json({"task": task}, web_server.HTTPStatus.ACCEPTED)
                    else:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "未知身份库操作")
                    return
                if len(parts) == 5 and parts[:3] == ["api", "v1", "projects"] and parts[4] == "script":
                    self._local_only()
                    project_id = parts[3]
                    service.registry.get(project_id)
                    active = [task for task in service.tasks.list(project_id) if task.get("status") in {"queued", "running"}]
                    if active:
                        raise web_server.ApiError(web_server.HTTPStatus.CONFLICT, "当前项目仍有后台任务运行，请结束后再更换剧本")
                    payload = web_server._body(self)
                    config = service.registry.project_config(project_id)
                    script = _replace_project_script(config.config_path, payload.get("script"))
                    service._projects.pop(project_id, None)
                    stat = script.stat()
                    task = service.tasks.submit(
                        project_id,
                        "incremental_analyze",
                        {},
                        idempotency_key=f"replace_script:{project_id}:{script}:{stat.st_size}:{stat.st_mtime_ns}",
                        actor="mirrororder-host",
                    )
                    self._send_json(
                        {"project_id": project_id, "script": _project_relative_script(service.project(project_id)), "task": task},
                        web_server.HTTPStatus.ACCEPTED,
                    )
                    return
                return super()._app_post(parsed)

        return Handler

    TaskManager.submit = guarded_task_submit
    web_server.WorkspaceService.project = workspace_project
    web_server.ProjectService.project_payload = project_payload
    web_server.ProjectService.state = project_state
    web_server.WorkspaceService.capabilities = capabilities
    web_server.make_handler = make_handler_with_project_inputs
    WorkspaceRegistry.create = create_and_prepare
    _INSTALLED = True
