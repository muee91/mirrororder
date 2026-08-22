from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .local_vision_runtime import DEFAULT_LOCAL_VISION_MODEL


def application_support_root() -> Path:
    override = os.environ.get("MIRRORORDER_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / "Library" / "Application Support" / "MirrorOrder"


def settings_path() -> Path:
    return application_support_root() / "runtime-settings.json"


def _default() -> dict[str, Any]:
    return {
        "version": 1,
        "local_vision_enabled": False,
        "local_vision_model": DEFAULT_LOCAL_VISION_MODEL,
    }


def load_runtime_settings() -> dict[str, Any]:
    payload = _default()
    try:
        raw = json.loads(settings_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return payload
    if isinstance(raw, dict):
        payload["local_vision_enabled"] = bool(raw.get("local_vision_enabled", payload["local_vision_enabled"]))
        model = str(raw.get("local_vision_model", "") or "").strip()
        if model:
            payload["local_vision_model"] = model[:300]
    return payload


def save_runtime_settings(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("本机运行时设置必须是对象")
    payload = load_runtime_settings()
    if "local_vision_enabled" in raw:
        payload["local_vision_enabled"] = bool(raw["local_vision_enabled"])
    if "local_vision_model" in raw:
        model = str(raw.get("local_vision_model", "") or "").strip()
        if not model:
            raise ValueError("本地视觉模型不能为空")
        payload["local_vision_model"] = model[:300]
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return payload
