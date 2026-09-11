from __future__ import annotations

import hashlib
import json
import os
import secrets
import tempfile
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import RLock
from typing import Any
from uuid import uuid4

from .review_store import ReviewStore
from .workspace import WorkspaceConfig


AGENT_SCOPES = {"read", "analyze", "propose"}


class AgentAuthorizationError(PermissionError):
    pass


class AgentForbiddenError(PermissionError):
    pass


class AgentRateLimitError(PermissionError):
    pass


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


class AgentTokenStore:
    def __init__(self, workspace: WorkspaceConfig):
        self.path = workspace.config_path.parent / ".workspace" / "agent_tokens.json"
        self.audit_path = workspace.config_path.parent / ".workspace" / "agent_audit.jsonl"
        self._lock = RLock()
        self._requests: defaultdict[str, deque[float]] = defaultdict(deque)

    def _load(self) -> dict[str, Any]:
        raw = _read_json(self.path, {"version": 1, "tokens": []})
        if not isinstance(raw, dict) or not isinstance(raw.get("tokens"), list):
            return {"version": 1, "tokens": []}
        return {"version": 1, "tokens": raw["tokens"]}

    def create(
        self,
        name: str,
        project_ids: list[str],
        scopes: list[str] | None = None,
        expires_days: int = 30,
    ) -> tuple[dict[str, Any], str]:
        selected_scopes = sorted(set(scopes or ["read", "analyze", "propose"]))
        if not selected_scopes or any(scope not in AGENT_SCOPES for scope in selected_scopes):
            raise ValueError("令牌权限无效")
        if not project_ids:
            raise ValueError("令牌必须指定项目范围")
        token = "smat_" + secrets.token_urlsafe(32)
        record = {
            "token_id": "agt_" + uuid4().hex,
            "token_prefix": token[:12],
            "name": str(name or "local-agent")[:80],
            "token_hash": hashlib.sha256(token.encode("utf-8")).hexdigest(),
            "project_ids": sorted(set(str(value) for value in project_ids)),
            "scopes": selected_scopes,
            "created_at": _now(),
            "expires_at": (datetime.now(timezone.utc) + timedelta(days=max(1, min(365, expires_days)))).isoformat(timespec="seconds"),
            "revoked_at": "",
        }
        with self._lock:
            payload = self._load()
            payload["tokens"].append(record)
            _write_json(self.path, payload)
        return self.public(record), token

    def authorize(self, raw_token: str, scope: str, project_id: str | None = None) -> dict[str, Any]:
        if scope not in AGENT_SCOPES:
            raise AgentForbiddenError("未知智能体权限")
        digest = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        now = datetime.now(timezone.utc)
        with self._lock:
            for record in self._load()["tokens"]:
                if not secrets.compare_digest(str(record.get("token_hash", "")), digest):
                    continue
                if record.get("revoked_at"):
                    raise AgentAuthorizationError("智能体令牌已撤销")
                if now >= datetime.fromisoformat(str(record.get("expires_at"))):
                    raise AgentAuthorizationError("智能体令牌已过期")
                if scope not in record.get("scopes", []):
                    raise AgentForbiddenError("智能体令牌没有此权限")
                if project_id and project_id not in record.get("project_ids", []):
                    raise AgentForbiddenError("智能体令牌不能访问此项目")
                self._rate_limit(str(record["token_id"]))
                return record
        raise AgentAuthorizationError("智能体令牌无效")

    def audit(self, record: dict[str, Any], action: str, project_id: str, detail: dict[str, Any] | None = None) -> None:
        payload = {
            "at": _now(),
            "agent_id": record.get("token_id", ""),
            "agent_name": record.get("name", ""),
            "action": action,
            "project_id": project_id,
            "detail": detail or {},
        }
        with self._lock:
            self.audit_path.parent.mkdir(parents=True, exist_ok=True)
            with self.audit_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, ensure_ascii=False) + "\n")

    @staticmethod
    def public(record: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in record.items() if key != "token_hash"}

    def _rate_limit(self, token_id: str) -> None:
        import time

        now = time.monotonic()
        requests = self._requests[token_id]
        while requests and now - requests[0] > 60:
            requests.popleft()
        if len(requests) >= 60:
            raise AgentRateLimitError("智能体请求超过每分钟60次限制")
        requests.append(now)


