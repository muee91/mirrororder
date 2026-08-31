from __future__ import annotations

import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path
from threading import RLock, Thread
from typing import Any, Callable
from uuid import uuid4

from .analysis_runtime import analyze, generated_sync_fcpxml
from .asr_runtime import ASRRuntime, script_asr_prompt
from .auto_resolver import resolve_project
from .config import ProjectConfig
from .media_identity import DeviceMediaStore
from .models import Clip
from .multicam_sync_engine import run_multicam_sync
from .resource_scheduler import ResourceCancelled
from .transcript import TranscriptStore


TASK_TYPES = {
    "prepare_project",
    "multicam_sync",
    "incremental_analyze",
    "auto_resolve",
    "transcribe",
    "evidence_extract",
}
PROCESS_RUNNER_ID = "host_" + uuid4().hex


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


def _clip_from_index(item: dict[str, Any], media_path: str) -> Clip:
    duration = Fraction(str(item.get("duration", 0) or 0))
    timeline_start = Fraction(str(item.get("timeline_start", 0) or 0))
    timeline_end = Fraction(str(item.get("timeline_end", float(timeline_start + duration)) or float(timeline_start + duration)))
    source_start = Fraction(str(item.get("source_start", 0) or 0))
    raw_source_end = item.get("source_end")
    source_end = Fraction(str(raw_source_end)) if raw_source_end is not None else source_start + duration
    return Clip(
        clip_id=str(item.get("clip_id", "") or ""),
        name=str(item.get("name", "") or Path(media_path).stem),
        camera=str(item.get("camera", "?") or "?"),
        media_path=media_path,
        timeline_start=timeline_start,
        timeline_end=timeline_end,
        duration=duration,
        exists=bool(media_path and Path(media_path).is_file()),
        source_asset_id=str(item.get("source_asset_id", "") or ""),
        source_start=source_start,
        source_end=source_end,
        media_id=str(item.get("media_id", "") or ""),
    )


def _analysis_inputs_available(config: ProjectConfig) -> bool:
    if not config.script.exists():
        return False
    if config.is_fcpxml:
        return bool(config.fcpxml and config.fcpxml.exists())
    if config.is_media_directory:
        return bool(
            any(root.exists() for root in (config.media_roots or ((config.media_root,) if config.media_root else ())))
            or generated_sync_fcpxml(config).exists()
        )
    return False


