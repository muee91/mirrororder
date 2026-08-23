from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from .agent_tools import AgentToolRegistry
from .assistant_store import AssistantStore
from .audit_engine import _analysis_revision
from .audit_store import AuditStore
from .editorial_store import EditorialStore
from .model_registry import AssistantLanguageModel, ModelRegistry
from .review_store import ReviewStore


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


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class AssistantOrchestrator:
    """First-party control plane above MirrorOrder's deterministic pipeline.

    The orchestrator can inspect project state and execute only allowlisted
    production-support tools. It cannot write review/editorial decisions, cannot
    auto-Reject, and never receives raw filesystem control.
    """

    def __init__(self, workspace_id: str, project_id: str, config: Any, *, task_manager: Any | None = None):
        self.workspace_id = str(workspace_id or "")
        self.project_id = str(project_id or "")
        self.config = config
        self.task_manager = task_manager
        self.store = AssistantStore(config.output_dir)
        self.tools = AgentToolRegistry(self.workspace_id, self.project_id, config, task_manager)
        self.models = ModelRegistry()
        self.language = AssistantLanguageModel(self.models.assistant)

    def _fingerprint(self) -> str:
        review = ReviewStore(self.config.output_dir / "review.json").load()
        editorial = EditorialStore(self.config.output_dir).load()
        audit = AuditStore(self.config.output_dir).load()
        automatic = _read(self.config.output_dir / "auto_decisions.json")
        raw = {
            "analysis": _analysis_revision(self.config.output_dir),
            "review": int(review.get("revision", 0) or 0),
            "editorial": int(editorial.get("revision", 0) or 0),
            "audit": int(audit.get("revision", 0) or 0),
            "automation_updated_at": str(automatic.get("updated_at", "") or ""),
        }
        return hashlib.sha1(
            json.dumps(raw, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()[:20]

    def _group_titles(self) -> dict[str, str]:
        index = _read(self.config.output_dir / "material_index.json")
        result: dict[str, str] = {}
        for group in _as_list(index.get("groups")):
            if not isinstance(group, dict):
                continue
            group_id = str(group.get("group_id", "") or "")
            if not group_id:
                continue
            names = []
            members = [item for item in _as_list(group.get("members")) if isinstance(item, dict)]
            members.sort(key=lambda item: (str(item.get("camera", "")), str(item.get("clip_id", ""))))
            for member in members[:3]:
                name = str(member.get("name", "") or "")
                if not name:
                    name = Path(str(member.get("media_path", "") or "")).name
                names.append(f"{str(member.get('camera', '?') or '?')} · {name or str(member.get('clip_id', ''))}")
            result[group_id] = " / ".join(names) or group_id
        return result

    @staticmethod
    def _item_from_attention(row: dict[str, Any], title: str) -> dict[str, Any]:
        group_id = str(row.get("group_id", "") or "")
        reasons = set(str(value) for value in _as_list(row.get("reasons")) if str(value))
        candidate = _as_dict(row.get("candidate"))
        score = float(candidate.get("total_score", 0) or 0)
        margin = float(candidate.get("margin", 1) or 1)
        if "human_mapping_conflict" in reasons:
            return {
                "key": f"mapping-conflict:{group_id}",
                "group_id": group_id,
                "kind": "decision",
                "priority": 100,
                "label": "归集冲突",
                "title": title,
                "message": "你已经做过人工归集，但当前算法的首选范围不同。人工结果不会被覆盖；这条会保留为算法学习反例，建议再看片确认一次。",
                "context": f"当前算法首选分数约 {round(score * 100)}%",
                "actions": ["focus", "placement"],
            }
        if "missing_media" in reasons:
            return {
                "key": f"missing-media:{group_id}",
                "group_id": group_id,
                "kind": "production",
                "priority": 98,
                "label": "素材不完整",
                "title": title,
                "message": "当前 Host 的素材证据不完整。我不会在缺媒体时推动最终判断，先补齐本机媒体绑定更安全。",
                "context": "素材路径属于本机状态，不会写回共享项目。",
                "actions": ["focus"],
            }
        if "audit_disagreement" in reasons:
            reason = str(row.get("audit_reason", "") or "").strip()
            return {
                "key": f"audit-disagree:{group_id}",
                "group_id": group_id,
                "kind": "decision",
                "priority": 96,
                "label": "建议复核",
                "title": title,
                "message": "我对当前自动判断不太放心。" + (reason or "审计证据和当前算法结论没有完全对上。") + " 建议看片后再决定是否保持当前归集。",
                "context": "AI Audit 只是反方评委，不会覆盖人工结论。",
                "actions": ["focus", "placement"],
            }
        if "unresolved" in reasons or "no_candidate" in reasons:
            return {
                "key": f"unresolved:{group_id}",
                "group_id": group_id,
                "kind": "decision",
                "priority": 90 if "unresolved" in reasons else 84,
                "label": "需要看片",
                "title": title,
                "message": "目前没有足够证据把这组素材可靠绑到具体剧本。请先看片；不确定具体台词时，只归到集数比强行匹配更安全。",
                "context": "证据不足时镜序会保留未知，而不是自信地猜错。",
                "actions": ["focus", "placement"],
            }
        if "needs_review" in reasons or "candidate_competition" in reasons:
            delta = max(0, round(margin * 100))
            return {
                "key": f"low-confidence:{group_id}",
                "group_id": group_id,
                "kind": "decision",
                "priority": 88,
                "label": "需要你判断",
                "title": title,
                "message": "这组素材的候选还没有拉开，我不建议自动替你选。请先看片，再用归集操作告诉镜序正确范围。",
                "context": f"首选分数约 {round(score * 100)}% · 候选分差约 {delta} 个百分点",
                "actions": ["focus", "placement"],
            }
        if "material_quality" in reasons:
            return {
                "key": f"material-quality:{group_id}",
                "group_id": group_id,
                "kind": "production",
                "priority": 66,
                "label": "素材提示",
                "title": title,
                "message": "审计发现画面、声音或连续性方面有值得留意的证据。它不等于素材不能用，看片时优先确认即可。",
                "context": "素材问题不会自动变成 Reject。",
                "actions": ["focus"],
            }
        suggestions = _as_list(row.get("role_suggestions"))
        if suggestions:
            first = _as_dict(suggestions[0])
            role = str(first.get("role_name", "") or "")
            confidence = float(first.get("confidence", 0) or 0)
            return {
                "key": f"role-suggestion:{group_id}:{role}",
                "group_id": group_id,
                "kind": "people",
                "priority": 38,
                "label": "人物线索",
                "title": title,
                "message": f"声纹与当前剧本对白提示这个身份可能是「{role}」。这只是角色候选，多机位画面中的人不一定是说话者，需要人工确认一次。",
                "context": f"候选置信约 {round(confidence * 100)}% · 已确认身份不会重复计算",
                "actions": ["focus", "people"],
            }
        return {
            "key": f"attention:{group_id}",
            "group_id": group_id,
            "kind": "production",
            "priority": int(row.get("priority", 1) or 1),
            "label": "制作提醒",
            "title": title,
            "message": "这组素材有值得留意的制作证据。",
            "context": "",
            "actions": ["focus"],
        }

    def _build_items(self, attention: list[dict[str, Any]]) -> list[dict[str, Any]]:
        titles = self._group_titles()
        items = [
            self._item_from_attention(row, titles.get(str(row.get("group_id", "")), str(row.get("group_id", ""))))
            for row in attention
        ]
        items.sort(key=lambda item: (-int(item.get("priority", 0) or 0), str(item.get("title", ""))))
        return items[:160]

    @staticmethod
    def _summary(items: list[dict[str, Any]]) -> str:
        high = [item for item in items if int(item.get("priority", 0) or 0) >= 80]
        if not high:
            return "目前没有需要打断看片的高优先问题。我会继续盯着归集冲突、低置信素材、媒体缺失和审计反例。"
        decisions = sum(1 for item in high if item.get("kind") == "decision")
        production = sum(1 for item in high if item.get("kind") == "production")
        parts = []
        if decisions:
            parts.append(f"{decisions} 组需要你判断")
        if production:
            parts.append(f"{production} 组制作问题")
        return f"我发现 {len(high)} 个值得优先处理的问题：{'，'.join(parts) or '需要制作复核'}。我已经按风险排好顺序。"

    def _current_audit_groups(self) -> set[str]:
        audit = AuditStore(self.config.output_dir).load()
        current_analysis = _analysis_revision(self.config.output_dir)
        result = set()
        for group_id, row in _as_dict(audit.get("groups")).items():
            if isinstance(row, dict) and str(row.get("analysis_revision", "") or "") == current_analysis:
                result.add(str(group_id))
        return result

    def _planner_context(self, project: dict[str, Any], attention: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "project": project,
            "attention": attention[:20],
            "failure_patterns": self.tools.failure_patterns(limit=6),
            "models": self.models.public(),
            "allowed_tools": [
                {"name": "run_priority_audit", "purpose": "对高价值疑难Take运行有缓存的Shadow Audit"},
                {"name": "collect_learning_cases", "purpose": "刷新只供离线算法研发使用的hard cases"},
                {"name": "noop", "purpose": "当前不需要自动动作"},
            ],
            "rules": [
                "不得写review.json或editorial.json",
                "不得自动Best或Reject",
                "不得覆盖人工归集",
                "多机位画面人物不等于说话角色",
                "优先减少危险的高置信误判，而不是追求所有素材都有答案",
            ],
        }

    def _model_plan(self, project: dict[str, Any], attention: list[dict[str, Any]]) -> dict[str, Any] | None:
        if not self.language.enabled:
            return None
        system = (
            "你是镜序助理的生产编排器。你只能从allowed_tools里选择动作，不能直接修改审核、创意决定、FCPXML或媒体。"
            "目标是减少剪辑人员寻找问题的时间，同时控制算力。优先处理高风险歧义和算法反例，不要全量重复计算。"
            "输出严格JSON："
            '{"briefing":"一句中文简报","actions":[{"tool":"run_priority_audit|collect_learning_cases|noop","arguments":{}}],'
            '"questions":[{"group_id":"","text":"需要用户判断的问题"}]}。'
            "actions最多2个；没有必要动作时只返回noop。"
        )
        raw = self.language.complete_json(system=system, context=self._planner_context(project, attention))
        if not isinstance(raw, dict):
            return None
        actions = []
        for item in _as_list(raw.get("actions"))[:2]:
            if not isinstance(item, dict):
                continue
            tool = str(item.get("tool", "") or "")
            if tool not in self.tools.SAFE_ACTIONS:
                continue
            arguments = item.get("arguments", {}) if isinstance(item.get("arguments"), dict) else {}
            actions.append({"tool": tool, "arguments": arguments})
        questions = []
        for item in _as_list(raw.get("questions"))[:8]:
            if isinstance(item, dict) and item.get("text"):
                questions.append(
                    {
                        "group_id": str(item.get("group_id", "") or ""),
                        "text": str(item.get("text", "") or "")[:500],
                    }
                )
        return {
            "briefing": str(raw.get("briefing", "") or "")[:1000],
            "actions": actions,
            "questions": questions,
        }

    def cycle(
        self,
        *,
        trigger: str = "manual",
        allow_actions: bool = True,
        force_plan: bool = False,
    ) -> dict[str, Any]:
        fingerprint = self._fingerprint()
        previous = self.store.load()
        project = self.tools.inspect_project()
        attention = self.tools.list_attention_groups(limit=160)
        items = self._build_items(attention)
        summary = self._summary(items)
        orchestration = dict(_as_dict(previous.get("orchestration")))
        orchestration["last_trigger"] = str(trigger or "manual")[:80]
        orchestration["models"] = self.models.public()
        orchestration["agent_api"] = {
            "contract": "agent.v1",
            "base": f"/api/agent/v1/projects/{self.project_id}",
            "scopes": ["read", "analyze", "propose"],
        }
        action_results: list[dict[str, Any]] = []
        plan: dict[str, Any] | None = None

        auto_plan = force_plan or _env_bool("MIRRORORDER_ASSISTANT_AUTO_PLAN", False)
        if allow_actions and auto_plan:
            plan = self._model_plan(project, attention)
            if plan and plan.get("briefing"):
                summary = str(plan["briefing"])
            for action in _as_list(plan.get("actions") if plan else []):
                if not isinstance(action, dict):
                    continue
                tool = str(action.get("tool", "") or "")
                try:
                    result = self.tools.execute(tool, _as_dict(action.get("arguments")))
                except Exception as error:
                    result = {"status": "failed", "error": str(error)[:500]}
                action_results.append({"tool": tool, "result": result})

        # Deterministic fallback: once a visual model has explicitly been
        # enabled, the first-party assistant may proactively audit only the
        # unresolved high-value groups that lack current audit evidence.
        if allow_actions and not any(row.get("tool") == "run_priority_audit" for row in action_results):
            visual_enabled = bool(self.models.vision.enabled)
            if visual_enabled:
                current_audit = self._current_audit_groups()
                high_groups = [
                    str(row.get("group_id", ""))
                    for row in attention
                    if int(row.get("priority", 0) or 0) >= 82
                    and str(row.get("group_id", "")) not in current_audit
                ][:24]
                action_fingerprint = hashlib.sha1(
                    (fingerprint + "|" + ",".join(high_groups)).encode("utf-8")
                ).hexdigest()[:20]
                if high_groups and orchestration.get("last_action_fingerprint") != action_fingerprint:
                    try:
                        result = self.tools.run_priority_audit(high_groups, max_groups=len(high_groups))
                    except Exception as error:
                        result = {"status": "failed", "error": str(error)[:500]}
                    action_results.append({"tool": "run_priority_audit", "result": result})
                    if result.get("status") in {"submitted", "already_running"}:
                        orchestration["last_action_fingerprint"] = action_fingerprint

        if action_results:
            orchestration["last_action"] = {
                "trigger": str(trigger or "manual")[:80],
                "results": action_results,
            }
        if plan:
            orchestration["last_plan"] = plan

        payload = {
            "source_fingerprint": fingerprint,
            "summary": summary,
            "items": items,
            "orchestration": orchestration,
            "messages": previous.get("messages", []),
        }
        if previous.get("source_fingerprint") == fingerprint and previous.get("summary") == summary and previous.get("items") == items and not action_results and not plan:
            return previous
        return self.store.save(payload)

    def status(self) -> dict[str, Any]:
        current = self.store.load()
        if current.get("source_fingerprint") != self._fingerprint():
            return self.cycle(trigger="read", allow_actions=False)
        return current

    def answer(self, message: str) -> dict[str, Any]:
        text = str(message or "").strip()[:3000]
        if not text:
            raise ValueError("消息不能为空")
        current = self.status()
        current = self.store.append_message("user", text, source="user")
        project = self.tools.inspect_project()
        attention = self.tools.list_attention_groups(limit=30)
        if self.language.enabled:
            system = (
                "你是镜序助理，服务短剧后期制作。根据给出的项目事实回答用户，优先帮助用户看片、归集、发现素材问题和理解下一步。"
                "不要声称已经执行未发生的动作；不要把AI意见说成人工最终结论；不要输出模型/运行时技术宣传。"
                "多机位画面人物可能不是说话人。输出严格JSON：{\"answer\":\"中文回答\"}。"
            )
            raw = self.language.complete_json(
                system=system,
                context={
                    "question": text,
                    "project": project,
                    "attention": attention[:16],
                    "assistant_summary": current.get("summary", ""),
                },
                temperature=0.2,
            )
            answer = str(_as_dict(raw).get("answer", "") or "").strip()
        else:
            answer = "当前没有可用的语言模型。我仍会用确定性规则和本地视觉审计整理问题；启用语言模型后，我可以进一步用自然语言解释和规划。"
        if not answer:
            answer = str(current.get("summary", "") or "当前没有新的高优先问题。")
        saved = self.store.append_message("assistant", answer, source=self.models.assistant.source)
        return {"answer": answer, "assistant": saved}
