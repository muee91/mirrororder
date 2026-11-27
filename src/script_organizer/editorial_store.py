from __future__ import annotations

import json
import math
import os
import secrets
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
        "version": 2,
        "revision": 0,
        "updated_at": "",
        "opinions": {},
        "decisions": {},
        "comments": {},
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


def _normalize_opinion_row(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    target = value.get("target", {}) if isinstance(value.get("target"), dict) else {}
    reviewers = value.get("reviewers", {}) if isinstance(value.get("reviewers"), dict) else {}
    # v1 stored opinions under `actors`. Preserve them as actor-fallback reviewer
    # identities so an existing collaboration file remains readable.
    if not reviewers and isinstance(value.get("actors"), dict):
        for actor, opinion in value["actors"].items():
            if not isinstance(opinion, dict):
                continue
            name = str(opinion.get("actor", actor) or actor)[:80]
            reviewers[f"actor:{name}"] = {
                **opinion,
                "actor": name,
                "reviewer_id": str(opinion.get("reviewer_id", "") or ""),
            }
    return {"target": dict(target), "reviewers": reviewers}


def _clean_text(value: object, max_len: int = 500) -> str:
    return str(value or "").strip()[:max_len]


def _clean_source_time(value: object) -> float | None:
    if value is None or value == "":
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(num) or num < 0:
        return None
    return round(num, 3)


def _normalize_comment_row(value: object) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    comment_id = str(value.get("comment_id", "") or "").strip()[:80]
    group_id = str(value.get("group_id", "") or "").strip()[:180]
    actor = str(value.get("actor", "") or "").strip()[:80]
    text = _clean_text(value.get("text"), 500)
    if not comment_id or not group_id or not actor or not text:
        return None
    return {
        "comment_id": comment_id,
        "group_id": group_id,
        "segment_id": str(value.get("segment_id", "") or "").strip()[:180],
        "clip_id": str(value.get("clip_id", "") or "").strip()[:160],
        "camera": str(value.get("camera", "") or "").strip()[:40],
        "source_time": _clean_source_time(value.get("source_time")),
        "text": text,
        "actor": actor,
        "reviewer_id": str(value.get("reviewer_id", "") or "").strip()[:120],
        "created_at": str(value.get("created_at", "") or "")[:80],
    }


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
    if isinstance(opinions, dict):
        result["opinions"] = {
            str(key): normalized
            for key, value in opinions.items()
            if (normalized := _normalize_opinion_row(value))
        }
    decisions = raw.get("decisions", {})
    result["decisions"] = decisions if isinstance(decisions, dict) else {}
    comments = raw.get("comments", {})
    if isinstance(comments, dict):
        normalized_comments: dict[str, list[dict[str, Any]]] = {}
        for key, rows in comments.items():
            if not isinstance(rows, list):
                continue
            cleaned = [item for row in rows if (item := _normalize_comment_row(row)) is not None]
            if cleaned:
                normalized_comments[str(key)] = cleaned[:200]
        result["comments"] = normalized_comments
    return result


class EditorialStore:
    """Shared, revision-safe collaboration state separate from legacy review.json.

    Individual opinions merge by stable reviewer identity so concurrent
    collaborators — including people with the same display nickname — do not
    overwrite each other. Final editorial decisions are a separate axis and
    require an expected revision.
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
    def _reviewer(action: dict[str, Any], actor: str) -> tuple[str, str]:
        reviewer_id = str(action.get("reviewer_id", "") or "").strip()[:120]
        return (f"id:{reviewer_id}", reviewer_id) if reviewer_id else (f"actor:{actor}", "")

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
        reviewer_key, reviewer_id = self._reviewer(action, actor)
        state = _state(action.get("state"))
        note = _clean_text(action.get("note"), 500)
        clip_id = _clean_text(action.get("clip_id"), 160)
        camera = _clean_text(action.get("camera"), 40)
        source_time = _clean_source_time(action.get("source_time"))
        target = self._target_from_action(action)
        key = _target_key(target)
        with self._write_lock():
            payload = self.load()
            opinions = payload["opinions"]
            row = opinions.get(key, {}) if isinstance(opinions.get(key), dict) else {}
            reviewers = row.get("reviewers", {}) if isinstance(row.get("reviewers"), dict) else {}
            if state == "unreviewed" and not note:
                reviewers.pop(reviewer_key, None)
            else:
                reviewers[reviewer_key] = {
                    "state": state,
                    "actor": actor,
                    "reviewer_id": reviewer_id,
                    "note": note,
                    "clip_id": clip_id,
                    "camera": camera,
                    "source_time": source_time,
                    "updated_at": _now(),
                }
            if reviewers:
                opinions[key] = {"target": target, "reviewers": reviewers}
            else:
                opinions.pop(key, None)
            payload["revision"] = int(payload.get("revision", 0) or 0) + 1
            payload["updated_at"] = _now()
            return self._save_unlocked(payload)

    def add_comment(self, action: dict[str, Any]) -> dict[str, Any]:
        """Append a timestamped or general comment for a Take group."""

        actor = self._actor(action.get("actor"))
        _, reviewer_id = self._reviewer(action, actor)
        group_id = _clean_text(action.get("group_id"), 180)
        if not group_id:
            raise ValueError("评论缺少 group_id")
        text = _clean_text(action.get("text"), 500)
        if not text:
            raise ValueError("评论内容不能为空")
        key = f"group|{group_id}"
        comment = {
            "comment_id": f"cmt_{secrets.token_urlsafe(9)}",
            "group_id": group_id,
            "segment_id": _clean_text(action.get("segment_id"), 180),
            "clip_id": _clean_text(action.get("clip_id"), 160),
            "camera": _clean_text(action.get("camera"), 40),
            "source_time": _clean_source_time(action.get("source_time")),
            "text": text,
            "actor": actor,
            "reviewer_id": reviewer_id,
            "created_at": _now(),
        }
        with self._write_lock():
            payload = self.load()
            comments = payload.setdefault("comments", {})
            rows = list(comments.get(key, [])) if isinstance(comments.get(key), list) else []
            rows.append(comment)
            comments[key] = rows[-200:]
            payload["revision"] = int(payload.get("revision", 0) or 0) + 1
            payload["updated_at"] = _now()
            return self._save_unlocked(payload)

    def delete_comment(self, action: dict[str, Any], *, allow_any: bool = False) -> dict[str, Any]:
        """Delete one comment, enforcing ownership unless called from host-local."""

        group_id = _clean_text(action.get("group_id"), 180)
        comment_id = _clean_text(action.get("comment_id"), 80)
        if not group_id or not comment_id:
            raise ValueError("删除评论需要 group_id 与 comment_id")
        actor = _clean_text(action.get("actor"), 80)
        reviewer_id = _clean_text(action.get("reviewer_id"), 120)
        key = f"group|{group_id}"
        with self._write_lock():
            payload = self.load()
            comments = payload.setdefault("comments", {})
            rows = list(comments.get(key, [])) if isinstance(comments.get(key), list) else []
            target_row = next((row for row in rows if isinstance(row, dict) and row.get("comment_id") == comment_id), None)
            if target_row is None:
                raise ValueError("评论不存在或已被删除")
            if not allow_any:
                owner_id = str(target_row.get("reviewer_id", "") or "")
                owner_actor = str(target_row.get("actor", "") or "")
                matches_id = bool(reviewer_id and owner_id and reviewer_id == owner_id)
                matches_actor = bool(actor and owner_actor and actor == owner_actor and not owner_id)
                if not (matches_id or matches_actor):
                    raise PermissionError("只能删除自己发表的评论")
            next_rows = [row for row in rows if not (isinstance(row, dict) and row.get("comment_id") == comment_id)]
            if next_rows:
                comments[key] = next_rows
            else:
                comments.pop(key, None)
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
            reviewers = row.get("reviewers", {}) if isinstance(row.get("reviewers"), dict) else {}
            for opinion in reviewers.values():
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
            str(item.get("reviewer_id", "")),
            str(item.get("actor", "")),
            str(item.get("updated_at", "")),
        )
        group_opinions.sort(key=key)
        assignment_opinions.sort(key=key)
        assignment_decisions.sort(key=key)
        group_comments = list(payload.get("comments", {}).get(f"group|{group_id}", []))
        group_comments.sort(key=lambda item: (str(item.get("created_at", "")), str(item.get("comment_id", ""))))
        return {
            "revision": int(payload.get("revision", 0) or 0),
            "opinions": {"group": group_opinions, "assignments": assignment_opinions},
            "decision": {"group": group_decision, "assignments": assignment_decisions},
            "comments": group_comments,
        }

    def collaboration_index(self) -> dict[str, dict[str, Any]]:
        """All groups' collaboration from a single load; per-group results
        are identical to :meth:`for_group`. Read models building payloads for
        every take must consume this instead of looping over ``for_group``
        (1500 groups used to mean 1501 full-file parses per request)."""
        payload = self.load()
        revision = int(payload.get("revision", 0) or 0)
        group_opinions: dict[str, list[dict[str, Any]]] = {}
        assignment_opinions: dict[str, list[dict[str, Any]]] = {}
        group_decisions: dict[str, dict[str, Any]] = {}
        assignment_decisions: dict[str, list[dict[str, Any]]] = {}
        for row in payload.get("opinions", {}).values():
            if not isinstance(row, dict):
                continue
            target = row.get("target", {}) if isinstance(row.get("target"), dict) else {}
            group_id = str(target.get("group_id", "") or "")
            if not group_id:
                continue
            reviewers = row.get("reviewers", {}) if isinstance(row.get("reviewers"), dict) else {}
            destination = (
                assignment_opinions.setdefault(group_id, [])
                if target.get("kind") == "assignment"
                else group_opinions.setdefault(group_id, [])
            )
            for opinion in reviewers.values():
                if isinstance(opinion, dict):
                    destination.append({"target": dict(target), **opinion})
        for decision in payload.get("decisions", {}).values():
            if not isinstance(decision, dict):
                continue
            target = decision.get("target", {}) if isinstance(decision.get("target"), dict) else {}
            group_id = str(target.get("group_id", "") or "")
            if not group_id:
                continue
            row = {"target": dict(target), **{key: value for key, value in decision.items() if key != "target"}}
            if target.get("kind") == "assignment":
                assignment_decisions.setdefault(group_id, []).append(row)
            else:
                group_decisions[group_id] = row
        group_comments: dict[str, list[dict[str, Any]]] = {}
        for key_name, rows in payload.get("comments", {}).items():
            if not isinstance(rows, list):
                continue
            gid = str(key_name).removeprefix("group|")
            if gid:
                group_comments[gid] = list(rows)
        key = lambda item: (
            str(item.get("target", {}).get("segment_id", "")),
            str(item.get("reviewer_id", "")),
            str(item.get("actor", "")),
            str(item.get("updated_at", "")),
        )
        index: dict[str, dict[str, Any]] = {}
        for group_id in set(group_opinions) | set(assignment_opinions) | set(group_decisions) | set(assignment_decisions) | set(group_comments):
            group_rows = group_opinions.get(group_id, [])
            group_rows.sort(key=key)
            assignment_rows = assignment_opinions.get(group_id, [])
            assignment_rows.sort(key=key)
            decision_rows = assignment_decisions.get(group_id, [])
            decision_rows.sort(key=key)
            comment_rows = group_comments.get(group_id, [])
            comment_rows.sort(key=lambda item: (str(item.get("created_at", "")), str(item.get("comment_id", ""))))
            index[group_id] = {
                "revision": revision,
                "opinions": {"group": group_rows, "assignments": assignment_rows},
                "decision": {"group": group_decisions.get(group_id), "assignments": decision_rows},
                "comments": comment_rows,
            }
        return index
