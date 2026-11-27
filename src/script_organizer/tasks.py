from __future__ import annotations

# Compatibility module. The durable implementation lives in tasks_v2 so old
# imports used by the Host, MCP gateway, tests and local scripts keep working.
# Keep these literal names here as a cheap capability breadcrumb for older
# tooling that inspected this module as text.
COMPAT_TASK_TYPES = {
    "prepare_project",
    "multicam_sync",
    "incremental_analyze",
    "slate_ocr",
    "auto_resolve",
    "transcribe",
    "evidence_extract",
    "identity_index",
    "recording_alignment_ai_review",
}

from contextlib import contextmanager
import inspect
import json
import os
from collections import Counter
from dataclasses import replace
from pathlib import Path
import selectors
import subprocess
import sys
from time import monotonic
from typing import Any, Iterator

from .analysis_runtime import analyze as _default_analyze
from .asr_runtime import ASRRuntime
from . import tasks_v2 as _impl
from .device_runtime_settings import load_runtime_settings
from .identity_index import IdentityIndexer
from .media_identity import DeviceMediaStore
from .perception_index import PerceptionIndexer
from .resource_scheduler import GLOBAL_RESOURCE_SCHEDULER, ResourceCancelled
from .take_semantic_provider import TakeSemanticProvider

# Public compatibility symbol. Older tests/tools monkeypatch this name.
analyze = _default_analyze
TASK_TYPES = _impl.TASK_TYPES


def _run_analysis(
    config,
    affected_group_ids: set[str] | None = None,
    progress=None,
    cancelled=None,
    *,
    workspace_id: str = "",
    project_id: str = "",
):
    """Call the current analyzer while keeping older test/tool doubles usable."""
    parameters = inspect.signature(analyze).parameters
    kwargs = {}
    if "progress" in parameters and progress is not None:
        kwargs["progress"] = progress
    if "cancelled" in parameters and cancelled is not None:
        kwargs["cancelled"] = cancelled
    if "workspace_id" in parameters and workspace_id:
        kwargs["workspace_id"] = workspace_id
    if "project_id" in parameters and project_id:
        kwargs["project_id"] = project_id
    return analyze(config, affected_group_ids, **kwargs)


