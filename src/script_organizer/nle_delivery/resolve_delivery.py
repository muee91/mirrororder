from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

from ..device_tasks import get_device_task_manager
from ..media_identity import DeviceMediaStore, device_state_dir
from ..multicam_sync_engine import _run
from ..resource_scheduler import GLOBAL_RESOURCE_SCHEDULER, ResourceCancelled
from ..sync_timeline_runtime import _latest_sync_task, _safe_task
from ..workspace import WorkspaceConfig, WorkspaceRegistry
from .resolve_plan import build_resolve_plan

TASK_TYPE = "resolve_delivery"
FILENAME = "原片同步母版_待转换多机位.drp"
DELIVERY_KIND = "direct_sync_timeline"


def _root() -> Path:
    return device_state_dir().resolve() / "resolve-deliveries"


def _scope(workspace_id: str, project_id: str) -> str:
    return hashlib.sha256(f"{workspace_id}\0{project_id}".encode()).hexdigest()


def task_targets(value: dict[str, Any]) -> dict[str, str]:
    request_id = str(value.get("request_id", ""))
    if not re.fullmatch(r"[0-9a-f]{32}", request_id):
        raise ValueError("Resolve 交付请求无效")
    return {"request_id": request_id}


def _deliverable(scope: str, task_id: str) -> Path:
    if not re.fullmatch(r"device_task_[0-9a-f]{32}", task_id):
        raise ValueError("Resolve 交付任务无效")
    return _root() / "projects" / scope / task_id / FILENAME


def _request_path(request_id: str) -> Path:
    checked = task_targets({"request_id": request_id})["request_id"]
    return _root() / "requests" / f"{checked}.json"


def _read_request(request_id: str) -> dict[str, Any]:
    value = json.loads(_request_path(request_id).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("Resolve 交付请求格式无效")
    return value


def submit_resolve_delivery(workspace: WorkspaceConfig, project_id: str, tasks: list[dict[str, Any]]) -> dict[str, Any]:
    sync = _latest_sync_task(tasks)
    if not sync or sync.get("status") != "completed":
        raise ValueError("请先完成该项目的多机位同步")
    sync_task_id = str(sync["task_id"])
    scope = _scope(workspace.workspace_id, project_id)
    request_id = uuid4().hex
    path = _request_path(request_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "workspace": str(workspace.config_path), "workspace_id": workspace.workspace_id,
        "project_id": project_id, "sync_task_id": sync_task_id, "scope": scope,
    }, ensure_ascii=False), encoding="utf-8")
    manager = get_device_task_manager()
    key = f"resolve:{DELIVERY_KIND}:{scope}:{sync_task_id}"
    for previous in manager.list():
        prior_key = str(previous.get("idempotency_key", ""))
        if (prior_key == key or prior_key.startswith(f"{key}:")) and previous.get("status") == "completed":
            previous_id = str(previous["task_id"])
            if not _deliverable(scope, previous_id).is_file():
                key = f"{key}:{previous_id}"
            break
    task = manager.submit(TASK_TYPE, {"request_id": request_id}, key)
    if task["targets"]["request_id"] != request_id:
        path.unlink()
    return task


def resolve_artifact(project: Any, sync: dict[str, Any] | None, ready: bool) -> dict[str, Any]:
    result: dict[str, Any] = {
        "target": "davinci", "label": "DaVinci Resolve", "format": "DRP · 原片同步母版（待手动转多机位）",
        "filename": FILENAME, "available": False, "local_path": "",
        "unavailable_reason": "not_generated" if ready else "sync_not_ready",
    }
    workspace_id = str(getattr(project, "workspace_id", "") or "")
    if not ready or not sync or not workspace_id:
        return result
    scope = _scope(workspace_id, project.project_id)
    latest = None
    for task in get_device_task_manager().list():
        if task.get("type") != TASK_TYPE:
            continue
        request_id = task.get("targets", {}).get("request_id", "")
        try:
            request = _read_request(request_id)
        except (OSError, ValueError):
            continue
        if request.get("scope") != scope or request.get("sync_task_id") != sync.get("task_id"):
            continue
        if latest is None:
            latest = _safe_task(task)
        if task.get("status") == "completed" and task.get("result", {}).get("delivery_kind") == DELIVERY_KIND:
            try:
                path = _deliverable(scope, str(task["task_id"]))
            except (KeyError, ValueError):
                continue
            if path.is_file() and path.resolve() == path:
                result.update(available=True, local_path=str(path), unavailable_reason="")
                result["details"] = task.get("result", {})
                break
    if latest:
        result["task"] = latest
    return result


