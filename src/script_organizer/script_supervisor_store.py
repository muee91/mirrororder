from __future__ import annotations

import json
import os
import tempfile
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any

try:
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None

SUPERVISOR_VERSION = 2
SUPERVISOR_CONTRACT = "script_supervisor.v2"
SHOT_TYPES = {"unknown", "wide", "full", "medium", "medium_closeup", "closeup", "extreme_closeup", "insert"}
TAKE_STATUSES = {"unmarked", "usable", "partial", "ng"}
SOURCE_ROLES = {"sync_camera", "aerial", "broll", "gopro", "insert", "custom"}


class ScriptSupervisorConflictError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _default() -> dict[str, Any]:
    return {"version": SUPERVISOR_VERSION, "contract": SUPERVISOR_CONTRACT, "revision": 0, "updated_at": "", "records": {}, "entries": {}}


def _text(value: object, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _int_or_none(value: object, label: str) -> int | None:
    if value in {None, ""}:
        return None
    try:
        result = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label}必须是整数") from error
    if result <= 0:
        raise ValueError(f"{label}必须大于 0")
    return result


def _number(value: object) -> float | None:
    if value in {None, ""}:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError("可用范围必须是秒数") from error
    if result < 0:
        raise ValueError("可用范围不能小于 0 秒")
    return round(result, 4)


def _safe_range(value: object) -> dict[str, float] | None:
    raw = value if isinstance(value, dict) else {}
    start, end = _number(raw.get("start")), _number(raw.get("end"))
    if start is None and end is None:
        return None
    if start is None:
        start = 0.0
    if end is None:
        raise ValueError("设置可用范围时必须填写结束秒数")
    if end <= start:
        raise ValueError("可用范围结束必须晚于开始")
    return {"start": start, "end": end}


def _safe_attachment(value: object) -> dict[str, Any] | None:
    raw = value if isinstance(value, dict) else {}
    clip_id, media_id = _text(raw.get("clip_id"), 160), _text(raw.get("media_id"), 160)
    if not clip_id and not media_id:
        return None
    shot_type = _text(raw.get("shot_type"), 40) or "unknown"
    if shot_type not in SHOT_TYPES:
        raise ValueError(f"不支持的景别：{shot_type}")
    source_role = _text(raw.get("source_role"), 40) or "sync_camera"
    if source_role not in SOURCE_ROLES:
        source_role = "custom"
    return {
        "clip_id": clip_id,
        "media_id": media_id,
        "camera": _text(raw.get("camera"), 40),
        "display_name": Path(_text(raw.get("display_name") or raw.get("name"), 300)).name,
        "shot_type": shot_type,
        "source_role": source_role,
        "note": _text(raw.get("note"), 500),
    }


def _safe_attachments(value: object) -> list[dict[str, Any]]:
    raw = value if isinstance(value, list) else []
    result: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for item in raw[:32]:
        safe = _safe_attachment(item)
        if not safe:
            continue
        key = (safe["clip_id"], safe["media_id"])
        if key in seen:
            continue
        seen.add(key)
        result.append(safe)
    return result


def _safe_record(record_id: str, value: object) -> dict[str, Any]:
    raw = value if isinstance(value, dict) else {}
    status = _text(raw.get("status"), 40) or "unmarked"
    if status not in TAKE_STATUSES:
        raise ValueError("场记状态必须是 unmarked、usable、partial 或 ng")
    result: dict[str, Any] = {
        "record_id": _text(record_id or raw.get("record_id"), 160),
        "source_group_id": _text(raw.get("source_group_id") or raw.get("group_id"), 160),
        # Explicit linkage only. Human-readable scene text must never be guessed
        # into an internal scene id by the store.
        "script_scene_id": _text(raw.get("script_scene_id"), 160),
        "episode": _int_or_none(raw.get("episode"), "集数"),
        "scene": _text(raw.get("scene"), 80),
        "shot": _text(raw.get("shot"), 80),
        "take_number": _int_or_none(raw.get("take_number"), "拍摄次数"),
        "status": status,
        "note": _text(raw.get("note"), 2000),
        "preferred_clip_id": _text(raw.get("preferred_clip_id"), 160),
        "attachments": _safe_attachments(raw.get("attachments")),
        "actor": _text(raw.get("actor"), 80),
        "updated_at": _text(raw.get("updated_at"), 80),
    }
    usable_range = _safe_range(raw.get("usable_range"))
    if usable_range:
        result["usable_range"] = usable_range
    return result