class TaskManager:
    """Persistent, staged project jobs with restart-safe interruption semantics.

    A restarted Host never pretends an old in-memory thread is still running.
    Re-submitting an interrupted task is safe because sync/ASR/analysis stages use
    deterministic artifacts and caches.
    """

    def __init__(self, project_loader: Callable[[str], ProjectConfig], workspace_id: str = ""):
        self.project_loader = project_loader
        self.workspace_id = workspace_id
        self._lock = RLock()
        self._threads: dict[str, Thread] = {}

    def _path(self, config: ProjectConfig) -> Path:
        return config.output_dir / "tasks.json"

    def _load(self, config: ProjectConfig) -> dict[str, Any]:
        raw = _read_json(self._path(config), {"version": 2, "tasks": []})
        if not isinstance(raw, dict) or not isinstance(raw.get("tasks"), list):
            return {"version": 2, "tasks": []}
        tasks = raw["tasks"]
        changed = False
        for task in tasks:
            if not isinstance(task, dict):
                continue
            if task.get("status") in {"queued", "running"} and task.get("runner_id") != PROCESS_RUNNER_ID:
                task["status"] = "interrupted"
                task["interrupted_at"] = task.get("interrupted_at") or _now()
                task.setdefault("logs", []).append("Host 已重启；旧内存任务标记为 interrupted，可安全重跑")
                changed = True
        payload = {"version": 2, "tasks": tasks}
        if changed:
            _write_json(self._path(config), payload)
        return payload

    def _save(self, config: ProjectConfig, payload: dict[str, Any]) -> None:
        _write_json(self._path(config), payload)

    def list(self, project_id: str) -> list[dict[str, Any]]:
        config = self.project_loader(project_id)
        return list(reversed(self._load(config)["tasks"]))

    def submit(
        self,
        project_id: str,
        task_type: str,
        targets: dict[str, Any] | None = None,
        idempotency_key: str = "",
        actor: str = "human",
    ) -> dict[str, Any]:
        if task_type not in TASK_TYPES:
            raise ValueError("不支持的任务类型")
        config = self.project_loader(project_id)
        targets = targets if isinstance(targets, dict) else {}
        affected = self._affected_group_ids(config, targets) if task_type in {"incremental_analyze", "transcribe"} else []
        canonical = json.dumps({"type": task_type, "targets": targets}, ensure_ascii=False, sort_keys=True)
        key = idempotency_key or hashlib.sha1(canonical.encode("utf-8")).hexdigest()
        with self._lock:
            payload = self._load(config)
            for task in payload["tasks"]:
                if task.get("idempotency_key") == key and task.get("status") in {"queued", "running", "completed"}:
                    return task
            task = {
                "task_id": "task_" + uuid4().hex,
                "project_id": project_id,
                "type": task_type,
                "targets": targets,
                "affected_group_ids": affected,
                "idempotency_key": key,
                "runner_id": PROCESS_RUNNER_ID,
                "status": "queued",
                "stage": "queued",
                "progress": {},
                "actor": actor[:80],
                "created_at": _now(),
                "started_at": "",
                "completed_at": "",
                "error": "",
                "message": "任务已排队",
                "result": {},
                "logs": ["任务已排队"],
            }
            payload["tasks"].append(task)
            self._save(config, payload)
            thread = Thread(target=self._run, args=(project_id, task["task_id"]), daemon=True)
            self._threads[task["task_id"]] = thread
            thread.start()
            return task

    def cancel(self, project_id: str, task_id: str) -> dict[str, Any]:
        config = self.project_loader(project_id)
        with self._lock:
            payload = self._load(config)
            task = self._task(payload, task_id)
            if task["status"] == "queued":
                task["status"] = "cancelled"
                task["stage"] = "cancelled"
                task["message"] = "任务在启动前取消"
                task["completed_at"] = _now()
                task["logs"].append("任务在启动前取消")
            elif task["status"] == "running":
                task["cancel_requested"] = True
                task["message"] = "已请求取消；当前可中断阶段会停止"
                task["logs"].append("已请求取消；当前可中断阶段会停止")
            self._save(config, payload)
            return task

    def _cancel_requested(self, config: ProjectConfig, task_id: str) -> bool:
        return bool(self._task(self._load(config), task_id).get("cancel_requested"))

    def _run(self, project_id: str, task_id: str) -> None:
        config = self.project_loader(project_id)
        try:
            self._update(config, task_id, status="running", stage="starting", message="任务开始")
            if self._cancel_requested(config, task_id):
                self._update(config, task_id, status="cancelled", stage="cancelled", message="任务已取消")
                return
            task = self._task(self._load(config), task_id)
            if task["type"] == "prepare_project":
                result = self._prepare_project(project_id, config, task)
                if result.get("cancelled"):
                    self._update(config, task_id, status="cancelled", stage="cancelled", result=result, message="任务已取消")
                    return
            elif task["type"] == "multicam_sync":
                self._update(config, task_id, stage="sync")
                result = run_multicam_sync(
                    config,
                    lambda text: self._update(config, task_id, message=text),
                    cancel_requested=lambda: self._cancel_requested(config, task_id),
                )
            elif task["type"] == "incremental_analyze":
                self._update(config, task_id, stage="analysis")
                affected = set(str(value) for value in task.get("affected_group_ids", []) if value)
                result = analyze(config, affected or None)["index"]["stats"]
                result["affected_group_ids"] = sorted(affected)
                result["automation"] = resolve_project(config)["summary"]
            elif task["type"] == "auto_resolve":
                self._update(config, task_id, stage="resolve")
                automation = resolve_project(config)
                result = {"automation": automation["summary"], "model": automation.get("model", {})}
            elif task["type"] == "transcribe":
                self._update(config, task_id, stage="asr")
                result = self._transcribe(config, task)
                if result.get("cancelled"):
                    self._update(config, task_id, status="cancelled", stage="cancelled", result=result, message="任务已取消")
                    return
                if result.get("transcribed") and _analysis_inputs_available(config):
                    self._update(config, task_id, stage="analysis")
                    affected = set(str(value) for value in task.get("affected_group_ids", []) if value)
                    result["analysis"] = analyze(config, affected or None)["index"]["stats"]
                    result["automation"] = resolve_project(config)["summary"]
                elif result.get("transcribed"):
                    result["analysis_deferred"] = True
                    result["analysis_deferred_reason"] = "当前设备没有可用项目源/同步产物；转写缓存已写入，可由Host后续分析"
            else:
                self._update(config, task_id, stage="evidence")
                result = self._extract_evidence(config, task)
            self._update(config, task_id, status="completed", stage="completed", result=result, message="任务完成")
        except ResourceCancelled as error:
            self._update(
                config,
                task_id,
                status="cancelled",
                stage="cancelled",
                message=str(error).strip() or "任务已取消",
            )
        except Exception as error:
            self._update(config, task_id, status="failed", stage="failed", error=str(error), message="任务失败")
        finally:
            self._threads.pop(task_id, None)

    def _prepare_project(self, project_id: str, config: ProjectConfig, task: dict[str, Any]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        if config.is_media_directory:
            self._update(config, task["task_id"], stage="sync", message="开始多机位音频同步")
            result["sync"] = run_multicam_sync(
                config,
                lambda text: self._update(config, task["task_id"], message=text),
                cancel_requested=lambda: self._cancel_requested(config, task["task_id"]),
            )
            if self._cancel_requested(config, task["task_id"]):
                return {**result, "cancelled": True}
        if not _analysis_inputs_available(config):
            raise ValueError("项目源输入不完整，无法执行自动准备")
        self._update(config, task["task_id"], stage="analysis", message="开始 MLX/ASR 与剧本匹配")
        analysis = analyze(config)
        result["analysis"] = analysis["index"]["stats"]
        if self._cancel_requested(config, task["task_id"]):
            return {**result, "cancelled": True}
        self._update(config, task["task_id"], stage="resolve", message="自动确认剧本归属并处理疑难 Take")
        automation = resolve_project(config)
        result["automation"] = automation["summary"]
        result["model"] = automation.get("model", {})
        return result

    def _transcribe(self, config: ProjectConfig, task: dict[str, Any]) -> dict[str, Any]:
        clip_ids = task.get("targets", {}).get("clip_ids", [])
        if not isinstance(clip_ids, list) or not clip_ids:
            raise ValueError("transcribe 需要非空 clip_ids")
        requested = {str(value) for value in clip_ids if str(value)}
        if len(requested) > 12:
            raise ValueError("一次最多转写12条素材")
        index = _read_json(config.output_dir / "material_index.json", {})
        if not isinstance(index, dict):
            raise ValueError("项目尚未生成素材索引")
        by_id = {str(item.get("clip_id")): item for item in index.get("clips", []) if isinstance(item, dict) and item.get("clip_id")}
        unknown = requested - set(by_id)
        if unknown:
            raise ValueError("存在未知 clip_id")

        device_store = DeviceMediaStore()
        if not self.workspace_id:
            raise ValueError("任务缺少工作区身份，无法读取本机素材绑定")
        snapshot = device_store.project_snapshot(self.workspace_id, str(task.get("project_id", "")))
        selected: list[Clip] = []
        missing_local: list[str] = []
        for clip_id in requested:
            item = by_id[clip_id]
            source_path = str(item.get("source_media_path") or item.get("media_path") or "")
            media_path = source_path if source_path and Path(source_path).is_file() else device_store.resolve_from_snapshot(snapshot, item)
            if not media_path:
                missing_local.append(clip_id)
                continue
            selected.append(_clip_from_index(item, media_path))
        if missing_local:
            raise ValueError("当前设备未定位素材：" + ", ".join(sorted(missing_local)))

        runtime = ASRRuntime.from_config(config)
        if not runtime.enabled:
            raise ValueError("当前项目 ASR backend=cache，不能主动转写")
        store = TranscriptStore(config.transcript_dir)
        prompt = script_asr_prompt(config.script)
        completed = []
        for clip in selected:
            if self._cancel_requested(config, task["task_id"]):
                return {"transcribed": completed, "cancelled": True, "asr": runtime.public()}
            transcript = runtime.transcribe(clip, store, prompt)
            completed.append({"clip_id": clip.clip_id, "media_id": clip.media_id, "has_text": bool(transcript.text.strip())})
            self._update(
                config,
                task["task_id"],
                progress={"done": len(completed), "total": len(selected)},
                message=f"已转写 {len(completed)}/{len(selected)} 条素材",
            )
        return {"transcribed": completed, "cancelled": False, "device_local_media": True, "asr": runtime.public()}

    @staticmethod
    def _affected_group_ids(config: ProjectConfig, targets: dict[str, Any]) -> list[str]:
        group_ids = targets.get("group_ids", [])
        clip_ids = targets.get("clip_ids", [])
        if not isinstance(group_ids, list) or not isinstance(clip_ids, list):
            raise ValueError("任务目标格式无效")
        if not group_ids and not clip_ids:
            return []
        index = _read_json(config.output_dir / "material_index.json", {})
        if not isinstance(index, dict):
            raise ValueError("项目尚未生成素材索引")
        groups = {str(item.get("group_id")): item for item in index.get("groups", []) if isinstance(item, dict) and item.get("group_id")}
        unknown_groups = {str(value) for value in group_ids if str(value)} - set(groups)
        if unknown_groups:
            raise ValueError("存在未知 group_id")
        clip_to_groups: dict[str, set[str]] = {}
        for group_id, group in groups.items():
            for member in group.get("members", []):
                if isinstance(member, dict) and member.get("clip_id"):
                    clip_to_groups.setdefault(str(member["clip_id"]), set()).add(group_id)
        affected = {str(value) for value in group_ids if str(value)}
        for clip_id in {str(value) for value in clip_ids if str(value)}:
            if clip_id not in clip_to_groups:
                raise ValueError("存在未知 clip_id")
            affected.update(clip_to_groups[clip_id])
        return sorted(affected)

    def _extract_evidence(self, config: ProjectConfig, task: dict[str, Any]) -> dict[str, Any]:
        group_ids = task.get("targets", {}).get("group_ids", [])
        if not isinstance(group_ids, list) or not group_ids:
            raise ValueError("evidence_extract 需要非空 group_ids")
        index = _read_json(config.output_dir / "material_index.json", {})
        matches = _read_json(config.output_dir / "matches.json", {})
        groups = {str(item.get("group_id")): item for item in index.get("groups", []) if isinstance(item, dict) and item.get("group_id")} if isinstance(index, dict) else {}
        result = []
        for group_id in group_ids:
            group = groups.get(str(group_id))
            if not group:
                raise ValueError("存在未知 group_id")
            row = matches.get("groups", {}).get(str(group_id), {}) if isinstance(matches, dict) else {}
            result.append({
                "group_id": group_id,
                "members": group.get("members", []),
                "candidates": row.get("candidates", []),
                "source_range": {"start": group.get("start"), "end": group.get("end")},
            })
        return {"evidence": result}

    def _update(
        self,
        config: ProjectConfig,
        task_id: str,
        status: str | None = None,
        stage: str | None = None,
        progress: dict[str, Any] | None = None,
        result: dict[str, Any] | None = None,
        error: str = "",
        message: str = "",
    ) -> None:
        with self._lock:
            payload = self._load(config)
            task = self._task(payload, task_id)
            if status:
                task["status"] = status
                if status == "running":
                    task["started_at"] = task["started_at"] or _now()
                if status in {"completed", "failed", "cancelled"}:
                    task["completed_at"] = _now()
            if stage:
                task["stage"] = stage
            if progress is not None:
                task["progress"] = progress
            if result is not None:
                task["result"] = result
            if error:
                task["error"] = error
            if message:
                task["message"] = str(message)[:500]
                task.setdefault("logs", []).append(f"{_now()} {message}")
            self._save(config, payload)

    @staticmethod
    def _task(payload: dict[str, Any], task_id: str) -> dict[str, Any]:
        for task in payload["tasks"]:
            if task.get("task_id") == task_id:
                return task
        raise KeyError(task_id)
