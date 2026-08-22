from __future__ import annotations

import hashlib
import json
import os
import tempfile
from fractions import Fraction
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock, Thread
from typing import Any, Callable
from uuid import uuid4

from .config import ProjectConfig
from .material_index import analyze
from .media_identity import DeviceMediaStore
from .models import Clip
from .transcript import TranscriptStore, transcribe_with_faster_whisper


TASK_TYPES = {"incremental_analyze", "transcribe", "evidence_extract"}


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
    source_end_raw = item.get("source_end")
    source_end = Fraction(str(source_end_raw)) if source_end_raw is not None else source_start + duration
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


class TaskManager:
    """Persistent, per-project derived jobs. No task can write a review or source file."""

    def __init__(self, project_loader: Callable[[str], ProjectConfig]):
        self.project_loader = project_loader
        self._lock = RLock()
        self._threads: dict[str, Thread] = {}

    def _path(self, config: ProjectConfig) -> Path:
        return config.output_dir / "tasks.json"

    def _load(self, config: ProjectConfig) -> dict[str, Any]:
        raw = _read_json(self._path(config), {"version": 1, "tasks": []})
        if not isinstance(raw, dict) or not isinstance(raw.get("tasks"), list):
            return {"version": 1, "tasks": []}
        return {"version": 1, "tasks": raw["tasks"]}

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
        affected_group_ids = self._affected_group_ids(config, targets) if task_type in {"incremental_analyze", "transcribe"} else []
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
                "affected_group_ids": affected_group_ids,
                "idempotency_key": key,
                "status": "queued",
                "actor": actor[:80],
                "created_at": _now(),
                "started_at": "",
                "completed_at": "",
                "error": "",
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
                task["completed_at"] = _now()
                task["logs"].append("任务在启动前取消")
            elif task["status"] == "running":
                task["cancel_requested"] = True
                task["logs"].append("已请求取消；当前转写片段结束后停止")
            self._save(config, payload)
            return task

    def _run(self, project_id: str, task_id: str) -> None:
        config = self.project_loader(project_id)
        try:
            self._update(config, task_id, status="running", message="任务开始")
            task = self._task(self._load(config), task_id)
            if task.get("cancel_requested"):
                self._update(config, task_id, status="cancelled", message="任务已取消")
                return
            if task["type"] == "incremental_analyze":
                affected = set(str(value) for value in task.get("affected_group_ids", []) if value)
                result = analyze(config, affected or None)["index"]["stats"]
                result["affected_group_ids"] = sorted(affected)
            elif task["type"] == "transcribe":
                result = self._transcribe(config, task)
                if result.get("cancelled"):
                    self._update(config, task_id, status="cancelled", result=result, message="任务已取消")
                    return
                if result.get("transcribed"):
                    affected = set(str(value) for value in task.get("affected_group_ids", []) if value)
                    result["analysis"] = analyze(config, affected or None)["index"]["stats"]
            else:
                result = self._extract_evidence(config, task)
            self._update(config, task_id, status="completed", result=result, message="任务完成")
        except Exception as error:
            self._update(config, task_id, status="failed", error=str(error), message="任务失败")

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
        by_id = {
            str(item.get("clip_id")): item
            for item in index.get("clips", [])
            if isinstance(item, dict) and item.get("clip_id")
        }
        unknown = requested - set(by_id)
        if unknown:
            raise ValueError("存在未知 clip_id")

        device_store = DeviceMediaStore()
        snapshot = device_store.project_snapshot(str(task.get("project_id", "")))
        selected: list[Clip] = []
        missing_local: list[str] = []
        for clip_id in requested:
            item = by_id[clip_id]
            media_path = device_store.resolve_from_snapshot(snapshot, item)
            if not media_path:
                missing_local.append(clip_id)
                continue
            selected.append(_clip_from_index(item, media_path))
        if missing_local:
            raise ValueError("当前设备未定位素材：" + ", ".join(sorted(missing_local)))

        from faster_whisper import WhisperModel  # type: ignore

        model = WhisperModel(config.asr_model, device=config.asr_device, compute_type="auto")
        store = TranscriptStore(config.transcript_dir)
        completed = []
        for clip in selected:
            current = self._task(self._load(config), task["task_id"])
            if current.get("cancel_requested"):
                return {"transcribed": completed, "cancelled": True}
            transcript = transcribe_with_faster_whisper(clip, store, model, config.asr_language)
            completed.append({"clip_id": clip.clip_id, "media_id": clip.media_id, "has_text": bool(transcript.text.strip())})
            self._update(config, task["task_id"], message=f"已转写 {len(completed)}/{len(selected)} 条素材")
        return {"transcribed": completed, "cancelled": False, "device_local_media": True}

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
        groups = {
            str(item.get("group_id")): item
            for item in index.get("groups", [])
            if isinstance(item, dict) and item.get("group_id")
        }
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
        groups = {
            str(item.get("group_id")): item
            for item in index.get("groups", [])
            if isinstance(item, dict) and item.get("group_id")
        } if isinstance(index, dict) else {}
        result = []
        for group_id in group_ids:
            group = groups.get(str(group_id))
            if not group:
                raise ValueError("存在未知 group_id")
            row = matches.get("groups", {}).get(str(group_id), {}) if isinstance(matches, dict) else {}
            result.append(
                {
                    "group_id": group_id,
                    "members": group.get("members", []),
                    "candidates": row.get("candidates", []),
                    "source_range": {"start": group.get("start"), "end": group.get("end")},
                }
            )
        return {"evidence": result}

    def _update(
        self,
        config: ProjectConfig,
        task_id: str,
        status: str | None = None,
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
            if result is not None:
                task["result"] = result
            if error:
                task["error"] = error
            if message:
                task.setdefault("logs", []).append(f"{_now()} {message}")
            self._save(config, payload)

    @staticmethod
    def _task(payload: dict[str, Any], task_id: str) -> dict[str, Any]:
        for task in payload["tasks"]:
            if task.get("task_id") == task_id:
                return task
        raise KeyError(task_id)
