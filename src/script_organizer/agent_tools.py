from __future__ import annotations

import json
import sqlite3
from collections import Counter
from fractions import Fraction
from pathlib import Path
from typing import Any

from .assistant_store import AssistantStore, _basename
from .audit_engine import _analysis_revision, _float, _mapping_for_group
from .audit_store import AuditStore
from .automation_store import AutomationStore
from .editorial_store import EditorialStore
from .learning_dataset import write_learning_dataset
from .model_registry import ModelRegistry
from .models import Clip, Transcript
from .review_store import ReviewStore
from .script_supervisor_store import ScriptSupervisorStore
from .semantic_store import SemanticStore
from .transcript import TranscriptStore
from .workspace_db import WorkspaceDatabase


def _read(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _candidate_ids(candidate: dict[str, Any]) -> list[str]:
    raw = candidate.get("script_segment_ids") or (
        [candidate.get("script_segment_id")] if candidate.get("script_segment_id") else []
    )
    return [str(value) for value in _as_list(raw) if str(value)]


def _ranked_candidates(match: dict[str, Any]) -> list[dict[str, Any]]:
    return sorted(
        (item for item in _as_list(match.get("candidates")) if isinstance(item, dict)),
        key=lambda item: _float(item.get("total_score"), 0.0),
        reverse=True,
    )


class CachedProjectEvidence:
    """Project cache receipts shared by the steward and structured search."""

    def __init__(self, config: Any):
        output = config.output_dir
        index = _read(output / "material_index.json")
        self.groups = {
            row["group_id"]: row for row in _as_list(index.get("groups"))
            if isinstance(row, dict) and isinstance(row.get("group_id"), str) and row["group_id"]
        }
        self.clips = {
            row["clip_id"]: row for row in _as_list(index.get("clips"))
            if isinstance(row, dict) and isinstance(row.get("clip_id"), str) and row["clip_id"]
        }
        self.members: dict[tuple[str, str], dict[str, Any]] = {}
        for group_id, group in self.groups.items():
            for member in _as_list(group.get("members")):
                clip_id = _as_dict(member).get("clip_id")
                if isinstance(clip_id, str) and clip_id:
                    clip = self.clips.setdefault(clip_id, dict(member))
                    merged = {**clip, **member}
                    for key in ("media_id", "media_path", "name", "file_name", "camera"):
                        value = member.get(key) or clip.get(key)
                        if value:
                            merged[key] = value
                            if not clip.get(key):
                                clip[key] = value
                    self.members[group_id, clip_id] = merged
        self.segments = {
            row["segment_id"]: row for row in _as_list(_read(output / "script.json").get("segments"))
            if isinstance(row, dict) and isinstance(row.get("segment_id"), str) and row["segment_id"]
        }
        self.matches = _read(output / "matches.json")
        review = ReviewStore(output / "review.json").load()
        self.automation = AutomationStore(output).load()["groups"]
        self.mappings = {
            group_id: _mapping_for_group(review, _as_dict(self.automation.get(group_id)), group)
            for group_id, group in self.groups.items()
        }
        self.excluded = {
            group_id for group_id, group in self.groups.items()
            if group_id in review["exclusions"] or group.get("parent_group_id") in review["exclusions"]
        }
        self.unmapped = {
            group_id for group_id, mapping in self.mappings.items()
            if group_id not in self.excluded and not (mapping["script_segment_ids"] or mapping["episode_ids"])
        }
        self.editorial = EditorialStore(output).load()
        self.editorial_states = {
            group_id: _as_dict(self.editorial["decisions"].get(f"group|{group_id}")).get("state")
            for group_id in self.groups
        }
        try:
            board = ScriptSupervisorStore(output).load()
        except (OSError, TypeError, ValueError):
            board = {}
        self.slate_entries = _as_dict(board.get("entries"))
        self.slate_records = _as_dict(board.get("records"))
        audit = AuditStore(output).load()
        current_revision = _analysis_revision(output) if audit.get("groups") else ""
        self.shots = {
            group_id: _as_dict(row.get("shot_intelligence"))
            for group_id, row in audit["groups"].items()
            if group_id in self.groups and isinstance(row, dict)
            and (row.get("analysis_revision") or audit.get("analysis_revision") or current_revision) == current_revision
        }
        self.transcripts = TranscriptStore(config.transcript_dir, create=False)
        self._cached_transcripts: dict[tuple[str, str, str], Transcript | None] = {}

    def transcript_for(self, row: dict[str, Any]) -> Transcript | None:
        name = _basename(row.get("name") or row.get("file_name"))
        media_id = str(row.get("media_id") or "")
        if "/" in media_id or "\\" in media_id:
            media_id = ""
        if not name and not media_id:
            return None
        media_path = str(row.get("media_path") or self.transcripts.directory / name)
        key = (media_id, name, media_path)
        if key not in self._cached_transcripts:
            clip = Clip(
                clip_id=str(row["clip_id"]), name=name, camera=str(row.get("camera") or ""),
                media_path=media_path, timeline_start=Fraction(0), timeline_end=Fraction(0),
                duration=Fraction(0), exists=False, media_id=media_id,
            )
            try:
                self._cached_transcripts[key] = self.transcripts.load(clip)
            except (OSError, ValueError):
                self._cached_transcripts[key] = None
        return self._cached_transcripts[key]

    def visual_group_ids(self) -> set[str]:
        return {
            group_id for group_id, shot in self.shots.items()
            if shot.get("summary") or any(
                any(angle.get(key) not in ("", "unknown", None, [], {}) for key in (
                    "shot_type", "coverage_role", "summary", "description", "visible_people", "technical_issues",
                ))
                for angle in _as_dict(shot.get("angles")).values() if isinstance(angle, dict)
            )
        }


def _audit_freshness(
    group: dict[str, Any],
    automatic: dict[str, Any],
    review: dict[str, Any],
    audit_row: dict[str, Any],
    current_analysis: str,
) -> tuple[bool, bool]:
    visual_current = bool(
        audit_row
        and str(audit_row.get("analysis_revision", "") or "") == current_analysis
    )
    if not visual_current:
        return False, False
    current_mapping = _mapping_for_group(review, automatic, group)
    mapping_current = _as_dict(audit_row.get("mapping")) == current_mapping
    return True, mapping_current


class AgentToolRegistry:
    """Allowlisted first-party tools used by the MirrorOrder assistant.

    The registry intentionally exposes production capabilities rather than raw
    filesystem access. None of these tools may write review/editorial decisions.
    """

    SAFE_ACTIONS = {
        "run_priority_audit",
        "extract_visual_evidence",
        "index_unknown_identities",
        "collect_learning_cases",
        "noop",
    }

    def __init__(
        self, workspace_id: str, project_id: str, config: Any, task_manager: Any | None = None,
        *, assistant_store: AssistantStore | None = None,
    ):
        self.workspace_id = str(workspace_id or "")
        self.project_id = str(project_id or "")
        self.config = config
        self.task_manager = task_manager
        self._assistant_store = assistant_store

    def task_snapshot(self) -> list[dict[str, Any]]:
        if self.task_manager is None:
            return []
        from .tasks import TaskManager

        try:
            if isinstance(self.task_manager, TaskManager):
                # TaskManager.list can persist restart recovery on its first read.
                rows = reversed(_as_list(_read(self.config.output_dir / "tasks.json").get("tasks")))
            else:
                rows = self.task_manager.list(self.project_id)
            return [row for row in rows if isinstance(row, dict)]
        except (OSError, ValueError, RuntimeError, KeyError, TypeError):
            return []

    def steward_overview(self, *, evidence: CachedProjectEvidence | None = None) -> dict[str, Any]:
        """Summarize persisted project facts without running production work."""
        output = self.config.output_dir
        evidence = evidence if evidence is not None else CachedProjectEvidence(self.config)
        matches = evidence.matches
        gaps = _as_list(matches.get("script_gaps"))
        gap_samples = []
        for gap in gaps[:10]:
            row = _as_dict(gap)
            segment_ids = _as_list(row.get("segment_ids")) or [row.get("segment_id") or gap]
            segment = next(
                (evidence.segments[item] for item in segment_ids if isinstance(item, str) and item in evidence.segments),
                {},
            )
            gap_samples.append({
                "gap_id": str(row.get("gap_id") or ""),
                "segment_id": str(segment.get("segment_id") or row.get("segment_id") or ""),
                "episode": segment.get("episode") or row.get("episode"),
                "scene_id": str(segment.get("scene_id") or row.get("scene_id") or ""),
                "scene": str(segment.get("scene") or row.get("scene") or ""),
                "speaker": str(segment.get("speaker") or row.get("speaker") or ""),
                "text": str(segment.get("text") or segment.get("raw_text") or row.get("text") or "")[:120],
            })

        match_groups = _as_dict(matches.get("groups"))
        review_counts = {
            "mapped": len(evidence.groups) - len(evidence.unmapped) - len(evidence.excluded),
            "unmapped": len(evidence.unmapped),
            "excluded": len(evidence.excluded),
            "human_conflicts": 0,
        }
        for group_id, mapping in evidence.mappings.items():
            if mapping["source"] == "human" and mapping["script_segment_ids"]:
                candidates = _ranked_candidates(_as_dict(match_groups.get(group_id)))
                candidate = candidates[0] if candidates else {}
                automatic = _as_dict(evidence.automation.get(group_id))
                other_ids = _candidate_ids(candidate) or _as_list(automatic.get("script_segment_ids"))
                if other_ids and set(mapping["script_segment_ids"]) != {str(item) for item in other_ids}:
                    review_counts["human_conflicts"] += 1

        editorial = evidence.editorial
        decisions = editorial["decisions"]
        editorial_counts = dict.fromkeys(("best", "keep", "reject", "undecided"), 0)
        for state in evidence.editorial_states.values():
            editorial_counts[state if state in ("best", "keep", "reject") else "undecided"] += 1
        pending = {
            _as_dict(opinion.get("target")).get("group_id") for key, opinion in editorial["opinions"].items()
            if opinion["reviewers"] and _as_dict(decisions.get(key)).get("state") not in ("best", "keep", "reject")
        }
        editorial_counts["pending_team_opinions"] = len(pending.intersection(evidence.groups))

        slate_counts = dict.fromkeys(("ng", "partial", "usable", "with_notes"), 0)
        highlights = []
        for record in evidence.slate_records.values():
            status = record.get("status")
            note = str(record.get("note") or "")
            if status in ("ng", "partial", "usable"):
                slate_counts[status] += 1
            if note:
                slate_counts["with_notes"] += 1
            if status in ("ng", "partial", "usable") or note or record.get("usable_range"):
                highlights.append({
                    "group_id": record.get("source_group_id") or "",
                    **{key: record.get(key) for key in ("scene", "shot", "take_number", "status", "usable_range")},
                    "note": note[:120],
                })
        highlights.sort(key=lambda row: {"ng": 0, "partial": 1, "usable": 2}.get(row["status"], 3))

        tasks: dict[str, list[dict[str, str]]] = {"active": [], "failed": []}
        for row in self.task_snapshot():
            status = row.get("status")
            if status in ("queued", "running"):
                bucket = tasks["active"]
            elif status == "failed" and len(tasks["failed"]) < 10:
                bucket = tasks["failed"]
            else:
                continue
            bucket.append({
                key: value[:320] for key in ("task_id", "type", "status", "stage", "message")
                if isinstance((value := row.get(key)), str) and "/" not in value and "\\" not in value
            })

        semantic, identities = self._steward_local_indexes()
        coverage = {
            "total_groups": len(evidence.groups),
            "total_clips": len(evidence.clips),
            "transcribed_clips": sum(
                bool(item.text.strip() or item.segments)
                for clip in evidence.clips.values()
                if (item := evidence.transcript_for(clip)) is not None
            ),
            "visual_indexed_groups": len(evidence.visual_group_ids()),
            "semantic_documents": semantic.get("documents", 0),
            "semantic_sources": semantic.get("sources", {}),
        }
        store = self._assistant_store or AssistantStore(output, secrets=ModelRegistry().private_values())
        return store.sanitize({
            "project": {
                **self.inspect_project(),
                "is_media_directory": bool(getattr(self.config, "is_media_directory", False)),
            },
            "script_gaps": {"count": len(gaps), "samples": gap_samples},
            "review": review_counts,
            "editorial": editorial_counts,
            "slate": {**slate_counts, "highlights": highlights[:10]},
            "identities": identities,
            "tasks": tasks,
            "index_coverage": coverage,
        })

    def _steward_local_indexes(self) -> tuple[dict[str, Any], dict[str, Any]]:
        semantic: dict[str, Any] = {}
        rows = []
        try:
            database = WorkspaceDatabase(self.workspace_id, read_only=True)
            semantic = SemanticStore(database, read_only=True).summary(self.project_id)
            with database.connection() as connection:
                rows = [dict(row) for row in connection.execute(
                    """SELECT role_name, label, CASE WHEN json_valid(metadata_json)
                       THEN json_extract(metadata_json, '$.human_confirmed') END AS confirmed
                       FROM identities WHERE project_id = ? ORDER BY role_name, label""",
                    (self.project_id,),
                )]
        except (OSError, ValueError, sqlite3.Error):
            pass
        if not rows:
            saved = _read(self.config.output_dir / "identities.json").get("identities")
            values = saved.values() if isinstance(saved, dict) else _as_list(saved)
            rows = [
                {**row, "confirmed": row.get("confirmed") or _as_dict(row.get("metadata")).get("human_confirmed")}
                for row in values if isinstance(row, dict)
            ]
        names = dict.fromkeys(
            (str(row.get("role_name") or ""), str(row.get("label") or ""))
            for row in rows if row.get("confirmed") is True or row.get("confirmed") == 1
        )
        return semantic, {
            "confirmed": [{"role_name": role, "label": label} for role, label in names if role or label],
            "unconfirmed_count": sum(row.get("confirmed") not in (True, 1) for row in rows),
        }

    def inspect_project(self) -> dict[str, Any]:
        index = _read(self.config.output_dir / "material_index.json")
        matches = _read(self.config.output_dir / "matches.json")
        automation = AutomationStore(self.config.output_dir).load()
        review = ReviewStore(self.config.output_dir / "review.json").load()
        audit = AuditStore(self.config.output_dir).load()
        attention = self.list_attention_groups(limit=120)
        return {
            "project_id": self.project_id,
            "name": str(getattr(self.config, "name", self.project_id) or self.project_id),
            "stats": _as_dict(index.get("stats")),
            "automation": _as_dict(automation.get("summary")),
            "review_revision": int(review.get("revision", 0) or 0),
            "audit_revision": int(audit.get("revision", 0) or 0),
            "audit_summary": _as_dict(audit.get("summary")),
            "script_gaps": len(_as_list(matches.get("script_gaps"))),
            "attention": {
                "total": len(attention),
                "high": sum(1 for row in attention if int(row.get("priority", 0) or 0) >= 80),
            },
        }

    def list_attention_groups(self, *, limit: int = 60) -> list[dict[str, Any]]:
        index = _read(self.config.output_dir / "material_index.json")
        matches = _as_dict(_read(self.config.output_dir / "matches.json").get("groups"))
        automation = _as_dict(AutomationStore(self.config.output_dir).load().get("groups"))
        review = ReviewStore(self.config.output_dir / "review.json").load()
        audit = _as_dict(AuditStore(self.config.output_dir).load().get("groups"))
        placements = _as_dict(review.get("placements"))
        current_analysis = _analysis_revision(self.config.output_dir)
        rows: list[dict[str, Any]] = []
        for group in _as_list(index.get("groups")):
            if not isinstance(group, dict):
                continue
            group_id = str(group.get("group_id", "") or "")
            if not group_id:
                continue
            automatic = _as_dict(automation.get(group_id))
            status = str(automatic.get("status", "") or "")
            match = _as_dict(matches.get(group_id))
            candidates = _ranked_candidates(match)
            first = candidates[0] if candidates else {}
            second = candidates[1] if len(candidates) > 1 else {}
            margin = (
                _float(first.get("total_score"), 0.0) - _float(second.get("total_score"), 0.0)
                if first and second else 1.0
            )
            manual = _as_dict(placements.get(group_id))
            manual_ids = [str(value) for value in _as_list(manual.get("script_segment_ids")) if str(value)]
            top_ids = _candidate_ids(first)
            audit_row = _as_dict(audit.get(group_id))
            visual_current, mapping_current = _audit_freshness(
                group,
                automatic,
                review,
                audit_row,
                current_analysis,
            )
            if mapping_current:
                judge = _as_dict(audit_row.get("judge"))
                issues = [item for item in _as_list(audit_row.get("issues")) if isinstance(item, dict)]
                role_suggestions = [
                    item for item in _as_list(audit_row.get("role_suggestions"))
                    if isinstance(item, dict) and item.get("role_name")
                ]
            else:
                # Mapping-sensitive AI output must never survive a human mapping
                # change in the assistant queue. Media-derived shot intelligence
                # remains available through review.v1 / inspect_take instead.
                judge = {}
                issues = []
                role_suggestions = []
            codes = {str(item.get("code", "") or "") for item in issues}
            priority = 0
            reasons: list[str] = []
            if manual_ids and top_ids and set(manual_ids) != set(top_ids):
                priority = max(priority, 100)
                reasons.append("human_mapping_conflict")
            if str(judge.get("verdict", "") or "") == "disagree":
                priority = max(priority, 96)
                reasons.append("audit_disagreement")
            if status == "unresolved":
                priority = max(priority, 90)
                reasons.append("unresolved")
            elif status == "needs_review":
                priority = max(priority, 86)
                reasons.append("needs_review")
            if first and second and margin < 0.08:
                priority = max(priority, 82)
                reasons.append("candidate_competition")
            if "missing_media" in codes:
                priority = max(priority, 95)
                reasons.append("missing_media")
            if "technical_quality" in codes or "continuity_risk" in codes:
                priority = max(priority, 66)
                reasons.append("material_quality")
            if not first:
                priority = max(priority, 84)
                reasons.append("no_candidate")
            if role_suggestions:
                priority = max(priority, 38)
                reasons.append("role_candidate")
            if priority <= 0:
                continue
            rows.append(
                {
                    "group_id": group_id,
                    "priority": priority,
                    "reasons": list(dict.fromkeys(reasons)),
                    "automatic_status": status,
                    "audit_visual_current": visual_current,
                    "audit_mapping_stale": bool(visual_current and not mapping_current),
                    "candidate": {
                        "candidate_id": str(first.get("candidate_id", "") or ""),
                        "script_segment_ids": top_ids,
                        "total_score": _float(first.get("total_score"), 0.0),
                        "margin": margin,
                    },
                    "audit_verdict": str(judge.get("verdict", "") or ""),
                    "audit_reason": str(judge.get("reason", "") or "")[:500],
                    "role_suggestions": [
                        {
                            "role_name": str(item.get("role_name", "") or ""),
                            "confidence": float(item.get("confidence", 0) or 0),
                            "requires_confirmation": True,
                        }
                        for item in role_suggestions[:3]
                    ],
                }
            )
        rows.sort(key=lambda row: (-int(row["priority"]), str(row["group_id"])))
        return rows[: max(1, min(500, int(limit)))]

    def inspect_take(self, group_id: str) -> dict[str, Any]:
        target = str(group_id or "")
        index = _read(self.config.output_dir / "material_index.json")
        group = next(
            (item for item in _as_list(index.get("groups")) if isinstance(item, dict) and str(item.get("group_id", "")) == target),
            None,
        )
        if group is None:
            raise KeyError(target)
        matches = _as_dict(_read(self.config.output_dir / "matches.json").get("groups"))
        automation_groups = _as_dict(AutomationStore(self.config.output_dir).load().get("groups"))
        automatic = _as_dict(automation_groups.get(target))
        review = ReviewStore(self.config.output_dir / "review.json").load()
        audit = _as_dict(AuditStore(self.config.output_dir).load().get("groups")).get(target, {})
        audit_row = _as_dict(audit)
        visual_current, mapping_current = _audit_freshness(
            group,
            automatic,
            review,
            audit_row,
            _analysis_revision(self.config.output_dir),
        )
        audit_payload: dict[str, Any] = {
            "available": bool(audit_row),
            "visual_current": visual_current,
            "mapping_current": mapping_current,
            "mapping_stale": bool(visual_current and not mapping_current),
            "shot_intelligence": _as_dict(audit_row.get("shot_intelligence")) if visual_current else {},
        }
        if mapping_current:
            audit_payload.update(
                {
                    "judge": _as_dict(audit_row.get("judge")),
                    "issues": _as_list(audit_row.get("issues")),
                    "rough_cut": _as_dict(audit_row.get("rough_cut")),
                    "role_suggestions": _as_list(audit_row.get("role_suggestions")),
                }
            )
        return {
            "group_id": target,
            "kind": str(group.get("kind", "") or ""),
            "cameras": [str(value) for value in _as_list(group.get("cameras")) if str(value)],
            "duration": float(group.get("duration", 0) or 0),
            "candidates": _as_list(_as_dict(matches.get(target)).get("candidates"))[:5],
            "automatic": automatic,
            "audit": audit_payload,
        }

    def model_status(self) -> dict[str, Any]:
        return ModelRegistry().public()

    def _active_task(self, task_type: str) -> dict[str, Any] | None:
        if self.task_manager is None:
            return None
        return next(
            (
                task for task in self.task_manager.list(self.project_id)
                if task.get("type") == task_type and task.get("status") in {"queued", "running"}
            ),
            None,
        )

    def run_priority_audit(self, group_ids: list[str] | None = None, *, max_groups: int = 24) -> dict[str, Any]:
        if self.task_manager is None:
            raise RuntimeError("当前上下文不能提交Host任务")
        active = self._active_task("audit")
        if active:
            return {"status": "already_running", "task_id": str(active.get("task_id", ""))}
        selected = [str(value) for value in (group_ids or []) if str(value)]
        revision = _analysis_revision(self.config.output_dir)
        task = self.task_manager.submit(
            self.project_id,
            "audit",
            {
                "mode": "priority",
                "group_ids": selected[:120],
                "max_groups": max(1, min(120, int(max_groups))),
            },
            idempotency_key=(
                f"assistant-audit:{self.project_id}:{revision}:"
                f"{','.join(selected[:24]) or 'priority'}"
            ),
            actor="mirrororder-assistant",
        )
        return {"status": "submitted", "task_id": str(task.get("task_id", ""))}

    def extract_visual_evidence(self, group_ids: list[str]) -> dict[str, Any]:
        if self.task_manager is None:
            raise RuntimeError("当前上下文不能提交Host任务")
        selected = list(dict.fromkeys(str(value) for value in group_ids if str(value)))[:12]
        if not selected:
            raise ValueError("视觉证据提取至少需要一个 group_id")
        active = self._active_task("evidence_extract")
        if active:
            return {"status": "already_running", "task_id": str(active.get("task_id", ""))}
        revision = _analysis_revision(self.config.output_dir)
        task = self.task_manager.submit(
            self.project_id,
            "evidence_extract",
            {"group_ids": selected},
            idempotency_key=f"assistant-evidence:{self.project_id}:{revision}:{','.join(selected)}",
            actor="mirrororder-assistant",
        )
        return {"status": "submitted", "task_id": str(task.get("task_id", ""))}

    def index_unknown_identities(self, group_ids: list[str], *, kind: str = "both") -> dict[str, Any]:
        if self.task_manager is None:
            raise RuntimeError("当前上下文不能提交Host任务")
        if kind not in {"face", "speaker", "both"}:
            raise ValueError("identity kind 必须是 face、speaker 或 both")
        selected = list(dict.fromkeys(str(value) for value in group_ids if str(value)))[:16]
        if not selected:
            raise ValueError("身份识别至少需要一个 group_id")
        active = self._active_task("identity_index")
        if active:
            return {"status": "already_running", "task_id": str(active.get("task_id", ""))}
        revision = _analysis_revision(self.config.output_dir)
        task = self.task_manager.submit(
            self.project_id,
            "identity_index",
            {"kind": kind, "group_ids": selected},
            idempotency_key=f"assistant-identity:{self.project_id}:{revision}:{kind}:{','.join(selected)}",
            actor="mirrororder-assistant",
        )
        return {"status": "submitted", "task_id": str(task.get("task_id", ""))}

    def collect_learning_cases(self) -> dict[str, Any]:
        audit = AuditStore(self.config.output_dir).load()
        return write_learning_dataset(self.config, audit)

    def failure_patterns(self, *, limit: int = 8) -> list[dict[str, Any]]:
        path = self.config.output_dir / "learning_cases.jsonl"
        counter: Counter[str] = Counter()
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        for line in lines:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if not isinstance(row, dict):
                continue
            failure = str(_as_dict(row.get("audit")).get("failure_class", "") or "").strip()
            if failure:
                counter[failure] += 1
            for code in _as_list(_as_dict(row.get("audit")).get("issue_codes")):
                if str(code):
                    counter[f"issue:{code}"] += 1
        return [{"pattern": key, "count": count} for key, count in counter.most_common(max(1, int(limit)))]

    def execute(self, name: str, arguments: dict[str, Any] | None = None) -> dict[str, Any]:
        tool = str(name or "")
        args = arguments if isinstance(arguments, dict) else {}
        if tool not in self.SAFE_ACTIONS:
            raise ValueError("小镜不能执行未授权工具")
        if tool == "noop":
            return {"status": "noop"}
        raw = args.get("group_ids", [])
        group_ids = [str(value) for value in raw] if isinstance(raw, list) else []
        if tool == "run_priority_audit":
            return self.run_priority_audit(group_ids, max_groups=int(args.get("max_groups", 24) or 24))
        if tool == "extract_visual_evidence":
            return self.extract_visual_evidence(group_ids)
        if tool == "index_unknown_identities":
            return self.index_unknown_identities(group_ids, kind=str(args.get("kind", "both") or "both"))
        if tool == "collect_learning_cases":
            return self.collect_learning_cases()
        raise ValueError("未知小镜工具")
