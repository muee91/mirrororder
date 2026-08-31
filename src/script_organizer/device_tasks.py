from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock, Thread
from typing import Any
from uuid import uuid4

from .device_runtime_settings import application_support_root
from .identity_runtime import IdentityPreparationCancelled, IdentityRuntime
from .local_vision_runtime import LocalVisionRuntime, LocalVisionRuntimeConfig


DEVICE_TASK_TYPES = {"local_vision_prepare", "identity_runtime_prepare"}
PROCESS_RUNNER_ID = "device_host_" + uuid4().hex
_WINDOWS_ABSOLUTE = re.compile(r"^[A-Za-z]:[\\/]")
_MANAGER: DeviceTaskManager | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _read_json(path: Path, fallback: object) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _logical_model(value: object) -> str:
    model = str(value or "").strip()[:300]
    if not model:
        raise ValueError("本地视觉任务缺少 model")
    if model.startswith(("/", "~")) or _WINDOWS_ABSOLUTE.match(model):
        raise ValueError("device task model 必须是逻辑模型 ID，不能是设备绝对路径")
    return model


def _targets(task_type: str, raw: object) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    if task_type == "local_vision_prepare":
        return {"model": _logical_model(source.get("model"))}
    if task_type == "identity_runtime_prepare":
        kind = str(source.get("kind", "") or "").strip().lower()
        if kind not in {"face", "speaker"}:
            raise ValueError("identity runtime task kind 必须是 face 或 speaker")
        return {"kind": kind}
    raise ValueError("不支持的 device task 类型")