class TaskManager(_impl.TaskManager):
    """Durable task facade with process-wide resource scheduling.

    Projects stay independent: creating/switching projects never waits for a
    different project to finish. Scarce resources (multicam sync, MLX, local
    vision, local identity indexing) are queued globally so several projects do
    not saturate one Mac.
    """

    @staticmethod
    def _asr_resource(config) -> str:
        runtime = ASRRuntime.from_config(config)
        return "mlx" if runtime.backend == "mlx-whisper" else "cpu"

    def _refresh_media_bindings(self, config, project_id: str) -> dict[str, int]:
        """Bind a newly analyzed media-directory project on this Host only."""
        if not config.is_media_directory or not self.workspace_id:
            return {}
        store = DeviceMediaStore()
        snapshot = store.project_snapshot(self.workspace_id, project_id)
        roots = snapshot.get("roots", []) if isinstance(snapshot, dict) else []
        if not roots:
            return {}
        try:
            index = _impl._read_json(config.output_dir / "material_index.json", {})
            if not isinstance(index, dict):
                return {}
            summary = store.scan(self.workspace_id, project_id, index, roots)
            return {
                "total": int(summary.get("total", 0) or 0),
                "resolved": int(summary.get("resolved", 0) or 0),
                "missing": int(summary.get("missing", 0) or 0),
            }
        except Exception:
            return {}

    def _post_sync_analysis(self, project_id: str, config, task: dict[str, Any]) -> dict[str, Any]:
        """Publish media identities after direct sync without starting ASR."""
        if not _impl._analysis_inputs_available(config):
            raise ValueError("多机位同步已完成，但缺少剧本或同步产物，无法建立媒体身份索引")
        task_id = str(task["task_id"])
        self._update(config, task_id, stage="analysis", message="多机位同步完成，正在建立媒体身份索引")
        with self._resource(config, task, "cpu", "analysis", "媒体身份索引"):
            analysis = _run_analysis(
                _impl._sync_analysis_config(config),
                cancelled=lambda: self._cancel_requested(config, task_id),
                workspace_id=self.workspace_id,
                project_id=project_id,
            )
        return analysis["index"]["stats"]

    def _queue_post_sync_analysis(self, project_id: str, config, task: dict[str, Any]) -> None:
        """Queue script/ASR work outside the sync gate.

        A direct multicam sync must unlock review and NLE delivery as soon as
        the master is written.  Transcription and script matching are long
        running, so they run as their own durable task instead of holding the
        sync task in ``running`` state.  ``incremental_analyze`` is not a sync
        gate task, so it cannot block delivery.
        """
        if not getattr(config, "is_media_directory", False):
            return
        script = getattr(config, "script", None)
        if script is None or not Path(script).is_file():
            return
        try:
            self.submit(
                project_id,
                "incremental_analyze",
                {},
                idempotency_key=f"post-sync:incremental:{project_id}:{task.get('task_id', '')}",
                actor="system",
            )
        except Exception:
            # The sync master is already delivered; a failed follow-up queue
            # must never turn a successful sync into a failed task.
            return

    def _analysis_progress(self, config, task_id: str):
        previous_phase = ""
        previous_time = 0.0

        def report(phase: str, done: int, total: int, message: str) -> None:
            nonlocal previous_phase, previous_time
            now = monotonic()
            if phase == previous_phase and now - previous_time < 1 and done < total:
                return
            previous_phase, previous_time = phase, now
            self._update(config, task_id, stage={"asr": "asr", "rescue": "asr"}.get(phase, "analysis"),
                         progress={"done": done, "total": total}, message=message)

        return report

    @staticmethod
    def _scene_check_candidates(config, affected: set[str]) -> set[str]:
        matches = _impl._read_json(config.output_dir / "matches.json", {})
        eligible = []
        for group_id, row in matches.get("groups", {}).items():
            if affected and group_id not in affected:
                continue
            candidates = row.get("candidates", [])
            if not candidates:
                continue
            top = candidates[0]
            score = float(top.get("dialogue_score", 0))
            if score >= 0.55 and top.get("confidence") != "context_only":
                eligible.append((top.get("confidence") == "exact_dialogue", -score, group_id))
        return {group_id for _exact, _score, group_id in sorted(eligible)[:24]}

    def _check_script_scenes(self, config, task: dict[str, Any], groups: set[str]) -> dict[str, Any]:
        from .model_provider import ModelProvider, ModelProviderConfig
        from .vision_provider import VisionProvider, VisionProviderConfig

        if not self.workspace_id:
            raise ValueError("音画核对需要当前工作区的 Take")
        settings = load_runtime_settings()
        vision = VisionProvider(VisionProviderConfig(
            provider="local", model=settings["local_vision_model"], frame_count=2,
            timeout_seconds=45, min_confidence=0.82,
        ))
        task_id = task["task_id"]
        with self._resource(config, task, "vision", "resolve", "音画核对"):
            automation = _impl.resolve_project(
                config, provider=ModelProvider(ModelProviderConfig()), vision_provider=vision,
                workspace_id=self.workspace_id, project_id=task["project_id"],
                visual_group_ids=groups, cancelled=lambda: self._cancel_requested(config, task_id),
                progress=lambda done, total: self._update(
                    config, task_id, progress={"done": done, "total": total}, message=f"音画核对 {done}/{total}",
                ),
            )
        verdicts = Counter(
            automation["groups"][group_id].get("evidence", {}).get("scene_cross_check", {}).get("verdict", "skipped")
            for group_id in groups
        )
        return {"automation": automation["summary"], "scene_cross_check": dict(verdicts)}

    def _queue_slate_ocr(self, project_id: str, config) -> None:
        """Auto-queue recognition when a paper slate is part of the project.

        The task reads ``config.slate`` itself, so no device path is stored in
        task targets. Human confirmation still gates every draft write.
        """
        slate = getattr(config, "slate", None)
        if slate is None or not Path(slate).is_file():
            return
        try:
            self.submit(
                project_id,
                "slate_ocr",
                {},
                idempotency_key=f"slate-ocr:auto:{project_id}:{Path(slate).name}",
                actor="system",
            )
        except Exception:
            return

    def _persist_project_summary(self, project_id: str, config, task_type: str, result: dict[str, Any]) -> None:
        if not self.workspace_id or task_type not in {"multicam_sync", "prepare_project", "incremental_analyze"}:
            return
        stats = result.get("analysis") if isinstance(result.get("analysis"), dict) else result.get("stats")
        if not isinstance(stats, dict) and task_type == "incremental_analyze":
            stats = result
        if isinstance(stats, dict) and isinstance(stats.get("stats"), dict):
            stats = stats["stats"]
        if not isinstance(stats, dict) or not stats:
            return
        try:
            from .audit_engine import _analysis_revision
            from .workspace_db import WorkspaceDatabase

            WorkspaceDatabase(self.workspace_id).sync_project_summary(
                project_id,
                name=config.name,
                input_kind=config.input_kind,
                config_path=str(config.config_path),
                analysis_revision=_analysis_revision(config.output_dir),
                stats=dict(stats),
            )
        except Exception:
            # The device-local summary accelerates discovery and is never task authority.
            return

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
            self._update(config, task_id, stage=stage, message=f"已获得 Host {label}资源")
            yield

    def _perception_best_effort(
        self,
        config,
        task: dict[str, Any],
        *,
        mode: str,
        group_ids: list[str] | None = None,
        semantic_provider: TakeSemanticProvider | None = None,
        publish_visual_checkpoints: bool = False,
    ) -> dict[str, Any]:
        if not self.workspace_id:
            return {"status": "deferred", "reason": "任务缺少 workspace_id"}
        task_id = str(task["task_id"])
        project_id = str(task.get("project_id", ""))
        if not project_id:
            return {"status": "deferred", "reason": "任务缺少 project_id"}
        resource = "vision" if mode == "semantic" else "cpu"
        label = "Take 视觉语义" if mode == "semantic" else "Take 感知索引"
        stage = "semantic_index" if mode == "semantic" else "perception_index"
        try:
            with self._resource(config, task, resource, stage, label):
                indexer = PerceptionIndexer(self.workspace_id, project_id, config, semantic_provider=semantic_provider)
                last_reported = {"done": -1}
                search_indexer = None
                if publish_visual_checkpoints:
                    from .semantic_encoder import SemanticEncoder
                    from .semantic_index import ProjectSemanticIndexer

                    try:
                        encoder = SemanticEncoder()
                        if not encoder.config.enabled:
                            search_indexer = ProjectSemanticIndexer(self.workspace_id, project_id, config, encoder=encoder)
                    except Exception:
                        # Recognition stays usable even when the search index is unavailable.
                        pass
                pending_visual: list[str] = []
                next_publish = monotonic()

                def report(done: int, total: int, group_id: str) -> None:
                    nonlocal next_publish
                    if search_indexer is not None:
                        pending_visual.append(group_id)
                        if len(pending_visual) >= 16 or done == total or monotonic() >= next_publish:
                            try:
                                with GLOBAL_RESOURCE_SCHEDULER.slot("embedding", project_id, task_id,
                                        cancelled=lambda: self._cancel_requested(config, task_id)):
                                    search_indexer.refresh(group_ids=pending_visual, sources=["visual"])
                            except ResourceCancelled:
                                return
                            except Exception:
                                # The final semantic refresh can rebuild the derived rows.
                                pass
                            pending_visual.clear()
                            next_publish = monotonic() + 90
                    if done == total or done - last_reported["done"] >= 10:
                        last_reported["done"] = done
                        self._update(
                            config,
                            task_id,
                            progress={"perception_done": done, "perception_total": total},
                            message=f"{label} {done}/{total}",
                        )

                result = indexer.run(
                    mode=mode,
                    group_ids=group_ids,
                    progress=report,
                    cancelled=lambda: self._cancel_requested(config, task_id),
                )
                if result.get("status") == "cancelled":
                    raise ResourceCancelled("感知索引阶段任务已取消")
                return result
        except ResourceCancelled:
            raise
        except Exception as error:
            self._update(config, task_id, message=f"感知索引已延后，不影响主分析：{error}")
            return {"status": "deferred", "error": str(error)}

    def _index_local_visual_evidence(self, config, task: dict[str, Any]) -> dict[str, Any]:
        from .vision_provider import VisionProviderConfig

        targets = task.get("targets", {})
        group_ids = self._affected_group_ids(config, {"group_ids": targets.get("group_ids", [])})
        settings = load_runtime_settings()
        provider = TakeSemanticProvider(VisionProviderConfig(provider="local", model=settings["local_vision_model"]))
        result = self._perception_best_effort(config, task, mode="semantic", group_ids=group_ids or None,
                                             semantic_provider=provider, publish_visual_checkpoints=True)
        if result.get("status") != "completed":
            raise ValueError(str(result.get("error") or result.get("reason") or "画面识别未完成"))
        if result.get("total") and not result.get("processed"):
            raise ValueError("本地模型未生成可检索的画面描述，请检查素材和本地 AI 状态")
        return {"perception": result}

    def _identity_best_effort(
        self,
        config,
        task: dict[str, Any],
        *,
        kind: str,
        group_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        if not self.workspace_id:
            return {"status": "deferred", "reason": "任务缺少 workspace_id", "kind": kind}
        settings = load_runtime_settings()
        enabled_key = "face_identity_enabled" if kind == "face" else "speaker_identity_enabled"
        if not settings.get(enabled_key):
            return {"status": "disabled", "kind": kind}
        task_id = str(task["task_id"])
        project_id = str(task.get("project_id", ""))
        label = "演员人脸识别" if kind == "face" else "角色声纹识别"
        stage = "face_identity" if kind == "face" else "speaker_identity"
        try:
            with self._resource(config, task, "cpu", stage, label):
                result = self._run_identity_worker(
                    config,
                    task_id,
                    project_id=project_id,
                    kind=kind,
                    group_ids=group_ids,
                    label=label,
                )
                if result.get("status") == "cancelled":
                    raise ResourceCancelled(f"{label}阶段任务已取消")
                return result
        except ResourceCancelled:
            raise
        except Exception as error:
            self._update(config, task_id, message=f"{label}已延后，不影响主分析：{error}")
            return {"status": "deferred", "kind": kind, "error": str(error)}

    def _run_identity_worker(
        self,
        config,
        task_id: str,
        *,
        project_id: str,
        kind: str,
        group_ids: list[str] | None,
        label: str,
    ) -> dict[str, Any]:
        """Proxy a worker process while the gateway keeps serving requests."""

        source_root = Path(__file__).resolve().parents[1]
        environment = dict(os.environ)
        python_path = environment.get("PYTHONPATH", "")
        environment["PYTHONPATH"] = str(source_root) + (
            os.pathsep + python_path if python_path else ""
        )
        command = [
            sys.executable,
            "-m",
            "script_organizer.identity_worker",
            "--workspace-id",
            self.workspace_id,
            "--project-id",
            project_id,
            "--config",
            str(config.config_path),
            "--kind",
            kind,
        ]
        for group_id in group_ids or []:
            command.extend(["--group-id", group_id])
        worker = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            bufsize=0,
            env=environment,
        )
        stream = worker.stdout
        if stream is None:
            raise RuntimeError(f"{label}子进程标准输出不可用")
        poller = selectors.DefaultSelector()
        poller.register(stream, selectors.EVENT_READ)
        last_reported = -1
        result: dict[str, Any] | None = None
        error = ""
        detail_lines: list[str] = []
        cancellation_sent = False
        pending_output = b""

        def handle_event(event: dict[str, Any]) -> None:
            nonlocal last_reported, result, error
            event_type = str(event.get("type", "") or "")
            if event_type == "progress":
                done = int(event.get("done", 0) or 0)
                total = int(event.get("total", 0) or 0)
                group_id = str(event.get("group_id", "") or "")
                if done == 0 or done == total or done > last_reported:
                    last_reported = done
                    self._update(
                        config,
                        task_id,
                        progress={f"{kind}_done": done, f"{kind}_total": total},
                        message=f"{label} {done}/{total} · {group_id}",
                    )
            elif event_type == "status":
                message = str(event.get("message", "") or "").strip()
                if message:
                    self._update(config, task_id, message=message)
            elif event_type == "result":
                raw_result = event.get("result")
                result = dict(raw_result) if isinstance(raw_result, dict) else {}
            elif event_type == "error":
                error = str(event.get("error", "") or "人物索引子进程失败")

        def handle_line(raw_line: bytes) -> None:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                return
            try:
                event = json.loads(line)
            except ValueError:
                detail_lines.append(line)
                return
            if isinstance(event, dict):
                handle_event(event)

        def drain_output(chunk: bytes) -> None:
            nonlocal pending_output
            pending_output += chunk
            lines = pending_output.split(b"\n")
            pending_output = lines.pop()
            for raw_line in lines:
                handle_line(raw_line)

        try:
            while worker.poll() is None:
                if self._cancel_requested(config, task_id) and not cancellation_sent:
                    if worker.stdin is not None:
                        worker.stdin.write(b"cancel\n")
                        worker.stdin.flush()
                    cancellation_sent = True
                for _key, _mask in poller.select(timeout=0.25):
                    chunk = os.read(stream.fileno(), 65536)
                    if chunk:
                        drain_output(chunk)
            remaining = stream.read()
            if remaining:
                drain_output(remaining)
            if pending_output:
                handle_line(pending_output)
        finally:
            poller.close()
            if worker.stdin is not None:
                worker.stdin.close()
            if worker.poll() is None:
                worker.terminate()
                worker.wait(timeout=5)

        if error:
            raise RuntimeError(error)
        if result is None:
            if worker.returncode not in {0, None}:
                detail = "\n".join(line for line in detail_lines if line)[-1200:]
                suffix = f"：{detail}" if detail else ""
                raise RuntimeError(f"{label}子进程异常退出（exit {worker.returncode}）{suffix}")
            raise RuntimeError(f"{label}子进程未返回结果")
        return result

    def _identity_after_analysis(
        self,
        config,
        task: dict[str, Any],
        *,
        group_ids: list[str] | None = None,
        explicit: bool = False,
    ) -> dict[str, Any]:
        settings = load_runtime_settings()
        # Identity evidence is project-level and user-triggered from the
        # current project panel. Enabling a device runtime must not silently
        # enqueue work across every project on this Mac.
        if not explicit:
            return {"status": "manual"}
        result: dict[str, Any] = {}
        if settings.get("face_identity_enabled"):
            result["face"] = self._identity_best_effort(config, task, kind="face", group_ids=group_ids)
        if settings.get("speaker_identity_enabled"):
            result["speaker"] = self._identity_best_effort(config, task, kind="speaker", group_ids=group_ids)
        return result

    def _run_identity_task(self, config, task: dict[str, Any]) -> dict[str, Any]:
        targets = task.get("targets", {}) if isinstance(task.get("targets"), dict) else {}
        kind = str(targets.get("kind", "both") or "both")
        if kind not in {"face", "speaker", "both"}:
            raise ValueError("identity_index kind 必须是 face、speaker 或 both")
        raw_groups = targets.get("group_ids", [])
        if not isinstance(raw_groups, list):
            raise ValueError("identity_index group_ids 必须是数组")
        group_ids = [str(value) for value in raw_groups if str(value)] or None
        result: dict[str, Any] = {}
        if kind in {"face", "both"}:
            result["face"] = self._identity_best_effort(config, task, kind="face", group_ids=group_ids)
        if kind in {"speaker", "both"}:
            result["speaker"] = self._identity_best_effort(config, task, kind="speaker", group_ids=group_ids)
        return result

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
                self._queue_slate_ocr(project_id, config)
            elif task_type == "scene_interval_prepare":
                with self._resource(config, task, "cpu", "source_descriptor", "选定原片区间"):
                    result = self._prepare_scene_interval(project_id, config, task)
                if result.get("status") == "cancelled":
                    self._update(config, task_id, status="cancelled", stage="cancelled", result=result)
                    return
            elif task_type == "multicam_sync":
                with self._resource(config, task, "sync", "sync", "多机位同步"):
                    from .sync_timeline_runtime import cache_previous_sync_timeline

                    cache_previous_sync_timeline(config, project_id, self.list(project_id))
                    result = _impl.run_multicam_sync(
                        config,
                        self._task_message_reporter(config, task_id),
                        progress=lambda done, total: self._update(
                            config,
                            task_id,
                            progress={"done": done, "total": total},
                        ),
                        cancel_requested=lambda: self._cancel_requested(config, task_id),
                        sync_context=(self.workspace_id, project_id, task_id),
                    )
                if result.get("status") == "completed":
                    result["analysis"] = self._post_sync_analysis(project_id, config, task)
                    self._queue_post_sync_analysis(project_id, config, task)
                    self._queue_slate_ocr(project_id, config)
            elif task_type == "incremental_analyze":
                affected = set(str(value) for value in task.get("affected_group_ids", []) if value)
                cross_check = task.get("targets", {}).get("visual_cross_check") is True
                analysis_config = config
                if cross_check and config.asr_backend.strip().lower() in {"cloud", "gemini", "openai"}:
                    analysis_config = replace(config, asr_backend="auto")
                with self._resource(config, task, self._asr_resource(analysis_config), "analysis", "MLX/ASR"):
                    result = _run_analysis(
                        analysis_config,
                        affected or None,
                        progress=self._analysis_progress(config, task_id),
                        cancelled=lambda: self._cancel_requested(config, task_id),
                        workspace_id=self.workspace_id,
                        project_id=project_id,
                    )["index"]["stats"]
                result["affected_group_ids"] = sorted(affected)
                if cross_check:
                    result.update(self._check_script_scenes(config, task, self._scene_check_candidates(config, affected)))
                else:
                    with self._resource(config, task, "vision", "resolve", "视觉/模型救援"):
                        result["automation"] = _impl.resolve_project(config)["summary"]
                local_media = self._refresh_media_bindings(config, project_id)
                if local_media:
                    result["local_media"] = local_media
                selected_groups = sorted(affected) or None
                result["perception"] = self._perception_best_effort(config, task, mode="tier0", group_ids=selected_groups)
                result["identity"] = self._identity_after_analysis(config, task, group_ids=selected_groups)
            elif task_type == "slate_ocr":
                from .slate_ocr_runtime import run_slate_ocr

                self._update(config, task_id, stage="slate_ocr", message="正在逐页识别项目场记…")
                result = run_slate_ocr(
                    config,
                    project_id=project_id,
                    task_id=task_id,
                    progress=lambda done, total: self._update(
                        config,
                        task_id,
                        progress={"done": done, "total": total},
                        message=f"场记识别 {done}/{total} 页",
                    ),
                    cancelled=lambda: self._cancel_requested(config, task_id),
                )
            elif task_type == "auto_resolve":
                if task.get("targets", {}).get("visual_cross_check") is True:
                    group_ids = task["targets"].get("group_ids")
                    if not isinstance(group_ids, list) or not 1 <= len(group_ids) <= 24 or not all(group_ids):
                        raise ValueError("音画核对每次需要指定 1–24 个 Take")
                    groups = set(self._affected_group_ids(config, {"group_ids": group_ids}))
                    result = self._check_script_scenes(config, task, groups)
                else:
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
                        result["analysis"] = _run_analysis(
                            config,
                            affected or None,
                            cancelled=lambda: self._cancel_requested(config, task_id),
                            workspace_id=self.workspace_id,
                            project_id=project_id,
                        )["index"]["stats"]
                    with self._resource(config, task, "vision", "resolve", "视觉/模型救援"):
                        result["automation"] = _impl.resolve_project(config)["summary"]
                    local_media = self._refresh_media_bindings(config, project_id)
                    if local_media:
                        result["local_media"] = local_media
                    selected_groups = sorted(affected) or None
                    result["perception"] = self._perception_best_effort(config, task, mode="tier0", group_ids=selected_groups)
                    result["identity"] = self._identity_after_analysis(config, task, group_ids=selected_groups)
                elif result.get("transcribed"):
                    result["analysis_deferred"] = True
                    result["analysis_deferred_reason"] = "当前设备没有可用项目源/同步产物；转写缓存已写入，可由Host后续分析"
            elif task_type == "identity_index":
                result = self._run_identity_task(config, task)
            elif task_type == "recording_alignment_ai_review":
                from .recording_alignment_ai import run_recording_alignment_ai_review

                with self._resource(config, task, "vision", "ai_review", "同期录音 AI 复核"):
                    result = run_recording_alignment_ai_review(
                        config,
                        project_id=project_id,
                        task=task,
                        workspace_id=self.workspace_id,
                        cancelled=lambda: self._cancel_requested(config, task_id),
                        progress=lambda done, total: self._update(
                            config,
                            task_id,
                            progress={"done": done, "total": total},
                        ),
                    )
            elif task_type == "evidence_extract" and task.get("targets", {}).get("local_visual") is True:
                result = self._index_local_visual_evidence(config, task)
            else:
                self._update(config, task_id, stage="evidence")
                result = self._extract_evidence(config, task)
                group_ids = [str(value) for value in task.get("targets", {}).get("group_ids", []) if str(value)]
                if group_ids:
                    result["perception"] = self._perception_best_effort(config, task, mode="semantic", group_ids=group_ids)
                    result["identity"] = self._identity_after_analysis(config, task, group_ids=group_ids, explicit=True)

            if task_type in {"multicam_sync", "prepare_project"} and config.is_media_directory:
                from .sync_timeline_runtime import cache_previous_sync_timeline

                cache_previous_sync_timeline(config, project_id, [{
                    **task, "status": "completed", "stage": "completed", "message": "任务完成",
                }])
            self._persist_project_summary(project_id, config, task_type, result)
            self._update(config, task_id, status="completed", stage="completed", result=result, message="任务完成")
        except ResourceCancelled as error:
            message = str(error).strip() or "任务已取消"
            self._update(config, task_id, status="cancelled", stage="cancelled", message=message)
        except Exception as error:
            self._update(config, task_id, status="failed", stage="failed", error=str(error), message="任务失败")
        finally:
            self._threads.pop(task_id, None)

    def _prepare_project(self, project_id: str, config, task: dict[str, Any]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        task_id = str(task["task_id"])

        def report(phase: str, done: int, total: int, message: str) -> None:
            stage = {"asr": "analysis", "matching": "analysis", "rescue": "resolve"}.get(phase, phase)
            self._update(
                config,
                task_id,
                stage=stage,
                progress={"done": done, "total": total},
                message=message,
            )

        if config.is_media_directory:
            with self._resource(config, task, "sync", "sync", "多机位同步"):
                result["sync"] = _impl.run_multicam_sync(
                    config,
                    lambda text: self._update(config, task_id, message=text),
                    progress=lambda done, total: self._update(
                        config,
                        task["task_id"],
                        progress={"done": done, "total": total},
                    ),
                    cancel_requested=lambda: self._cancel_requested(config, task_id),
                    sync_context=(self.workspace_id, project_id, task_id),
                )
            if self._cancel_requested(config, task_id):
                return {**result, "cancelled": True}

        if not _impl._analysis_inputs_available(config):
            raise ValueError("项目源输入不完整，无法执行自动准备")

        with self._resource(config, task, self._asr_resource(config), "analysis", "MLX/ASR"):
            self._update(
                config,
                task_id,
                progress={"done": 0, "total": 3},
                message="开始 ASR 与剧本匹配；正在建立素材索引、读取缓存并匹配剧本",
            )
            analysis = _run_analysis(
                config,
                progress=report,
                cancelled=lambda: self._cancel_requested(config, task_id),
                workspace_id=self.workspace_id,
                project_id=project_id,
            )
        self._update(config, task_id, progress={"done": 1, "total": 3}, message="ASR 与剧本匹配完成")
        result["analysis"] = analysis["index"]["stats"]
        if self._cancel_requested(config, task_id):
            return {**result, "cancelled": True}

        with self._resource(config, task, "vision", "resolve", "视觉/模型救援"):
            self._update(
                config,
                task_id,
                progress={"done": 1, "total": 3},
                message="自动确认剧本归属并处理疑难 Take",
            )
            automation = _impl.resolve_project(config)
        self._update(config, task_id, progress={"done": 2, "total": 3}, message="自动归集完成，准备处理感知索引")
        result["automation"] = automation["summary"]
        result["model"] = automation.get("model", {})
        local_media = self._refresh_media_bindings(config, project_id)
        if local_media:
            result["local_media"] = local_media
        if not self._cancel_requested(config, task_id):
            result["perception"] = self._perception_best_effort(config, task, mode="tier0")
            result["identity"] = self._identity_after_analysis(config, task)
        self._update(config, task_id, progress={"done": 3, "total": 3}, message="项目整理阶段完成")
        return result

    def _transcribe(self, config, task: dict[str, Any]) -> dict[str, Any]:
        with self._resource(config, task, self._asr_resource(config), "asr", "MLX/ASR"):
            return super()._transcribe(config, task)


__all__ = ["TASK_TYPES", "TaskManager", "analyze", "COMPAT_TASK_TYPES"]
