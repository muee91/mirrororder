from __future__ import annotations

import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from threading import RLock
from typing import Any


ASSISTANT_CONTRACT = "assistant.v1"
ASSISTANT_VERSION = 1

_DEVICE_PATH = re.compile(
    r"""(?ix)(?:file://|(?<![a-z0-9_])[a-z]:[\\/]|\\\\|"""
    r"""(?<![a-z0-9_/])/(?:Users|Volumes|private|var|tmp|home|mnt|media)(?:/|(?=\W|$))|"""
    r"""(?<![\w/])/(?!/|api/agent/v1/projects/)(?=[\w.]))[^\s"'<>\x60，。；！？、）】]*"""
)
_SECRET_TEXT = re.compile(
    r"""(?ix)(?<![a-z0-9_])(?:sk-[a-z0-9_-]{6,}|AIza[a-z0-9_-]{10,}|Bearer\s+[a-z0-9_.+/=-]+)|"""
    r"""(?<![a-z0-9_])(?:api[-_ ]?key|password|client[-_ ]?secret|secret|(?:access[-_ ]?)?token)["']?\s*[:=]\s*"""
    r"""(?:"[^"]*"|'[^']*'|[^\s,;}，。；！？]+)"""
)
_PRIVATE_FIELDS = {
    "apikey", "authorization", "password", "secret", "clientsecret", "token", "accesstoken",
    "refreshtoken", "baseurl", "runtime", "models", "modelinfo",
}
_EVIDENCE_FIELDS = ("document_id", "group_id", "clip_id", "media_id", "source", "source_label", "start", "end", "snippet")
_EVIDENCE_METADATA = (
    "file_name", "record_id", "time_basis", "camera", "shot_type", "shot_type_label",
    "take_label", "slate_status", "segment_id",
)
_DIAGNOSIS_DESTINATIONS = {"sync-task", "media-binding", "sync-delivery"}
_SUGGESTED_ACTIONS = {"submit_task", "open_settings", "open_status"}
_SUGGESTED_TASKS = {"transcribe", "evidence_extract", "semantic_index", "audit"}
_SLASHED_TEXT = re.compile(r"[^\s，。；！？、]*[/\\][^\s，。；！？、]*")


