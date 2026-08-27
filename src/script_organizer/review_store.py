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
MAX_HISTORY_ROWS = 1000


class ReviewConflictError(RuntimeError):
    """Raised when a client writes against a stale Review revision."""


def empty_review() -> dict[str, Any]:
    return {
        "version": 2,
        "revision": 0,
        "updated_at": "",
        "assignments": {},
        "groups": {},
        "clips": {},
        "placements": {},
        "history": [],
    }


def normalize_review(raw: object) -> dict[str, Any]:
    result = empty_review()
    if not isinstance(raw, dict):
        return result
    for key in ("assignments", "groups", "clips", "placements"):
        value = raw.get(key, {})
        result[key] = value if isinstance(value, dict) else {}
    history = raw.get("history", [])
    result["history"] = [dict(item) for item in history[-MAX_HISTORY_ROWS:] if isinstance(item, dict)] if isinstance(history, list) else []
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
            self._check_expected_revision(review, action)
            timestamp = self._now()
            before = self._audit_snapshot(review, action)
            self._apply_action_to_review(review, action, timestamp)
            review["revision"] = int(review.get("revision", 0)) + 1
            review["updated_at"] = timestamp
            self._append_history(review, action, timestamp, int(review["revision"]), before)
            saved = self._save_unlocked(normalize_review(review))
        self._mirror_placement_actions([action])
        return saved

    def apply_actions(self, actions: list[dict[str, Any]]) -> dict[str, Any]:
        """Apply a validated batch under one lock and one review revision."""
        if not actions:
            raise ValueError("审核批次不能为空")
        with self._write_lock():
            review = self.load()
            for action in actions:
                self._check_expected_revision(review, action)
            timestamp = self._now()
            snapshots: list[tuple[dict[str, Any], dict[str, Any]]] = []
            for action in actions:
                before = self._audit_snapshot(review, action)
                self._apply_action_to_review(review, action, timestamp)
                snapshots.append((action, before))
            review["revision"] = int(review.get("revision", 0)) + 1
            review["updated_at"] = timestamp
            revision = int(review["revision"])
            for action, before in snapshots:
                self._append_history(review, action, timestamp, revision, before)
            saved = self._save_unlocked(normalize_review(review))
        self._mirror_placement_actions(actions)
        return saved

    @staticmethod
    def _check_expected_revision(review: dict[str, Any], action: dict[str, Any]) -> None:
        if "expected_revision" not in action or action.get("expected_revision") is None:
            return
        raw_expected = action.get("expected_revision")
        try:
            expected = int(raw_expected)
        except (TypeError, ValueError) as error:
            raise ValueError("expected_revision 必须是整数") from error
        if expected < 0:
            raise ValueError("expected_revision 必须是非负整数")
        current = int(review.get("revision", 0))
        if expected != current:
            raise ReviewConflictError(
                f"Review revision 已变化：当前 r{current}，请求 r{expected}；请刷新后重试"
            )

    def _mirror_placement_actions(self, actions: list[dict[str, Any]]) -> None:
        """Best-effort production projection; review.json remains authoritative."""
        relevant = [
            action
            for action in actions
            if str(action.get("action", "") or "") in {"set_group_placement", "clear_group_placement"}
        ]
        if not relevant:
            return
        try:
            from .placement_supervisor_sync import mirror_review_action_to_supervisor

            for action in relevant:
                mirror_review_action_to_supervisor(self.path.parent, action)
        except Exception:
            # A projection failure must never roll back human review authority.
            # The projection is deterministic and can be regenerated/replayed.
            return

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
            self._validate_placement_targets(group_id, segment_ids)
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
                for key, limit in (
                    ("interaction", 40),
                    ("source_surface", 40),
                    ("source_kind", 24),
                    ("source_clip_id", 180),
                ):
                    value = str(action.get(key, "") or "").strip()[:limit]
                    if value:
                        entry[key] = value
                review["placements"][group_id] = entry
        elif action_type == "clear_group_placement":
            group_id = str(action.get("group_id", ""))
            if not group_id:
                raise ValueError("clear_group_placement 缺少 group_id")
            self._validate_placement_targets(group_id, [])
            review["placements"].pop(group_id, None)
        else:
            raise ValueError(f"未知 review action: {action_type}")

    def _validate_placement_targets(self, group_id: str, segment_ids: list[str]) -> None:
        """Reject stale/forged drag targets when canonical project outputs exist."""
        material_path = self.path.parent / "material_index.json"
        script_path = self.path.parent / "script.json"
        if material_path.is_file():
            try:
                with material_path.open(encoding="utf-8") as handle:
                    material = json.load(handle)
                known_groups = {
                    str(item.get("group_id", "") or "")
                    for item in material.get("groups", [])
                    if isinstance(item, dict)
                }
                if known_groups and group_id not in known_groups:
                    raise ValueError("归集 Take 已不在当前项目中，请刷新后重试")
            except json.JSONDecodeError as error:
                raise ValueError("当前项目素材索引损坏，无法安全写入归集") from error
        if segment_ids and script_path.is_file():
            try:
                with script_path.open(encoding="utf-8") as handle:
                    script = json.load(handle)
                known_segments = {
                    str(item.get("segment_id", "") or "")
                    for item in script.get("segments", [])
                    if isinstance(item, dict) and str(item.get("type", "") or "") != "scene_heading"
                }
                missing = [segment_id for segment_id in segment_ids if segment_id not in known_segments]
                if missing:
                    raise ValueError("目标剧本段已变化，请刷新后重新拖入")
            except json.JSONDecodeError as error:
                raise ValueError("当前项目剧本索引损坏，无法安全写入归集") from error

    @staticmethod
    def _audit_snapshot(review: dict[str, Any], action: dict[str, Any]) -> dict[str, Any]:
        action_type = str(action.get("action", ""))
        if action_type in {"set_group_placement", "clear_group_placement"}:
            group_id = str(action.get("group_id", "") or "")
            existing = review.get("placements", {}).get(group_id, {})
            return dict(existing) if isinstance(existing, dict) else {}
        return {}

    @staticmethod
    def _append_history(
        review: dict[str, Any],
        action: dict[str, Any],
        timestamp: str,
        revision: int,
        before: dict[str, Any],
    ) -> None:
        row: dict[str, Any] = {
            "at": timestamp,
            "revision": revision,
            "action": str(action.get("action", "") or "")[:64],
            "actor": str(action.get("actor", "") or "")[:80],
        }
        for key, limit in (
            ("group_id", 180),
            ("clip_id", 180),
            ("segment_id", 180),
            ("interaction", 40),
            ("source_surface", 40),
            ("source_kind", 24),
            ("source_clip_id", 180),
        ):
            value = str(action.get(key, "") or "").strip()[:limit]
            if value:
                row[key] = value
        if isinstance(action.get("script_segment_ids"), list):
            row["script_segment_ids"] = ReviewStore._segment_ids(action.get("script_segment_ids"))
        if isinstance(action.get("episode_ids"), list):
            row["episode_ids"] = ReviewStore._episode_ids(action.get("episode_ids"))
        if "state" in action:
            row["state"] = ReviewStore._valid_state(str(action.get("state", "unreviewed")))
        if before:
            row["before"] = before
        if row["action"] in {"set_group_placement", "clear_group_placement"}:
            group_id = str(action.get("group_id", "") or "")
            after = review.get("placements", {}).get(group_id, {})
            row["after"] = dict(after) if isinstance(after, dict) else {}
        history = review.setdefault("history", [])
        history.append(row)
        del history[:-MAX_HISTORY_ROWS]

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