def run_task(manager: Any, task_id: str, task: dict[str, Any]) -> None:
    def cancelled() -> bool:
        return manager._cancel_requested(task_id)

    def progress(message: str) -> None:
        manager._update(task_id, stage="resolve_delivery", message=message)

    try:
        if cancelled():
            raise ResourceCancelled("Resolve 交付已取消")
        manager._update(task_id, status="running", stage="starting", message="准备 Resolve 交付")
        request_id = task_targets(task["targets"])["request_id"]
        request = _read_request(request_id)
        workspace = WorkspaceConfig.from_file(request["workspace"])
        project_id = request["project_id"]
        scope = _scope(workspace.workspace_id, project_id)
        if scope != request["scope"] or workspace.workspace_id != request["workspace_id"]:
            raise ValueError("Resolve 交付请求与当前工作区不匹配")
        config = WorkspaceRegistry(workspace).project_config(project_id)
        project = SimpleNamespace(config=config, workspace_id=workspace.workspace_id, project_id=project_id)
        with GLOBAL_RESOURCE_SCHEDULER.slot("sync", project_id, task_id, cancelled=cancelled):
            tasks = json.loads((config.output_dir / "tasks.json").read_text(encoding="utf-8"))["tasks"]
            progress("核对同步版本和本机媒体")
            plan = build_resolve_plan(project, tasks, DeviceMediaStore(), cancelled)
        if plan["sync_task_id"] != request["sync_task_id"]:
            raise ValueError("同步版本已更新，请重新生成 Resolve 工程")
        plan["project_name"] = f"{config.name} · 镜序原片同步 · {task_id[-12:]}"
        with GLOBAL_RESOURCE_SCHEDULER.slot("resolve_delivery", project_id, task_id, cancelled=cancelled):
            destination = _deliverable(scope, task_id)
            destination.parent.mkdir(parents=True, exist_ok=True)
            with TemporaryDirectory(prefix=".working-", dir=destination.parent) as folder:
                private = Path(folder)
                manifest, staging, receipt = (private / name for name in ("plan.json", FILENAME, "receipt.json"))
                manifest.write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
                try:
                    _run(Path(__file__).parent, "resolve_native.py", [str(manifest), str(staging), str(receipt)],
                         progress, timeout=1200, cancel_requested=cancelled)
                except RuntimeError as error:
                    failure = next((line for line in str(error).splitlines() if line.startswith("Resolve 交付失败：")), None)
                    if failure:
                        raise ValueError(failure.removeprefix("Resolve 交付失败：")) from None
                    raise
                if cancelled():
                    raise ResourceCancelled("Resolve 交付已取消")
                result = json.loads(receipt.read_text(encoding="utf-8"))
                if (result.get("delivery_kind") != DELIVERY_KIND or result.get("native_multicam") is not False
                        or result.get("conversion_required") is not True):
                    raise ValueError("Resolve 交付回执未证明原片同步母版，请重新生成")
                (destination.parent / "原片依赖与转换说明.json").write_text(
                    json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
                staging.replace(destination)
            manager._update(task_id, status="completed", stage="completed", result=result, message="原片同步母版已生成；需在 Resolve 手动转换多机位")
    except ResourceCancelled:
        manager._update(task_id, status="cancelled", stage="cancelled", message="Resolve 交付已取消")
    except Exception as error:
        manager._update(task_id, status="failed", stage="failed", error=str(error), message="Resolve 交付失败")
