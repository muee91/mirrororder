from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any


ASSISTANT_CONTRACT = "assistant.v1"
ASSISTANT_VERSION = 1


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _default() -> dict[str, Any]:
    return {
        "version": ASSISTANT_VERSION,
        "contract": ASSISTANT_CONTRACT,
        "revision": 0,
        "updated_at": "",
        "source_fingerprint": "",
        "summary": "",
        "items": [],
        "orchestration": {
            "last_trigger": "",
            "last_action_fingerprint": "",
            "last_action": {},
        },
        "messages": [],
    }


class AssistantStore:
    """Shared derived assistant state; never a production decision authority."""

    _lock = RLock()

    def __init__(self, output_dir: str | Path):
        self.path = Path(output_dir) / "assistant.json"

    def load(self) -> dict[str, Any]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return _default()
        if not isinstance(raw, dict):
            return _default()
        payload = _default()
        payload.update(raw)
        payload["version"] = ASSISTANT_VERSION
        payload["contract"] = ASSISTANT_CONTRACT
        payload["items"] = raw.get("items", []) if isinstance(raw.get("items"), list) else []
        payload["messages"] = raw.get("messages", []) if isinstance(raw.get("messages"), list) else []
        payload["orchestration"] = raw.get("orchestration", {}) if isinstance(raw.get("orchestration"), dict) else {}
        return payload

    def save(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            current = self.load()
            saved = _default()
            saved.update(payload)
            saved["version"] = ASSISTANT_VERSION
            saved["contract"] = ASSISTANT_CONTRACT
            saved["revision"] = int(current.get("revision", 0) or 0) + 1
            saved["updated_at"] = _now()
            saved["items"] = payload.get("items", []) if isinstance(payload.get("items"), list) else []
            saved["messages"] = (payload.get("messages", []) if isinstance(payload.get("messages"), list) else [])[-40:]
            saved["orchestration"] = payload.get("orchestration", {}) if isinstance(payload.get("orchestration"), dict) else {}
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=self.path.name + ".", suffix=".tmp", dir=self.path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    json.dump(saved, handle, ensure_ascii=False, indent=2)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            return saved

    def append_message(self, role: str, text: str, *, source: str = "assistant") -> dict[str, Any]:
        payload = self.load()
        messages = list(payload.get("messages", []))
        messages.append(
            {
                "role": "user" if role == "user" else "assistant",
                "text": str(text or "")[:4000],
                "source": str(source or "assistant")[:80],
                "created_at": _now(),
            }
        )
        payload["messages"] = messages[-40:]
        return self.save(payload)
