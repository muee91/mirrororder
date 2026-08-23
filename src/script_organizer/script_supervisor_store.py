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
except ImportError:  # pragma: no cover - Windows compatibility
    fcntl = None


SUPERVISOR_VERSION = 1
SUPERVISOR_CONTRACT = "script_supervisor.v1"
SHOT_TYPES = {
    "unknown",
    "wide",
    "full",
    "medium",
    "medium_closeup",
    "closeup",
    "extreme_closeup",
    "insert",
}
TAKE_STATUSES = {"unmarked", "usable", "partial", "ng"}


class ScriptSupervisorConflictError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _default() -> dict[str, Any]:
    return {
        "version": SUPERVISOR_VERSION,
        "contract": SUPERVISOR_CONTRACT,
        "revision": 0,
        "updated_at": "",
        "entries": {},
    }


def _text(value: object, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _number(value: object) -> float | None:
    if value in {None, ""}:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise ValueError("可用范围必须是秒数")
    if result < 0:
        raise ValueError("可用范围不能小于 0 秒")
    return round(result, 4)


def _take_number(value: object) -> int | None:
    if value in {None, ""}:
        return None
    try:
        result = int(value)
    except (TypeError, ValueError):
        raise ValueError("拍摄次数必须是整数")
    if result <= 0:
        raise ValueError("拍摄次数必须大于 0")
    return result


def _safe_range(value: object) -> dict[str, float] | None:
    raw = value if isinstance(value, dict) else {}
    start = _number(raw.get("start"))
    end = _number(raw.get("end"))
    if start is None and end is None:
        return None
    if start is None:
        start = 0.0
    if end is None:
        raise ValueError("设置可用范围时必须填写结束秒数")
    if end <= start:
        raise ValueError("可用范围结束必须晚于开始")
    return {"start": start, "end": end}


def _safe_angles(value: object) -> dict[str, dict[str, Any]]:
    raw = value if isinstance(value, dict) else {}
    result: dict[str, dict[str, Any]] = {}
    for clip_id, row in raw.items():
        if not isinstance(row, dict):
            continue
        key = _text(clip_id, 160)
        if not key:
            continue
        shot_type = _text(row.get("shot_type"), 40) or "unknown"
        if shot_type not in SHOT_TYPES:
            raise ValueError(f"不支持的景别：{shot_type}")
        note = _text(row.get("note"), 500)
        if shot_type == "unknown" and not note:
            continue
        result[key] = {
            "shot_type": shot_type,
            "note": note,
        }
    return result


def _safe_entry(group_id: str, value: object) -> dict[str, Any]:
    raw = value if isinstance(value, dict) else {}
    status = _text(raw.get("status"), 40) or "unmarked"
    if status not in TAKE_STATUSES:
        raise ValueError("场记状态必须是 unmarked、usable、partial 或 ng")
    usable_range = _safe_range(raw.get("usable_range"))
    preferred_clip_id = _text(raw.get("preferred_clip_id"), 160)
    result: dict[str, Any] = {
        "group_id": _text(group_id, 160),
        "scene": _text(raw.get("scene"), 80),
        "shot": _text(raw.get("shot"), 80),
        "take_number": _take_number(raw.get("take_number")),
        "status": status,
        "note": _text(raw.get("note"), 2000),
        "preferred_clip_id": preferred_clip_id,
        "angles": _safe_angles(raw.get("angles")),
        "actor": _text(raw.get("actor"), 80),
        "updated_at": _text(raw.get("updated_at"), 80),
    }
    if usable_range:
        result["usable_range"] = usable_range
    return result


def _meaningful(entry: dict[str, Any]) -> bool:
    return bool(
        entry.get("scene")
        or entry.get("shot")
        or entry.get("take_number")
        or entry.get("status") not in {"", "unmarked"}
        or entry.get("note")
        or entry.get("usable_range")
        or entry.get("preferred_clip_id")
        or entry.get("angles")
    )


class ScriptSupervisorStore:
    """Shared, revision-safe human script-supervisor annotations.

    This store records production facts and notes. It is not Editorial Decision,
    does not write review.json, and must never contain device-local media paths.
    """

    _thread_lock = RLock()

    def __init__(self, output_dir: str | Path):
        self.path = Path(output_dir) / "script_supervisor.json"

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
            return _default()
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return _default()
        if not isinstance(payload, dict):
            return _default()
        entries = payload.get("entries", {}) if isinstance(payload.get("entries"), dict) else {}
        result = _default()
        result["revision"] = int(payload.get("revision", 0) or 0)
        result["updated_at"] = _text(payload.get("updated_at"), 80)
        normalized: dict[str, dict[str, Any]] = {}
        for group_id, entry in entries.items():
            try:
                safe = _safe_entry(str(group_id), entry)
            except ValueError:
                continue
            if _meaningful(safe):
                normalized[str(group_id)] = safe
        result["entries"] = normalized
        return result

    def _save_unlocked(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
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

    def apply(self, action: dict[str, Any]) -> dict[str, Any]:
        group_id = _text(action.get("group_id"), 160)
        if not group_id:
            raise ValueError("场记标注必须指定 group_id")
        try:
            expected_revision = int(action.get("expected_revision"))
        except (TypeError, ValueError) as error:
            raise ValueError("场记写入必须带 expected_revision") from error
        actor = _text(action.get("actor"), 80)
        if not actor:
            raise ValueError("场记写入需要操作者昵称")

        with self._write_lock():
            payload = self.load()
            current_revision = int(payload.get("revision", 0) or 0)
            if expected_revision != current_revision:
                raise ScriptSupervisorConflictError(
                    f"script supervisor revision 已变化：expected {expected_revision}, current {current_revision}"
                )
            raw_entry = action.get("entry", {}) if isinstance(action.get("entry"), dict) else {}
            safe = _safe_entry(group_id, {**raw_entry, "actor": actor, "updated_at": _now()})
            entries = dict(payload.get("entries", {}))
            if _meaningful(safe):
                entries[group_id] = safe
            else:
                entries.pop(group_id, None)
            saved = {
                "version": SUPERVISOR_VERSION,
                "contract": SUPERVISOR_CONTRACT,
                "revision": current_revision + 1,
                "updated_at": _now(),
                "entries": entries,
            }
            return self._save_unlocked(saved)

    def clear(self, *, group_id: str, expected_revision: int, actor: str) -> dict[str, Any]:
        return self.apply(
            {
                "group_id": group_id,
                "expected_revision": expected_revision,
                "actor": actor,
                "entry": {},
            }
        )

    def for_group(self, group_id: str) -> dict[str, Any]:
        entry = self.load().get("entries", {}).get(str(group_id), {})
        return dict(entry) if isinstance(entry, dict) else {}

    def summary(self) -> dict[str, int]:
        entries = self.load().get("entries", {})
        rows = [row for row in entries.values() if isinstance(row, dict)]
        return {
            "annotated": len(rows),
            "usable": sum(1 for row in rows if row.get("status") == "usable"),
            "partial": sum(1 for row in rows if row.get("status") == "partial"),
            "ng": sum(1 for row in rows if row.get("status") == "ng"),
            "notes": sum(1 for row in rows if row.get("note")),
        }