def _meaningful(record: dict[str, Any]) -> bool:
    return bool(record.get("source_group_id") or record.get("script_scene_id") or record.get("episode") or record.get("scene") or record.get("shot") or record.get("take_number") or record.get("status") not in {"", "unmarked"} or record.get("note") or record.get("usable_range") or record.get("preferred_clip_id") or record.get("attachments"))


def _record_from_legacy(group_id: str, entry: object) -> dict[str, Any]:
    raw = entry if isinstance(entry, dict) else {}
    attachments = []
    for clip_id, angle in (raw.get("angles", {}) if isinstance(raw.get("angles"), dict) else {}).items():
        if isinstance(angle, dict):
            attachments.append({"clip_id": str(clip_id), "media_id": "", "camera": "", "display_name": "", "shot_type": angle.get("shot_type", "unknown"), "source_role": "sync_camera", "note": angle.get("note", "")})
    return _safe_record(f"legacy-{group_id}", {**raw, "source_group_id": group_id, "attachments": attachments})


def _legacy_entry(record: dict[str, Any]) -> dict[str, Any]:
    group_id = str(record.get("source_group_id", "") or "")
    angles: dict[str, dict[str, Any]] = {}
    for attachment in record.get("attachments", []):
        if not isinstance(attachment, dict):
            continue
        clip_id = str(attachment.get("clip_id", "") or "")
        if not clip_id:
            continue
        shot_type, note = str(attachment.get("shot_type", "unknown") or "unknown"), str(attachment.get("note", "") or "")
        if shot_type != "unknown" or note:
            angles[clip_id] = {"shot_type": shot_type, "note": note}
    result: dict[str, Any] = {
        "group_id": group_id,
        "script_scene_id": str(record.get("script_scene_id", "") or ""),
        "scene": str(record.get("scene", "") or ""),
        "shot": str(record.get("shot", "") or ""),
        "take_number": record.get("take_number"),
        "status": str(record.get("status", "unmarked") or "unmarked"),
        "note": str(record.get("note", "") or ""),
        "preferred_clip_id": str(record.get("preferred_clip_id", "") or ""),
        "angles": angles,
        "actor": str(record.get("actor", "") or ""),
        "updated_at": str(record.get("updated_at", "") or ""),
    }
    if isinstance(record.get("usable_range"), dict):
        result["usable_range"] = dict(record["usable_range"])
    return result


