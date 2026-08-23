from __future__ import annotations

import json
import os
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows fallback
    fcntl = None


VALID_STATES = {"unreviewed", "keep", "best", "reject"}
TARGET_KINDS = {"group", "assignment"}


class EditorialConflictError(RuntimeError):
    """Raised when a final editorial decision is based on a stale revision."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def empty_editorial() -> dict[str, Any]:
    return {
        "version": 1,
        "revision": 0,
        "updated_at": "",
        "opinions": {},
        "decisions": {},
    }


def _target(kind: str, group_id: str, segment_id: str = "") -> dict[str, str]:
    kind = str(kind or "").strip()
    group_id = str(group_id or "").strip()
    segment_id = str(segment_id or "").strip()
    if kind not in TARGET_KINDS:
        raise ValueError("editorial target kind 必须是 group 或 assignment")
    if not group_id:
        raise ValueError("editorial target 缺少 group_id")
    if kind == "assignment" and not segment_id:
        raise ValueError("assignment target 缺少 segment_id")
    return {
        "kind": kind,
        "group_id": group_id[:180],
        "segment_id": segment_id[:180] if kind == "assignment" else "",
    }


def _target_key(target: dict[str, str]) -> str:
    if target["kind"] == "assignment":
        return f"assignment|{target['segment_id']}|{target['group_id']}"
    return f"group|{target['group_id']}"


def _state(value: object) -> str:
    state = str(value or "unreviewed")
    if state not in VALID_STATES:
        raise ValueError("editorial state 必须是 unreviewed / keep / best / reject")
    return state


def normalize_editorial(raw: object) -> dict[str, Any]:
    result = empty_editorial()
    if not isinstance(raw, dict):
        return result
    try:
        result["revision"] = max(0, int(raw.get("revision", 0) or 0))
    except (TypeError, ValueError):
        result["revision"] = 0
    result["updated_at"] = str(raw.get("updated_at", "") or "")
    opinions = raw.get("opinions", {})
    decisions = raw.get("decisions", {})
    result["opinions"] = opinions if isinstance(opinions, dict) else {}
    result["decisions"] = decisions if isinstance(decisions, dict) else {}
    return result


class EditorialStore:
    """Shared, revision-safe collaboration state separate from legacy review.json.

    Individual opinions merge by reviewer so concurrent collaborators do not
    overwrite each other. Final editorial decisions are a separate axis and
    require an expected revision, which prevents a stale editor from silently
    replacing a newer final decision.
    """

    _thread_lock = RLock()

    def __init__(self, output_dir: str | Path):
        self.path = Path(output_dir) / "editorial.json"

    @contextmanager
    def _write_lock(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self.path.with_name(self.path.name + ".lock")
        with self._thread_lock, lock_path.open("a+", encoding="utf-8") as handle:
            if fcntl is not None:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                if fcntl is not None:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def load(self) -> dict[str, Any]:
        if not self.path.exists():
            return empty_editorial()
        try:
            with self.path.open(encoding="utf-8") as handle:
                return normalize_editorial(json.load(handle))
        except (OSError, ValueError):
            return empty_editorial()

    def _save_unlocked(self, payload: dict[str, Any]) -> dict[str, Any]:
        normalized = normalize_editorial(payload)
        fd, temporary = tempfile.mkstemp(prefix=self.path.name + ".", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(normalized, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return normalized

    @staticmethod
    def _actor(value: object) -> str:
        actor = str(value or "").strip()[:80]
        if not actor:
            raise ValueError("协作写入需要审核昵称")
        return actor

    @staticmethod
    def _target_from_action(action: dict[str, Any]) -> dict[str, str]:
        return _target(
            str(action.get("target_kind", "") or ""),
            str(action.get("group_id", "") or ""),
            str(action.get("segment_id", "") or ""),
        )

    def apply_opinion(self, action: dict[str, Any]) -> dict[str, Any]:
        """Atomically upsert one reviewer's opinion without replacing peers."""

        actor = self._actor(action.get("actor"))
        state = _state(action.get("state"))
        target = self._target_from_action(action)
        key = _target_key(target)
        with self._write_lock():
            payload = self.load()
            opinions = payload["opinions"]
            row = opinions.get(key, {}) if isinstance(opinions.get(key), dict) else {}
            actors = row.get("actors", {}) if isinstance(row.get("actors"), dict) else {}
            if state == "unreviewed":
                actors.pop(actor, None)
            else:
                actors[actor] = {
                    "state": state,
                    "actor": actor,
                    "updated_at": _now(),
                }
            if actors:
                opinions[key] = {"target": target, "actors": actors}
            else:
                opinions.pop(key, None)
            payload["revision"] = int(payload.get("revision", 0) or 0) + 1
            payload["updated_at"] = _now()
            return self._save_unlocked(payload)

    def apply_decision(self, action: dict[str, Any]) -> dict[str, Any]:
        """Write the final editorial decision with optimistic revision safety."""

        actor = self._actor(action.get("actor"))
        state = _state(action.get("state"))
        target = self._target_from_action(action)
        key = _target_key(target)
        try:
            expected_revision = int(action.get("expected_revision"))
        except (TypeError, ValueError) as error:
            raise ValueError("最终编辑决定必须带 expected_revision") from error
        with self._write_lock():
            payload = self.load()
            current_revision = int(payload.get("revision", 0) or 0)
            if expected_revision != current_revision:
                raise EditorialConflictError(
                    f"editorial revision 已变化：expected {expected_revision}, current {current_revision}"
                )
            decisions = payload["decisions"]
            if state == "unreviewed":
                decisions.pop(key, None)
            else:
                decisions[key] = {
                    "target": target,
                    "state": state,
                    "actor": actor,
                    "updated_at": _now(),
                }
            payload["revision"] = current_revision + 1
            payload["updated_at"] = _now()
            return self._save_unlocked(payload)

    def for_group(self, group_id: str) -> dict[str, Any]:
        group_id = str(group_id or "").strip()
        payload = self.load()
        group_opinions: list[dict[str, Any]] = []
        assignment_opinions: list[dict[str, Any]] = []
        for row in payload.get("opinions", {}).values():
            if not isinstance(row, dict):
                continue
            target = row.get("target", {}) if isinstance(row.get("target"), dict) else {}
            if str(target.get("group_id", "")) != group_id:
                continue
            destination = assignment_opinions if target.get("kind") == "assignment" else group_opinions
            for opinion in (row.get("actors", {}) or {}).values():
                if isinstance(opinion, dict):
                    destination.append({"target": dict(target), **opinion})
        group_decision: dict[str, Any] | None = None
        assignment_decisions: list[dict[str, Any]] = []
        for decision in payload.get("decisions", {}).values():
            if not isinstance(decision, dict):
                continue
            target = decision.get("target", {}) if isinstance(decision.get("target"), dict) else {}
            if str(target.get("group_id", "")) != group_id:
                continue
            row = {"target": dict(target), **{key: value for key, value in decision.items() if key != "target"}}
            if target.get("kind") == "assignment":
                assignment_decisions.append(row)
            else:
                group_decision = row
        key = lambda item: (
            str(item.get("target", {}).get("segment_id", "")),
            str(item.get("actor", "")),
            str(item.get("updated_at", "")),
        )
        group_opinions.sort(key=key)
        assignment_opinions.sort(key=key)
        assignment_decisions.sort(key=key)
        return {
            "revision": int(payload.get("revision", 0) or 0),
            "opinions": {"group": group_opinions, "assignments": assignment_opinions},
            "decision": {"group": group_decision, "assignments": assignment_decisions},
        }
