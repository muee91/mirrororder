from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any

AUTOMATION_STATUSES = {
    "auto_confirmed",
    "ai_confirmed",
    "needs_review",
    "unresolved",
    "human_override",
}
COMPLETED_STATUSES = {"auto_confirmed", "ai_confirmed", "human_override"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def empty_automation() -> dict[str, Any]:
    return {
        "version": 1,
        "analysis_revision": "",
        "updated_at": "",
        "groups": {},
        "summary": {
            "total": 0,
            "auto_confirmed": 0,
            "ai_confirmed": 0,
            "human_override": 0,
            "needs_review": 0,
            "unresolved": 0,
            "completed": 0,
        },
        "model": {"enabled": False, "provider": "none", "model": ""},
    }


def summarize(groups: dict[str, Any]) -> dict[str, int]:
    summary = {
        "total": len(groups),
        "auto_confirmed": 0,
        "ai_confirmed": 0,
        "human_override": 0,
        "needs_review": 0,
        "unresolved": 0,
        "completed": 0,
    }
    for entry in groups.values():
        status = str(entry.get("status", "unresolved")) if isinstance(entry, dict) else "unresolved"
        if status in summary:
            summary[status] += 1
        if status in COMPLETED_STATUSES:
            summary["completed"] += 1
    return summary


class AutomationStore:
    _lock = RLock()

    def __init__(self, output_dir: str | Path):
        self.path = Path(output_dir) / "auto_decisions.json"

    def load(self) -> dict[str, Any]:
        if not self.path.exists():
            return empty_automation()
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return empty_automation()
        if not isinstance(raw, dict):
            return empty_automation()
        groups = raw.get("groups", {}) if isinstance(raw.get("groups", {}), dict) else {}
        result = empty_automation()
        result["analysis_revision"] = str(raw.get("analysis_revision", "") or "")
        result["updated_at"] = str(raw.get("updated_at", "") or "")
        result["groups"] = groups
        result["summary"] = summarize(groups)
        model = raw.get("model", {})
        if isinstance(model, dict):
            result["model"].update({
                "enabled": bool(model.get("enabled", False)),
                "provider": str(model.get("provider", "none") or "none"),
                "model": str(model.get("model", "") or ""),
            })
        return result

    def save(
        self,
        analysis_revision: str,
        groups: dict[str, Any],
        model: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = empty_automation()
        payload["analysis_revision"] = analysis_revision
        payload["updated_at"] = _now()
        payload["groups"] = groups
        payload["summary"] = summarize(groups)
        if isinstance(model, dict):
            payload["model"].update(model)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._lock:
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
