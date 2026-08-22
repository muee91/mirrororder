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


def empty_review() -> dict[str, Any]:
    return {
        "version": 2,
        "revision": 0,
        "updated_at": "",
        "assignments": {},
        "groups": {},
        "clips": {},
        "placements": {},
    }


def normalize_review(raw: object) -> dict[str, Any]:
    result = empty_review()
    if not isinstance(raw, dict):
        return result
    for key in ("assignments", "groups", "clips", "placements"):
        value = raw.get(key, {})
        result[key] = value if isinstance(value, dict) else {}
    result["version"] = 2
    try:
        result["revision"] = max(0, int(raw.get("revision", 0)))
    except (TypeError, ValueError):
        result["revision"] = 0
    result["updated_at"] = str(raw.get("updated_at", "") or "")
    return result


class ReviewStore:
    _thread_lock = RLock()

    def __init__(self, path: str | Path):
        self.path = Path(path)

    @contextmanager
    def _write_lock(self):
        """Serialize LAN review writes in this process and across processes."""
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
            return empty_review()
        try:
            with self.path.open(encoding="utf-8") as handle:
                return normalize_review(json.load(handle))
        except (OSError, ValueError):
            return empty_review()

    def save(self, review: dict[str, Any]) -> dict[str, Any]:
        payload = normalize_review(review)
        with self._write_lock():
            return self._save_unlocked(payload)

    def _save_unlocked(self, payload: dict[str, Any]) -> dict[str, Any]:
        fd, temporary = tempfile.mkstemp(prefix=self.path.name + ".", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return payload

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat(timespec="seconds")

    def apply_action(self, action: dict[str, Any]) -> dict[str, Any]:
        """Merge one review action so concurrent LAN editors cannot overwrite each other."""
        with self._write_lock():
            review = self.load()
            self._apply_action_to_review(review, action, self._now())
            review["revision"] = int(review.get("revision", 0)) + 1
            review["updated_at"] = self._now()
            return self._save_unlocked(normalize_review(review))

    def apply_actions(self, actions: list[dict[str, Any]]) -> dict[str, Any]:
        """Apply a validated batch under one lock and one review revision."""
        if not actions:
            raise ValueError("审核批次不能为空")
        with self._write_lock():
            review = self.load()
            timestamp = self._now()
            for action in actions:
                self._apply_action_to_review(review, action, timestamp)
            review["revision"] = int(review.get("revision", 0)) + 1
            review["updated_at"] = timestamp
            return self._save_unlocked(normalize_review(review))

    def _apply_action_to_review(self, review: dict[str, Any], action: dict[str, Any], timestamp: str) -> None:
        action_type = str(action.get("action", ""))
        state = self._valid_state(str(action.get("state", "unreviewed")))
        actor = str(action.get("actor", "") or "")[:80]
        if action_type == "set_assignment":
            segment_id = str(action.get("segment_id", ""))
            group_id = str(action.get("group_id", ""))
            if not segment_id or not group_id:
                raise ValueError("set_assignment 缺少 segment_id 或 group_id")
            assignments = review["assignments"].setdefault(segment_id, {})
            if state == "unreviewed":
                assignments.pop(group_id, None)
            else:
                assignments[group_id] = self._review_entry(state, timestamp, actor)
            if not assignments:
                review["assignments"].pop(segment_id, None)
        elif action_type == "set_group":
            group_id = str(action.get("group_id", ""))
            if not group_id:
                raise ValueError("set_group 缺少 group_id")
            if state == "unreviewed":
                review["groups"].pop(group_id, None)
            else:
                review["groups"][group_id] = self._review_entry(state, timestamp, actor)
        elif action_type == "set_clip":
            clip_id = str(action.get("clip_id", ""))
            if not clip_id:
                raise ValueError("set_clip 缺少 clip_id")
            if state == "unreviewed":
                review["clips"].pop(clip_id, None)
            else:
                review["clips"][clip_id] = self._review_entry(state, timestamp, actor)
        elif action_type == "set_group_placement":
            group_id = str(action.get("group_id", ""))
            if not group_id:
                raise ValueError("set_group_placement 缺少 group_id")
            episode_ids = self._episode_ids(action.get("episode_ids", []))
            segment_ids = self._segment_ids(action.get("script_segment_ids", []))
            if not episode_ids and not segment_ids:
                review["placements"].pop(group_id, None)
            else:
                entry: dict[str, Any] = {
                    "episode_ids": episode_ids,
                    "script_segment_ids": segment_ids,
                    "method": "manual",
                    "updated_at": timestamp,
                }
                if actor:
                    entry["actor"] = actor
                review["placements"][group_id] = entry
        elif action_type == "clear_group_placement":
            group_id = str(action.get("group_id", ""))
            if not group_id:
                raise ValueError("clear_group_placement 缺少 group_id")
            review["placements"].pop(group_id, None)
        else:
            raise ValueError(f"未知 review action: {action_type}")

    @staticmethod
    def _review_entry(state: str, timestamp: str, actor: str) -> dict[str, str]:
        entry = {"state": state, "method": "manual", "updated_at": timestamp}
        if actor:
            entry["actor"] = actor
        return entry

    @staticmethod
    def _valid_state(state: str) -> str:
        return state if state in VALID_STATES else "unreviewed"

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

    def update_group(self, group_id: str, state: str) -> dict[str, Any]:
        return self.apply_action({"action": "set_group", "group_id": group_id, "state": state})

    def update_clip(self, clip_id: str, state: str) -> dict[str, Any]:
        return self.apply_action({"action": "set_clip", "clip_id": clip_id, "state": state})

    def update_assignment(self, segment_id: str, group_id: str, state: str) -> dict[str, Any]:
        return self.apply_action({"action": "set_assignment", "segment_id": segment_id, "group_id": group_id, "state": state})


def effective_group_entry(
    review: dict[str, Any],
    group_id: str,
    parent_group_id: str = "",
) -> tuple[dict[str, Any], bool]:
    group = review.get("groups", {}).get(group_id, {})
    if group:
        return group, False
    if parent_group_id:
        parent = review.get("groups", {}).get(parent_group_id, {})
        if parent:
            return parent, True
    return {}, False


def effective_group_state(
    review: dict[str, Any],
    group_id: str,
    clip_ids: list[str],
    parent_group_id: str = "",
) -> str:
    group, _inherited = effective_group_entry(review, group_id, parent_group_id)
    if group.get("state") in VALID_STATES:
        return group["state"]
    clip_states = [review.get("clips", {}).get(clip_id, {}).get("state") for clip_id in clip_ids]
    if "reject" in clip_states:
        return "reject"
    return "unreviewed"
