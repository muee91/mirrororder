from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from .audit_engine import FAILURE_TAXONOMY, AuditEngine, _analysis_revision
from .audit_store import AuditStore


_INSTALLED = False


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _audit_for_project(project: Any) -> tuple[dict[str, Any], str, bool]:
    payload = AuditStore(project.config.output_dir).load()
    current = _analysis_revision(project.config.output_dir)
    stale = bool(payload.get("analysis_revision") and payload.get("analysis_revision") != current)
    return payload, current, stale


def _safe_judge(value: object) -> dict[str, Any]:
    """Keep model/runtime implementation details out of the team Web contract."""
    raw = _as_dict(value)
    return {
        "verdict": str(raw.get("verdict", "") or ""),
        "confidence": float(raw.get("confidence", 0) or 0),
        "reason": str(raw.get("reason", "") or ""),
    }


def install_audit_runtime() -> None:
    """Layer audit.v1 onto Host reads without changing review authority.

    The expensive judge is an explicit, resource-scheduled Host task. Raw audit
    artifacts stay App-local; ordinary Web receives only the safe review.v1
    projection. No audit result is allowed to write review/editorial/automation.
    """

    global _INSTALLED
    if _INSTALLED:
        return

    from . import review_read_model, tasks as tasks_module, web_server
    from .resource_scheduler import ResourceCancelled

    original_build = review_read_model.build_review_read_model
    original_state = web_server.ProjectService.state
    original_make_handler = web_server.make_handler
    original_task_run = tasks_module.TaskManager._run

    # TASK_TYPES is the compatibility alias of tasks_v2.TASK_TYPES, so one add
    # updates submit validation without duplicating task persistence.
    tasks_module.TASK_TYPES.add("audit")

    def build_with_audit(project: Any, **kwargs: Any) -> dict[str, Any]:
        payload = original_build(project, **kwargs)
        audit, current_revision, stale = _audit_for_project(project)
        rows = _as_dict(audit.get("groups"))
        current_groups = 0
        for take in _as_list(payload.get("take_groups")):
            if not isinstance(take, dict):
                continue
            group_id = str(take.get("group_id", "") or "")
            row = _as_dict(rows.get(group_id))
            row_current = bool(row and row.get("analysis_revision") == current_revision)
            if not row_current:
                take["audit_state"] = {"available": bool(row), "stale": bool(row)}
                continue
            current_groups += 1
            take["audit_state"] = {
                "available": True,
                "stale": False,
                "priority": int(row.get("priority", 0) or 0),
                "judge": _safe_judge(row.get("judge")),
                "algorithm_feedback": _as_dict(row.get("algorithm_feedback")),
                "rough_cut": _as_dict(row.get("rough_cut")),
                "role_suggestions": _as_list(row.get("role_suggestions")),
            }
            take["role_suggestions"] = _as_list(row.get("role_suggestions"))
            shot = _as_dict(row.get("shot_intelligence"))
            take["shot_intelligence"] = shot
            angle_rows = _as_dict(shot.get("angles"))
            for angle in _as_list(take.get("angles")):
                if not isinstance(angle, dict):
                    continue
                clip_id = str(angle.get("clip_id", "") or "")
                intelligence = _as_dict(angle_rows.get(clip_id))
                if not intelligence:
                    continue
                angle["shot_type"] = str(intelligence.get("shot_type", "unknown") or "unknown")
                angle["coverage_role"] = str(intelligence.get("coverage_role", "unknown") or "unknown")
                angle["visible_people"] = [
                    str(value) for value in _as_list(intelligence.get("visible_people")) if str(value)
                ]
                angle["technical_issues"] = [
                    str(value) for value in _as_list(intelligence.get("technical_issues")) if str(value)
                ]
            issues = take.get("issues", []) if isinstance(take.get("issues"), list) else []
            for issue in _as_list(row.get("issues")):
                if not isinstance(issue, dict):
                    continue
                issues.append(
                    {
                        "code": str(issue.get("code", "other") or "other"),
                        "severity": str(issue.get("severity", "warning") or "warning"),
                        "label": str(issue.get("label", "素材审计问题") or "素材审计问题"),
                        "detail": str(issue.get("detail", "") or ""),
                        "source": str(issue.get("source", "audit") or "audit"),
                    }
                )
            take["issues"] = issues

        payload.setdefault("revisions", {})["audit"] = int(audit.get("revision", 0) or 0)
        payload["revisions"]["audit_analysis"] = str(audit.get("analysis_revision", "") or "")
        payload.setdefault("capabilities", {}).update(
            {
                "audit_v1": True,
                "shot_intelligence": True,
                "actor_role_suggestions": True,
                "audit_write_scope": "host_local",
                "audit_is_review_authority": False,
            }
        )
        payload.setdefault("summary", {})["audit"] = {
            **_as_dict(audit.get("summary")),
            "current_groups": current_groups,
            "stale": stale,
        }
        payload["audit_state"] = {
            "version": int(audit.get("version", 1) or 1),
            "contract": str(audit.get("contract", "audit.v1") or "audit.v1"),
            "revision": int(audit.get("revision", 0) or 0),
            "updated_at": str(audit.get("updated_at", "") or ""),
            "analysis_revision": str(audit.get("analysis_revision", "") or ""),
            "stale": stale,
            "summary": _as_dict(audit.get("summary")),
        }
        return payload

    def state_with_audit(project: Any) -> dict[str, Any]:
        payload = original_state(project)
        audit, current_revision, stale = _audit_for_project(project)
        payload["audit_revision"] = int(audit.get("revision", 0) or 0)
        payload["audit_updated_at"] = str(audit.get("updated_at", "") or "")
        payload["audit_analysis_revision"] = str(audit.get("analysis_revision", "") or "")
        payload["audit_current_analysis_revision"] = current_revision
        payload["audit_stale"] = stale
        return payload

    def run_with_audit(manager: Any, project_id: str, task_id: str) -> None:
        config = manager.project_loader(project_id)
        try:
            task = manager._task(manager._load(config), task_id)
        except Exception:
            return original_task_run(manager, project_id, task_id)
        if str(task.get("type", "")) != "audit":
            return original_task_run(manager, project_id, task_id)

        try:
            manager._update(config, task_id, status="running", stage="starting", message="素材审计开始")
            if manager._cancel_requested(config, task_id):
                manager._update(config, task_id, status="cancelled", stage="cancelled", message="素材审计已取消")
                return
            targets = task.get("targets", {}) if isinstance(task.get("targets"), dict) else {}
            mode = str(targets.get("mode", "priority") or "priority")
            raw_groups = targets.get("group_ids", [])
            if not isinstance(raw_groups, list):
                raise ValueError("audit group_ids 必须是数组")
            group_ids = [str(value) for value in raw_groups if str(value)] or None
            try:
                max_groups = max(0, min(1000, int(targets.get("max_groups", 60) or 0)))
            except (TypeError, ValueError):
                max_groups = 60

            with manager._resource(config, task, "vision", "audit", "素材审计"):
                engine = AuditEngine(manager.workspace_id, project_id, config)
                last_reported = {"done": -1}

                def report(done: int, total: int, group_id: str) -> None:
                    if done == total or done - last_reported["done"] >= 5:
                        last_reported["done"] = done
                        manager._update(
                            config,
                            task_id,
                            progress={"audit_done": done, "audit_total": total},
                            message=f"素材审计 {done}/{total} · {group_id}",
                        )

                result = engine.run(
                    mode=mode,
                    group_ids=group_ids,
                    max_groups=max_groups,
                    progress=report,
                    cancelled=lambda: manager._cancel_requested(config, task_id),
                )
            if result.get("status") == "cancelled":
                manager._update(
                    config,
                    task_id,
                    status="cancelled",
                    stage="cancelled",
                    result=result,
                    message="素材审计已取消",
                )
                return
            manager._update(
                config,
                task_id,
                status="completed",
                stage="completed",
                result=result,
                message="素材审计完成",
            )
        except ResourceCancelled:
            manager._update(
                config,
                task_id,
                status="cancelled",
                stage="cancelled",
                message="等待视觉资源时审计已取消",
            )
        except Exception as error:
            manager._update(
                config,
                task_id,
                status="failed",
                stage="failed",
                error=str(error),
                message="素材审计失败",
            )
        finally:
            manager._threads.pop(task_id, None)

    def make_handler_with_audit(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if len(parts) == 5 and parts[:3] == ["api", "v1", "projects"] and parts[4] == "audit":
                    self._local_only()
                    project = service.project(parts[3])
                    audit, current_revision, stale = _audit_for_project(project)
                    self._send_json(
                        {
                            **audit,
                            "stale": stale,
                            "current_analysis_revision": current_revision,
                            "failure_taxonomy": FAILURE_TAXONOMY,
                        }
                    )
                    return
                return super()._app_get(parsed)

            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if len(parts) == 5 and parts[:3] == ["api", "v1", "projects"] and parts[4] == "audit":
                    self._local_only()
                    project_id = parts[3]
                    service.registry.get(project_id)
                    body = web_server._body(self)
                    mode = str(body.get("mode", "priority") or "priority")
                    if mode not in {"priority", "all"}:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "audit mode 必须是 priority 或 all")
                    raw_groups = body.get("group_ids", [])
                    if not isinstance(raw_groups, list):
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "group_ids 必须是数组")
                    try:
                        max_groups = max(0, min(1000, int(body.get("max_groups", 60) or 0)))
                    except (TypeError, ValueError):
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "max_groups 必须是整数")
                    task = service.tasks.submit(
                        project_id,
                        "audit",
                        {
                            "mode": mode,
                            "group_ids": [str(value) for value in raw_groups if str(value)],
                            "max_groups": max_groups,
                        },
                        idempotency_key=f"audit:{project_id}:{mode}:{time.time_ns()}",
                        actor="mirrororder-app",
                    )
                    self._send_json({"task": task}, web_server.HTTPStatus.ACCEPTED)
                    return
                return super()._app_post(parsed)

        return Handler

    review_read_model.build_review_read_model = build_with_audit
    web_server.ProjectService.state = state_with_audit
    web_server.make_handler = make_handler_with_audit
    tasks_module.TaskManager._run = run_with_audit
    _INSTALLED = True