class ProposalStore:
    def __init__(self, output_dir: str | Path):
        self.path = Path(output_dir) / "proposals.json"
        self._lock = RLock()

    def _load(self) -> dict[str, Any]:
        raw = _read_json(self.path, {"version": 1, "proposals": []})
        if not isinstance(raw, dict) or not isinstance(raw.get("proposals"), list):
            return {"version": 1, "proposals": []}
        return {"version": 1, "proposals": raw["proposals"]}

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            return list(reversed(self._load()["proposals"]))

    @staticmethod
    def stale_reason_for(proposal: dict[str, Any], analysis_revision: str, review_revision: int) -> str:
        """纯函数：pending 提案相对当前 revision 是否已过期。只用于展示与
        apply 前置判断；过期落盘只发生在 apply 时（读路径保持无写）。"""
        if proposal.get("status") != "pending":
            return ""
        if proposal.get("base_analysis_revision") != analysis_revision:
            return "分析版本已变化"
        try:
            if int(proposal.get("base_review_revision", -1)) != int(review_revision):
                return "人工审核版本已变化"
        except (TypeError, ValueError):
            return "人工审核版本已变化"
        return ""

    def create(
        self,
        proposal: dict[str, Any],
        agent: dict[str, Any],
        groups: dict[str, dict[str, Any]],
        segments: dict[str, dict[str, Any]],
        analysis_revision: str,
        review_revision: int,
    ) -> dict[str, Any]:
        group_id = str(proposal.get("group_id", ""))
        episode_ids = self._episode_ids(proposal.get("episode_ids", []))
        segment_ids = self._segment_ids(proposal.get("script_segment_ids", []))
        evidence = proposal.get("evidence", [])
        if not group_id or group_id not in groups:
            raise ValueError("提案必须引用当前项目的 group_id")
        if not episode_ids and not segment_ids:
            raise ValueError("提案必须包含集数或剧本范围")
        if any(segment_id not in segments for segment_id in segment_ids):
            raise ValueError("提案包含未知剧本段")
        if not isinstance(evidence, list) or not evidence:
            raise ValueError("提案必须包含至少一条证据")
        allowed_clips = {str(item.get("clip_id")) for item in groups[group_id].get("members", [])}
        normalized_evidence = []
        members_by_clip = {
            str(item.get("clip_id")): item
            for item in groups[group_id].get("members", [])
            if isinstance(item, dict) and item.get("clip_id")
        }
        for item in evidence:
            if not isinstance(item, dict):
                raise ValueError("证据格式无效")
            clip_id = str(item.get("clip_id", ""))
            summary = str(item.get("summary", "")).strip()
            if clip_id not in allowed_clips or not summary:
                raise ValueError("证据必须引用该Take内的素材并给出说明")
            member = members_by_clip[clip_id]
            start = max(0.0, float(item.get("start", 0) or 0))
            end = max(0.0, float(item.get("end", 0) or 0))
            source_start = max(0.0, float(member.get("source_start", 0) or 0))
            source_end = float(member.get("source_end", member.get("duration", 0)) or 0)
            if end <= start or start < source_start or end > source_end + 0.02:
                raise ValueError("证据时间范围必须位于该素材的有效片内范围")
            normalized_evidence.append(
                {
                    "clip_id": clip_id,
                    "start": start,
                    "end": end,
                    "summary": summary[:500],
                }
            )
        if str(proposal.get("state", "")).lower() == "reject":
            raise ValueError("智能体不能提交 Reject 提案")
        if str(proposal.get("base_analysis_revision", "")) != analysis_revision:
            raise ValueError("分析版本已变化，请重新读取项目上下文")
        if int(proposal.get("base_review_revision", -1)) != review_revision:
            raise ValueError("人工审核版本已变化，请重新读取项目上下文")
        record = {
            "proposal_id": "prop_" + uuid4().hex,
            "status": "pending",
            "type": "placement",
            "group_id": group_id,
            "episode_ids": episode_ids,
            "script_segment_ids": segment_ids,
            "evidence": normalized_evidence,
            "note": str(proposal.get("note", "") or "")[:1000],
            "base_analysis_revision": analysis_revision,
            "base_review_revision": review_revision,
            "agent_id": agent.get("token_id", ""),
            "agent_name": agent.get("name", ""),
            "created_at": _now(),
            "applied_at": "",
            "applied_by": "",
            "stale_reason": "",
        }
        with self._lock:
            payload = self._load()
            payload["proposals"].append(record)
            _write_json(self.path, payload)
        return record

    def apply(
        self,
        proposal_ids: list[str],
        actor: str,
        groups: dict[str, dict[str, Any]],
        segments: dict[str, dict[str, Any]],
        analysis_revision: str,
        review_store: ReviewStore,
    ) -> dict[str, Any]:
        """Apply proposals one by one: a stale proposal expires instead of
        aborting the whole batch. Returns per-proposal results so the reviewer
        sees partial success instead of a single opaque error."""
        if not proposal_ids:
            raise ValueError("请选择至少一条提案")
        with self._lock:
            payload = self._load()
            by_id = {str(item.get("proposal_id", "")): item for item in payload["proposals"]}
            unknown = [pid for pid in proposal_ids if pid not in by_id]
            if unknown:
                raise ValueError("存在未知提案")
            current_review = review_store.load()
            current_revision = int(current_review.get("revision", 0))
            results: list[dict[str, Any]] = []
            ready: list[tuple[dict[str, Any], dict[str, Any]]] = []
            for pid in proposal_ids:
                proposal = by_id[pid]
                base = {"proposal_id": pid, "group_id": str(proposal.get("group_id", "") or "")}
                reason = self.stale_reason_for(proposal, analysis_revision, current_revision)
                if reason:
                    proposal["status"] = "expired"
                    proposal["stale_reason"] = reason
                    results.append({**base, "status": "expired", "reason": reason})
                    continue
                if proposal.get("group_id") not in groups or any(
                    segment_id not in segments for segment_id in proposal.get("script_segment_ids", [])
                ):
                    proposal["status"] = "expired"
                    proposal["stale_reason"] = "提案引用的数据已不存在"
                    results.append({**base, "status": "expired", "reason": "提案引用的数据已不存在"})
                    continue
                ready.append((proposal, base))
                results.append({**base, "status": "applied"})
            if ready:
                actions = [
                    {
                        "action": "set_group_placement",
                        "group_id": proposal["group_id"],
                        "episode_ids": proposal.get("episode_ids", []),
                        "script_segment_ids": proposal.get("script_segment_ids", []),
                        "actor": actor,
                    }
                    for proposal, _base in ready
                ]
                review_store.apply_actions(actions)
                for proposal, _base in ready:
                    proposal["status"] = "applied"
                    proposal["applied_at"] = _now()
                    proposal["applied_by"] = actor[:80]
            applied_ids = {proposal["proposal_id"] for proposal, _base in ready}
            _write_json(self.path, payload)
            applied = [dict(item) for item in payload["proposals"] if item.get("proposal_id") in applied_ids]
            return {
                "applied": applied,
                "results": results,
                "applied_count": len(ready),
                "failed_count": len(results) - len(ready),
                "review_revision": current_revision,
            }

    @staticmethod
    def _episode_ids(raw: object) -> list[int]:
        if not isinstance(raw, list):
            return []
        result = set()
        for value in raw:
            try:
                number = int(value)
            except (TypeError, ValueError):
                continue
            if 0 < number < 10000:
                result.add(number)
        return sorted(result)

    @staticmethod
    def _segment_ids(raw: object) -> list[str]:
        if not isinstance(raw, list):
            return []
        return list(dict.fromkeys(str(value)[:160] for value in raw if str(value).strip()))