class DeviceTaskManager:
    """Persistent device-scope jobs for model/runtime preparation.

    These tasks are intentionally separate from project `tasks.json`: model
    caches and optional native runtimes belong to the current device, not to an
    arbitrary production project. Task targets remain path-free so the durable
    record can never become a second device-path registry.
    """

    _lock = RLock()

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or application_support_root() / "tasks" / "device-tasks.json"
        self._threads: dict[str, Thread] = {}

    def _load(self) -> dict[str, Any]:
        raw = _read_json(self.path, {"version": 1, "tasks": []})
        if not isinstance(raw, dict) or not isinstance(raw.get("tasks"), list):
            return {"version": 1, "tasks": []}
        return {"version": 1, "tasks": [task for task in raw["tasks"] if isinstance(task, dict)]}

    def _save(self, payload: dict[str, Any]) -> None:
        _write_json(self.path, {"version": 1, "tasks": payload.get("tasks", [])})

    @staticmethod
    def _task(payload: dict[str, Any], task_id: str) -> dict[str, Any]:
        for task in payload.get("tasks", []):
            if isinstance(task, dict) and task.get("task_id") == task_id:
                return task
        raise KeyError(task_id)

    def recover_interrupted(self) -> None:
        """Run once at Host runtime install; ordinary list/GET remains read-only."""
        with self._lock:
            payload = self._load()
            changed = False
            for task in payload["tasks"]:
                if task.get("status") in {"queued", "running"} and task.get("runner_id") != PROCESS_RUNNER_ID:
                    task["status"] = "interrupted"
                    task["stage"] = "interrupted"
                    task["completed_at"] = task.get("completed_at") or _now()
                    task["interrupted_at"] = task.get("interrupted_at") or _now()
                    task.setdefault("logs", []).append("Host 已重启；设备任务标记为 interrupted，可从状态中心重试")
                    changed = True
            if changed:
                self._save(payload)

    def list(self) -> list[dict[str, Any]]:
        """Snapshot-only read for Status Center."""
        return list(reversed(self._load()["tasks"]))

    def submit(
        self,
        task_type: str,
        targets: dict[str, Any] | None = None,
        idempotency_key: str = "",
        actor: str = "desktop",
    ) -> dict[str, Any]:
        if task_type not in DEVICE_TASK_TYPES:
            raise ValueError("不支持的 device task 类型")
        normalized = _targets(task_type, targets)
        canonical = json.dumps({"type": task_type, "targets": normalized}, ensure_ascii=False, sort_keys=True)
        key = str(idempotency_key or "").strip() or hashlib.sha1(canonical.encode("utf-8")).hexdigest()
        with self._lock:
            payload = self._load()
            for task in payload["tasks"]:
                if task.get("idempotency_key") == key and task.get("status") in {"queued", "running"}:
                    return dict(task)
            task = {
                "task_id": "device_task_" + uuid4().hex,
                "scope": "device",
                "project_id": "",
                "type": task_type,
                "targets": normalized,
                "affected_group_ids": [],
                "idempotency_key": key,
                "runner_id": PROCESS_RUNNER_ID,
                "status": "queued",
                "stage": "queued",
                "progress": {},
                "actor": str(actor or "desktop")[:80],
                "created_at": _now(),
                "started_at": "",
                "completed_at": "",
                "error": "",
                "result": {},
                "logs": ["设备任务已排队"],
            }
            payload["tasks"].append(task)
            self._save(payload)
            thread = Thread(target=self._run, args=(task["task_id"],), daemon=True, name=task["task_id"])
            self._threads[task["task_id"]] = thread
            thread.start()
            return dict(task)

    def cancel(self, task_id: str) -> dict[str, Any]:
        stop_vision = False
        with self._lock:
            payload = self._load()
            task = self._task(payload, task_id)
            if task.get("status") == "queued":
                task["cancel_requested"] = True
                task["status"] = "cancelled"
                task["stage"] = "cancelled"
                task["completed_at"] = _now()
                task.setdefault("logs", []).append("设备任务在启动前取消")
            elif task.get("status") == "running":
                task["cancel_requested"] = True
                task.setdefault("logs", []).append("已请求取消设备任务")
                stop_vision = task.get("type") == "local_vision_prepare"
            self._save(payload)
            result = dict(task)
        if stop_vision:
            LocalVisionRuntime.stop(preserve_error=True)
        return result

    def supersede(
        self,
        task_type: str,
        *,
        kind: str = "",
        model: str = "",
        reason: str = "当前设置已变化，旧失败不再需要处理",
    ) -> int:
        """Mark obsolete terminal failures as historical without rewriting them.

        A disabled capability or changed model can make a previous preparation
        failure irrelevant. Preserve the original failed/interrupted status for
        audit, but annotate that current user intent has superseded it so Status
        Center can move it out of the current recovery queue.
        """
        if task_type not in DEVICE_TASK_TYPES:
            raise ValueError("不支持的 device task 类型")
        wanted_kind = str(kind or "").strip().lower()
        wanted_model = str(model or "").strip()
        now = _now()
        count = 0
        with self._lock:
            payload = self._load()
            for task in payload["tasks"]:
                if task.get("type") != task_type or task.get("status") not in {"failed", "interrupted"}:
                    continue
                targets = task.get("targets", {}) if isinstance(task.get("targets"), dict) else {}
                if wanted_kind and str(targets.get("kind", "") or "").strip().lower() != wanted_kind:
                    continue
                if wanted_model and str(targets.get("model", "") or "").strip() != wanted_model:
                    continue
                if task.get("superseded_at"):
                    continue
                task["superseded_at"] = now
                task["superseded_reason"] = str(reason or "当前设置已变化，旧失败不再需要处理")[:500]
                task.setdefault("logs", []).append(task["superseded_reason"])
                count += 1
            if count:
                self._save(payload)
        return count

    def _cancel_requested(self, task_id: str) -> bool:
        try:
            return bool(self._task(self._load(), task_id).get("cancel_requested"))
        except KeyError:
            return True

    def _update(
        self,
        task_id: str,
        *,
        status: str | None = None,
        stage: str | None = None,
        result: dict[str, Any] | None = None,
        error: str = "",
        message: str = "",
    ) -> None:
        with self._lock:
            payload = self._load()
            task = self._task(payload, task_id)
            if status == "running" and task.get("status") == "cancelled":
                return
            if status:
                task["status"] = status
                if status == "running" and not task.get("started_at"):
                    task["started_at"] = _now()
                if status in {"completed", "failed", "cancelled", "interrupted"}:
                    task["completed_at"] = _now()
            if stage:
                task["stage"] = stage
            if result is not None:
                task["result"] = result
            if error:
                task["error"] = str(error)[:2000]
            if message:
                task["message"] = str(message)[:500]
                task.setdefault("logs", []).append(str(message)[:500])
            self._save(payload)

    def _run(self, task_id: str) -> None:
        try:
            task = self._task(self._load(), task_id)
            if task.get("status") == "cancelled":
                return
            self._update(task_id, status="running", stage="starting", message="设备运行时准备开始")
            if self._cancel_requested(task_id):
                self._update(task_id, status="cancelled", stage="cancelled", message="设备任务已取消")
                return

            task_type = str(task.get("type", "") or "")
            targets = _targets(task_type, task.get("targets"))
            if task_type == "local_vision_prepare":
                model = str(targets["model"])
                self._update(task_id, stage="vision_prepare", message="正在准备本地视觉模型")
                runtime = LocalVisionRuntime(LocalVisionRuntimeConfig.from_env(model))
                base_url = runtime.ensure_server(
                    cancel_requested=lambda: self._cancel_requested(task_id),
                )
                if self._cancel_requested(task_id):
                    LocalVisionRuntime.stop(preserve_error=True)
                    self._update(task_id, status="cancelled", stage="cancelled", message="本地视觉准备已取消")
                    return
                if not base_url:
                    status = runtime.public()
                    raise RuntimeError(str(status.get("last_error", "") or "本地视觉模型准备失败"))
                result = {"kind": "local_vision", "model": model, "ready": True}
            elif task_type == "identity_runtime_prepare":
                kind = str(targets["kind"])
                self._update(task_id, stage="identity_prepare", message=f"正在准备{kind}身份运行时")
                IdentityRuntime.prepare_cancellable(
                    kind,
                    cancel_requested=lambda: self._cancel_requested(task_id),
                )
                result = {"kind": kind, "ready": True}
            else:
                raise ValueError("不支持的 device task 类型")

            self._update(
                task_id,
                status="completed",
                stage="completed",
                result=result,
                message="设备运行时准备完成",
            )
        except IdentityPreparationCancelled:
            self._update(task_id, status="cancelled", stage="cancelled", message="身份运行时准备已取消")
        except Exception as error:
            if self._cancel_requested(task_id):
                self._update(task_id, status="cancelled", stage="cancelled", message="设备运行时准备已取消")
            else:
                self._update(
                    task_id,
                    status="failed",
                    stage="failed",
                    error=str(error),
                    message="设备运行时准备失败",
                )
        finally:
            self._threads.pop(task_id, None)


def get_device_task_manager() -> DeviceTaskManager:
    global _MANAGER
    if _MANAGER is None:
        _MANAGER = DeviceTaskManager()
    return _MANAGER


def initialize_device_tasks() -> DeviceTaskManager:
    manager = get_device_task_manager()
    manager.recover_interrupted()
    return manager


__all__ = [
    "DEVICE_TASK_TYPES",
    "DeviceTaskManager",
    "get_device_task_manager",
    "initialize_device_tasks",
]