def _basename(value: object) -> str:
    return PurePosixPath(str(value or "").replace("\\", "/")).name


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

    def __init__(self, output_dir: str | Path, *, secrets: tuple[str, ...] = ()):
        self.path = Path(output_dir) / "assistant.json"
        self._secrets = tuple(sorted(filter(None, set(secrets)), key=len, reverse=True))

    def sanitize(self, value: Any) -> Any:
        if isinstance(value, str):
            for secret in self._secrets:
                value = value.replace(secret, "[已隐藏]")
            return _SECRET_TEXT.sub("[已隐藏]", _DEVICE_PATH.sub("[路径已隐藏]", value))
        if isinstance(value, dict):
            return {
                key: self.sanitize(
                    _basename(item) if key == "file_name" else item
                )
                for key, item in value.items()
                if isinstance(key, str)
                and re.sub(r"[^a-z0-9]", "", key.casefold()) not in _PRIVATE_FIELDS
                and self.sanitize(key) == key
            }
        if isinstance(value, (list, tuple)):
            return [self.sanitize(item) for item in value]
        if value is None or isinstance(value, (bool, int, float)):
            return value
        return self.sanitize(str(value))

    def sanitize_diagnosis(self, value: object) -> dict[str, str]:
        if not isinstance(value, dict):
            return {}
        summary = self.sanitize(str(value.get("summary") or ""))
        summary = _SLASHED_TEXT.sub("[路径已隐藏]", summary).strip()
        destination = value.get("destination")
        result = {"summary": summary[:1000]} if summary else {}
        if isinstance(destination, str) and destination in _DIAGNOSIS_DESTINATIONS:
            result["destination"] = destination
        return result

    def evidence_metadata(self, value: object) -> dict[str, Any]:
        if not isinstance(value, dict):
            return {}
        clean = {}
        for key in _EVIDENCE_METADATA:
            item = value.get(key)
            if isinstance(item, str):
                item = self.sanitize(_basename(item) if key == "file_name" else item)
                if item and "/" not in item and "\\" not in item:
                    clean[key] = item[:320]
            elif isinstance(item, (int, float)) and key != "file_name":
                clean[key] = item
        return clean

    def sanitize_actions(self, value: object) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        clean = []
        for raw in value[:12]:
            if not isinstance(raw, dict):
                continue
            action = raw.get("action")
            if not isinstance(action, str) or action not in _SUGGESTED_ACTIONS:
                continue
            row = {"action": action}
            if action == "submit_task":
                task_type = raw.get("task_type")
                if not isinstance(task_type, str) or task_type not in _SUGGESTED_TASKS:
                    continue
                row["task_type"] = task_type
                targets = raw.get("targets")
                ids = targets.get("group_ids") if isinstance(targets, dict) else None
                group_ids = list(dict.fromkeys(
                    item for item in ids
                    if isinstance(item, str) and item.strip() and len(item) <= 180
                    and "/" not in item and "\\" not in item and self.sanitize(item) == item
                ))[:12] if isinstance(ids, list) else []
                row["targets"] = {"group_ids": group_ids} if group_ids else {}
            for key, limit in (("label", 120), ("description", 500)):
                if isinstance(raw.get(key), str):
                    row[key] = _SLASHED_TEXT.sub("[路径已隐藏]", self.sanitize(raw[key]))[:limit]
            if row.get("label"):
                clean.append(row)
        return clean

    def _evidence_rows(self, value: object) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        rows = []
        for raw in value:
            if not isinstance(raw, dict):
                continue
            row = self.sanitize({
                key: raw[key] for key in _EVIDENCE_FIELDS if isinstance(raw.get(key), (str, int, float))
            })
            if "snippet" in row:
                row["snippet"] = _SLASHED_TEXT.sub("[路径已隐藏]", str(row["snippet"]))[:320]
            metadata = self.evidence_metadata(raw.get("metadata"))
            if metadata:
                row["metadata"] = metadata
            if row:
                rows.append(row)
            if len(rows) == 6:
                break
        return rows

    def _sanitize_payload(self, payload: dict[str, Any]) -> dict[str, Any]:
        clean = self.sanitize({key: value for key, value in payload.items() if key != "messages"})
        clean["messages"] = []
        for raw in payload["messages"]:
            if not isinstance(raw, dict):
                continue
            message = self.sanitize({
                key: value for key, value in raw.items() if key not in {"evidence", "diagnosis", "suggested_actions"}
            })
            evidence = self._evidence_rows(raw.get("evidence"))
            if evidence:
                message["evidence"] = evidence
            diagnosis = self.sanitize_diagnosis(raw.get("diagnosis"))
            if diagnosis:
                message["diagnosis"] = diagnosis
            if message.get("role") == "assistant" and "suggested_actions" in raw:
                message["suggested_actions"] = self.sanitize_actions(raw["suggested_actions"])
            clean["messages"].append(message)
        return clean

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
        orchestration = raw.get("orchestration", {}) if isinstance(raw.get("orchestration"), dict) else {}
        # Model runtime status may contain device-local cache/runtime paths.
        # It belongs in localhost/device status responses, never in the shared
        # assistant artifact. Drop the legacy field on read so an old artifact
        # is also scrubbed the next time it is saved.
        orchestration = dict(orchestration)
        orchestration.pop("models", None)
        payload["orchestration"] = orchestration
        return self._sanitize_payload(payload)

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
            messages = payload.get("messages", current.get("messages", []))
            saved["messages"] = messages[-40:] if isinstance(messages, list) else []
            orchestration = payload.get("orchestration", {}) if isinstance(payload.get("orchestration"), dict) else {}
            orchestration = dict(orchestration)
            orchestration.pop("models", None)
            saved["orchestration"] = orchestration
            saved = self._sanitize_payload(saved)
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

    def conversation_history(self) -> list[dict[str, str]]:
        history = []
        for message in self.load()["messages"][-6:]:
            if not isinstance(message, dict) or message.get("role") not in ("user", "assistant"):
                continue
            context = message.get("context")
            history.append({
                "role": message["role"],
                "text": str(message.get("text", ""))[:500],
                "context_label": str(context.get("label", ""))[:120] if isinstance(context, dict) else "",
            })
        return history

    def append_message(
        self,
        role: str,
        text: str,
        *,
        source: str = "assistant",
        context: dict | None = None,
        evidence: list[dict[str, Any]] | None = None,
        diagnosis: dict[str, str] | None = None,
        answer_mode: str = "",
        suggested_actions: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            payload = self.load()
            messages = list(payload.get("messages", []))
            messages.append({
                "role": "user" if role == "user" else "assistant",
                "text": self.sanitize(str(text or ""))[:4000],
                "source": self.sanitize(str(source or "assistant"))[:80],
                "created_at": _now(),
                **({"context": context} if context else {}),
                **({"evidence": evidence[:6]} if evidence else {}),
                **({"diagnosis": diagnosis} if diagnosis else {}),
                **({"answer_mode": answer_mode} if answer_mode else {}),
                **({"suggested_actions": suggested_actions} if suggested_actions is not None else {}),
            })
            payload["messages"] = messages
            return self.save(payload)

    def clear_messages(self) -> dict[str, Any]:
        with self._lock:
            payload = self.load()
            payload["messages"] = []
            return self.save(payload)
