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
except ImportError:  # pragma: no cover
    fcntl = None


MEDIA_ROLE_CONTRACT = "media_roles.v1"
MEDIA_ROLE_VERSION = 1
SOURCE_ROLES = {"sync_camera", "aerial", "broll", "gopro", "insert", "custom"}
SYNC_POLICIES = {"auto", "exclude"}


class MediaRoleConflictError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _text(value: object, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _default() -> dict[str, Any]:
    return {
        "version": MEDIA_ROLE_VERSION,
        "contract": MEDIA_ROLE_CONTRACT,
        "revision": 0,
        "updated_at": "",
        "media": {},
    }


def _safe_entry(media_id: str, value: object) -> dict[str, Any]:
    raw = value if isinstance(value, dict) else {}
    source_role = _text(raw.get("source_role"), 40) or "sync_camera"
    if source_role not in SOURCE_ROLES:
        raise ValueError(f"不支持的素材角色：{source_role}")
    sync_policy = _text(raw.get("sync_policy"), 20)
    if not sync_policy:
        sync_policy = "auto" if source_role == "sync_camera" else "exclude"
    if sync_policy not in SYNC_POLICIES:
        raise ValueError("sync_policy 必须是 auto 或 exclude")
    return {
        "media_id": _text(media_id, 160),
        "display_name": _text(raw.get("display_name"), 300),
        "camera_override": _text(raw.get("camera_override"), 40).upper(),
        "source_role": source_role,
        "role_label": _text(raw.get("role_label"), 80),
        "sync_policy": sync_policy,
        "scene_id": _text(raw.get("scene_id"), 160),
        "note": _text(raw.get("note"), 1200),
        "actor": _text(raw.get("actor"), 80),
        "updated_at": _text(raw.get("updated_at"), 80),
    }


def _meaningful(entry: dict[str, Any]) -> bool:
    return bool(
        entry.get("camera_override")
        or entry.get("source_role") != "sync_camera"
        or entry.get("sync_policy") != "auto"
        or entry.get("role_label")
        or entry.get("scene_id")
        or entry.get("note")
    )


class MediaRoleStore:
    """Shared human metadata keyed by physical `media_id`.

    Camera/source-role overrides are production facts. They do not change
    Editorial Decision or delivery state and never contain device-local paths.
    """

    _thread_lock = RLock()

    def __init__(self, output_dir: str | Path):
        self.path = Path(output_dir) / "media_roles.json"

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
        result = _default()
        result["revision"] = int(payload.get("revision", 0) or 0)
        result["updated_at"] = _text(payload.get("updated_at"), 80)
        rows = payload.get("media", {}) if isinstance(payload.get("media"), dict) else {}
        normalized: dict[str, dict[str, Any]] = {}
        for media_id, raw in rows.items():
            try:
                entry = _safe_entry(str(media_id), raw)
            except ValueError:
                continue
            if entry.get("media_id") and _meaningful(entry):
                normalized[str(media_id)] = entry
        result["media"] = normalized
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

    def apply_many(self, action: dict[str, Any]) -> dict[str, Any]:
        try:
            expected_revision = int(action.get("expected_revision"))
        except (TypeError, ValueError) as error:
            raise ValueError("素材角色写入必须带 expected_revision") from error
        actor = _text(action.get("actor"), 80)
        if not actor:
            raise ValueError("素材角色写入需要操作者昵称")
        changes = action.get("changes", []) if isinstance(action.get("changes"), list) else []
        if not changes:
            raise ValueError("素材角色写入至少需要一条 change")
        if len(changes) > 200:
            raise ValueError("单次最多修改 200 条素材角色")

        with self._write_lock():
            payload = self.load()
            current_revision = int(payload.get("revision", 0) or 0)
            if expected_revision != current_revision:
                raise MediaRoleConflictError(
                    f"media roles revision 已变化：expected {expected_revision}, current {current_revision}"
                )
            rows = dict(payload.get("media", {}))
            timestamp = _now()
            for change in changes:
                if not isinstance(change, dict):
                    continue
                media_id = _text(change.get("media_id"), 160)
                if not media_id:
                    raise ValueError("素材角色 change 缺少 media_id")
                entry = _safe_entry(
                    media_id,
                    {
                        **(change.get("entry", {}) if isinstance(change.get("entry"), dict) else {}),
                        "actor": actor,
                        "updated_at": timestamp,
                    },
                )
                if _meaningful(entry):
                    rows[media_id] = entry
                else:
                    rows.pop(media_id, None)
            saved = {
                "version": MEDIA_ROLE_VERSION,
                "contract": MEDIA_ROLE_CONTRACT,
                "revision": current_revision + 1,
                "updated_at": timestamp,
                "media": rows,
            }
            return self._save_unlocked(saved)

    def for_media(self, media_id: str) -> dict[str, Any]:
        row = self.load().get("media", {}).get(str(media_id), {})
        return dict(row) if isinstance(row, dict) else {}

    def auxiliary(self) -> list[dict[str, Any]]:
        rows = [dict(row) for row in self.load().get("media", {}).values() if isinstance(row, dict)]
        rows = [row for row in rows if row.get("source_role") != "sync_camera" or row.get("sync_policy") == "exclude"]
        rows.sort(key=lambda row: (str(row.get("scene_id", "")), str(row.get("display_name", "")), str(row.get("media_id", ""))))
        return rows
