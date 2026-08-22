from __future__ import annotations

# Compatibility module. The durable implementation lives in tasks_v2 so old
# imports used by the Host, MCP gateway, tests and local scripts keep working.
# Keep these literal names here as a cheap capability breadcrumb for older
# tooling that inspected this module as text.
COMPAT_TASK_TYPES = {
    "prepare_project",
    "multicam_sync",
    "incremental_analyze",
    "auto_resolve",
    "transcribe",
    "evidence_extract",
}

from contextlib import contextmanager
from typing import Any, Iterator

from .analysis_runtime import analyze as _default_analyze
from .asr_runtime import ASRRuntime
from . import tasks_v2 as _impl
from .resource_scheduler import GLOBAL_RESOURCE_SCHEDULER, ResourceCancelled

# Public compatibility symbol. Older tests/tools monkeypatch this name.
analyze = _default_analyze
TASK_TYPES = _impl.TASK_TYPES


class TaskManager(_impl.TaskManager):
    """Durable task facade with process-wide resource scheduling.

    Projects stay independent: creating/switching projects never waits for a
    different project to finish. Scarce resources (multicam sync, MLX, local
    vision) are queued globally so several projects do not saturate one Mac.
    """

    @staticmethod
    def _asr_resource(config) -> str:
        runtime = ASRRuntime.from_config(config)
        return "mlx" if runtime.backend == "mlx-whisper" else "cpu"

    @contextmanager
    def _resource(
        self,
        config,
        task: dict[str, Any],
        resource: str,
        stage: str,
        label: str,
    ) -> Iterator[None]:
        task_id = str(task["task_id"])
        project_id = str(task.get("project_id", ""))
        waiting_stage = f"waiting_{resource}"
        self._update(
            config,
            task_id,
            stage=waiting_stage,
            message=f"等待 Host {label}资源；其他项目可继续创建、查看和审核",
        )
        with GLOBAL_RESOURCE_SCHEDULER.slot(
            resource,
            project_id,
            task_id,
            cancelled=lambda: self._cancel_requested(config, task_id),
        ):
            self._update(
                config,
                task_id,
                stage=stage,
                message=f"已获得 Host {label}资源",
            )
            yield

    def _run(self, project_id: str, task_id: str) -> None:
        config = self.project_loader(project_id)
        try:
            self._update(config, task_id, status="running", stage="starting", message="任务开始")
            if self._cancel_requested(config, task_id):
                self._update(config, task_id, status="cancelled", stage="cancelled", message="任务已取消")
                return
            task = self._task(self._load(config), task_id)
            task_type = str(task["type"])

            if task_type == "prepare_project":
                result = self._prepare_project(project_id, config, task)
                if result.get("cancelled"):
                    self._update(config, task_id, status="cancelled", stage="cancelled", result=result, message="任务已取消")
                    return
            elif task_type == "multicam_sync":
                with self._resource(config, task, "sync", "sync", "多机位同步"):
                    result = _impl.run_multicam_sync(
                        config,
                        lambda text: self._update(config, task_id, message=text),
                    )
            elif task_type == "incremental_analyze":
                affected = set(str(value) for value in task.get("affected_group_ids", []) if value)
                with self._resource(config, task, self._asr_resource(config), "analysis", "MLX/ASR"):
                    result = analyze(config, affected or None)["index"]["stats"]
                result["affected_group_ids"] = sorted(affected)
                with self._resource(config, task, "vision", "resolve", "视觉/模型救援"):
                    result["automation"] = _impl.resolve_project(config)["summary"]
            elif task_type == "auto_resolve":
                with self._resource(config, task, "vision", "resolve", "视觉/模型救援"):
                    automation = _impl.resolve_project(config)
                result = {"automation": automation["summary"], "model": automation.get("model", {})}
            elif task_type == "transcribe":
                result = self._transcribe(config, task)
                if result.get("cancelled"):
                    self._update(config, task_id, status="cancelled", stage="cancelled", result=result, message="任务已取消")
                    return
                if result.get("transcribed") and _impl._analysis_inputs_available(config):
                    affected = set(str(value) for value in task.get("affected_group_ids", []) if value)
                    with self._resource(config, task, self._asr_resource(config), "analysis", "MLX/ASR"):
                        result["analysis"] = analyze(config, affected or None)["index"]["stats"]
                    with self._resource(config, task, "vision", "resolve", "视觉/模型救援"):
                        result["automation"] = _impl.resolve_project(config)["summary"]
                elif result.get("transcribed"):
                    result["analysis_deferred"] = True
                    result["analysis_deferred_reason"] = "当前设备没有可用项目源/同步产物；转写缓存已写入，可由Host后续分析"
            else:
                self._update(config, task_id, stage="evidence")
                result = self._extract_evidence(config, task)

            self._update(config, task_id, status="completed", stage="completed", result=result, message="任务完成")
        except ResourceCancelled:
            self._update(config, task_id, status="cancelled", stage="cancelled", message="等待计算资源时任务已取消")
        except Exception as error:
            self._update(config, task_id, status="failed", stage="failed", error=str(error), message="任务失败")
        finally:
            self._threads.pop(task_id, None)

    def _prepare_project(self, project_id: str, config, task: dict[str, Any]) -> dict[str, Any]:
        del project_id
        result: dict[str, Any] = {}
        task_id = str(task["task_id"])
        if config.is_media_directory:
            with self._resource(config, task, "sync", "sync", "多机位同步"):
                result["sync"] = _impl.run_multicam_sync(
                    config,
                    lambda text: self._update(config, task_id, message=text),
                )
            if self._cancel_requested(config, task_id):
                return {**result, "cancelled": True}

        if not _impl._analysis_inputs_available(config):
            raise ValueError("项目源输入不完整，无法执行自动准备")

        with self._resource(config, task, self._asr_resource(config), "analysis", "MLX/ASR"):
            self._update(config, task_id, message="开始 ASR 与剧本匹配")
            analysis = analyze(config)
        result["analysis"] = analysis["index"]["stats"]
        if self._cancel_requested(config, task_id):
            return {**result, "cancelled": True}

        with self._resource(config, task, "vision", "resolve", "视觉/模型救援"):
            self._update(config, task_id, message="自动确认剧本归属并处理疑难 Take")
            automation = _impl.resolve_project(config)
        result["automation"] = automation["summary"]
        result["model"] = automation.get("model", {})
        return result

    def _transcribe(self, config, task: dict[str, Any]) -> dict[str, Any]:
        with self._resource(config, task, self._asr_resource(config), "asr", "MLX/ASR"):
            return super()._transcribe(config, task)


__all__ = ["TASK_TYPES", "TaskManager", "analyze", "COMPAT_TASK_TYPES"]