def _project_entries(records: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    chosen: dict[str, dict[str, Any]] = {}
    for record in records.values():
        group_id = str(record.get("source_group_id", "") or "")
        if not group_id:
            continue
        current = chosen.get(group_id)
        if current is None or str(record.get("updated_at", "")) >= str(current.get("updated_at", "")):
            chosen[group_id] = record
    return {group_id: _legacy_entry(record) for group_id, record in chosen.items()}


class ScriptSupervisorStore:
    """Revision-safe electronic slate whose records are independent of algorithmic Take ids."""

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
        records: dict[str, dict[str, Any]] = {}
        if int(payload.get("version", 1) or 1) >= 2 and isinstance(payload.get("records"), dict):
            for record_id, row in payload["records"].items():
                try:
                    safe = _safe_record(str(record_id), row)
                except ValueError:
                    continue
                if safe.get("record_id") and _meaningful(safe):
                    records[safe["record_id"]] = safe
        else:
            for group_id, row in (payload.get("entries", {}) if isinstance(payload.get("entries"), dict) else {}).items():
                try:
                    safe = _record_from_legacy(str(group_id), row)
                except ValueError:
                    continue
                if _meaningful(safe):
                    records[safe["record_id"]] = safe
        result = _default()
        result["revision"] = int(payload.get("revision", 0) or 0)
        result["updated_at"] = _text(payload.get("updated_at"), 80)
        result["records"] = records
        result["entries"] = _project_entries(records)
        return result

    def _save_unlocked(self, payload: dict[str, Any]) -> dict[str, Any]:
        persisted = {"version": SUPERVISOR_VERSION, "contract": SUPERVISOR_CONTRACT, "revision": int(payload.get("revision", 0) or 0), "updated_at": str(payload.get("updated_at", "") or ""), "records": payload.get("records", {})}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=self.path.name + ".", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(persisted, handle, ensure_ascii=False, indent=2)
                handle.flush(); os.fsync(handle.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return self.load()

    @staticmethod
    def _write_context(action: dict[str, Any]) -> tuple[int, str]:
        try:
            expected_revision = int(action.get("expected_revision"))
        except (TypeError, ValueError) as error:
            raise ValueError("场记写入必须带 expected_revision") from error
        actor = _text(action.get("actor"), 80)
        if not actor:
            raise ValueError("场记写入需要操作者昵称")
        return expected_revision, actor

    def apply_record(self, action: dict[str, Any]) -> dict[str, Any]:
        expected_revision, actor = self._write_context(action)
        record_id = _text(action.get("record_id"), 160) or f"slate-{uuid.uuid4().hex}"
        raw_record = action.get("record", {}) if isinstance(action.get("record"), dict) else {}
        delete = bool(action.get("delete"))
        with self._write_lock():
            payload = self.load(); current_revision = int(payload.get("revision", 0) or 0)
            if expected_revision != current_revision:
                raise ScriptSupervisorConflictError(f"script supervisor revision 已变化：expected {expected_revision}, current {current_revision}")
            records = dict(payload.get("records", {}))
            if delete:
                records.pop(record_id, None)
            else:
                previous = records.get(record_id, {}) if isinstance(records.get(record_id), dict) else {}
                safe = _safe_record(record_id, {**previous, **raw_record, "actor": actor, "updated_at": _now()})
                if _meaningful(safe): records[record_id] = safe
                else: records.pop(record_id, None)
            return self._save_unlocked({"revision": current_revision + 1, "updated_at": _now(), "records": records})

    def apply(self, action: dict[str, Any]) -> dict[str, Any]:
        group_id = _text(action.get("group_id"), 160)
        if not group_id:
            raise ValueError("场记标注必须指定 group_id")
        payload = self.load()
        existing_id = next((record_id for record_id, record in payload.get("records", {}).items() if isinstance(record, dict) and record.get("source_group_id") == group_id), f"legacy-{group_id}")
        entry = action.get("entry", {}) if isinstance(action.get("entry"), dict) else {}
        attachments = [{"clip_id": clip_id, **angle} for clip_id, angle in (entry.get("angles", {}) if isinstance(entry.get("angles"), dict) else {}).items() if isinstance(angle, dict)]
        return self.apply_record({"record_id": existing_id, "expected_revision": action.get("expected_revision"), "actor": action.get("actor"), "delete": not bool(entry), "record": {**entry, "source_group_id": group_id, "attachments": attachments}})

    def clear(self, *, group_id: str, expected_revision: int, actor: str) -> dict[str, Any]:
        return self.apply({"group_id": group_id, "expected_revision": expected_revision, "actor": actor, "entry": {}})

    def for_group(self, group_id: str) -> dict[str, Any]:
        entry = self.load().get("entries", {}).get(str(group_id), {})
        return dict(entry) if isinstance(entry, dict) else {}

    def record_for_group(self, group_id: str) -> dict[str, Any]:
        rows = [record for record in self.load().get("records", {}).values() if isinstance(record, dict) and record.get("source_group_id") == str(group_id)]
        rows.sort(key=lambda row: str(row.get("updated_at", "")), reverse=True)
        return dict(rows[0]) if rows else {}

    def summary(self) -> dict[str, int]:
        rows = [row for row in self.load().get("records", {}).values() if isinstance(row, dict)]
        return {
            "annotated": len(rows),
            "linked_takes": sum(1 for row in rows if row.get("source_group_id")),
            "linked_script_scenes": sum(1 for row in rows if row.get("script_scene_id")),
            "standalone": sum(1 for row in rows if not row.get("source_group_id")),
            "attachments": sum(len(row.get("attachments", [])) for row in rows),
            "usable": sum(1 for row in rows if row.get("status") == "usable"),
            "partial": sum(1 for row in rows if row.get("status") == "partial"),
            "ng": sum(1 for row in rows if row.get("status") == "ng"),
            "notes": sum(1 for row in rows if row.get("note")),
        }
