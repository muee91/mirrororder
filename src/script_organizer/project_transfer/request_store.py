from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4


class ProjectTransferRequestError(ValueError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class ProjectTransferRequestStore:
    """Device-local indirection for transfer paths used by durable tasks.

    Durable task targets contain only request_id. Absolute source/destination
    paths remain in this store under Application Support and are never copied
    into project/shared task records.
    """

    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.root, 0o700)
        except OSError:
            # Windows and some network filesystems may not implement POSIX
            # permissions. The directory still remains in device-local state.
            pass

    def _path(self, request_id: str) -> Path:
        value = str(request_id or "").strip()
        if len(value) != 32 or any(char not in "0123456789abcdef" for char in value):
            raise ProjectTransferRequestError("project transfer request_id 无效")
        return self.root / f"{value}.json"

    def create(self, kind: str, payload: dict[str, Any]) -> str:
        operation = str(kind or "").strip()
        if operation not in {"import_project", "save_project_as", "collect_project"}:
            raise ProjectTransferRequestError("不支持的 project transfer request")
        request_id = uuid4().hex
        value = {
            "version": 1,
            "request_id": request_id,
            "kind": operation,
            "created_at": _now(),
            "payload": dict(payload),
        }
        path = self._path(request_id)
        fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=self.root)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return request_id

    def load(self, request_id: str, *, expected_kind: str = "") -> dict[str, Any]:
        path = self._path(request_id)
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise ProjectTransferRequestError("project transfer request 不存在或已损坏") from error
        if not isinstance(raw, dict) or raw.get("request_id") != request_id:
            raise ProjectTransferRequestError("project transfer request 身份不一致")
        if expected_kind and raw.get("kind") != expected_kind:
            raise ProjectTransferRequestError("project transfer request 类型不匹配")
        payload = raw.get("payload")
        if not isinstance(payload, dict):
            raise ProjectTransferRequestError("project transfer request payload 无效")
        return dict(payload)

    def remove(self, request_id: str) -> None:
        try:
            self._path(request_id).unlink()
        except FileNotFoundError:
            return
