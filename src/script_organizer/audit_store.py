from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any


AUDIT_VERSION = 1
AUDIT_CONTRACT = "audit.v1"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _default() -> dict[str, Any]:
    return {
        "version": AUDIT_VERSION,
        "contract": AUDIT_CONTRACT,
        "revision": 0,
        "updated_at": "",
        "analysis_revision": "",
        "automation_updated_at": "",
        "review_revision": 0,
        "summary": {},
        "groups": {},
    }


def _shared_group(row: object) -> dict[str, Any]:
    """Remove device/runtime-only details before audit evidence is shared."""
    if not isinstance(row, dict):
        return {}
    result = json.loads(json.dumps(row, ensure_ascii=False))
    judge = result.get("judge")
    if isinstance(judge, dict):
        judge.pop("provider", None)
        judge.pop("model", None)
    suggestions = result.get("role_suggestions")
    if isinstance(suggestions, list):
        for suggestion in suggestions:
            if isinstance(suggestion, dict):
                # Identity IDs are derived from device-local biometric clusters.
                # The shared artifact needs the role hypothesis, not the local
                # cluster handle used to inspect it on one Mac.
                suggestion.pop("identity_id", None)
                suggestion.pop("local_identity_id", None)
    return result


class AuditStore:
    """Shared, rebuildable AI audit artifact.

    audit.json is evidence, not review authority. It may be regenerated whenever
    its evidence fingerprint changes and must never write review.json,
    editorial.json or auto_decisions.json. Device-local identity IDs, model
    runtime details and media paths are not part of the shared contract.
    """

    def __init__(self, output_dir: Path):
        self.path = Path(output_dir) / "audit.json"
        self._lock = RLock()

    def load(self) -> dict[str, Any]:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return _default()
        if not isinstance(payload, dict):
            return _default()
        result = _default()
        result.update(payload)
        result["version"] = AUDIT_VERSION
        result["contract"] = AUDIT_CONTRACT
        result["groups"] = payload.get("groups", {}) if isinstance(payload.get("groups"), dict) else {}
        result["summary"] = payload.get("summary", {}) if isinstance(payload.get("summary"), dict) else {}
        return result

    def save(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            current = self.load()
            saved = _default()
            saved.update(payload)
            saved["version"] = AUDIT_VERSION
            saved["contract"] = AUDIT_CONTRACT
            saved["revision"] = int(current.get("revision", 0) or 0) + 1
            saved["updated_at"] = _now()
            raw_groups = payload.get("groups", {}) if isinstance(payload.get("groups"), dict) else {}
            saved["groups"] = {str(group_id): _shared_group(row) for group_id, row in raw_groups.items()}
            saved["summary"] = payload.get("summary", {}) if isinstance(payload.get("summary"), dict) else {}
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

    def for_group(self, group_id: str) -> dict[str, Any]:
        value = self.load().get("groups", {}).get(str(group_id), {})
        return dict(value) if isinstance(value, dict) else {}
