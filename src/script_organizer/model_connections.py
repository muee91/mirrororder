from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .device_runtime_settings import application_support_root


def _connections_path() -> Path:
    return application_support_root() / "model-connections.json"


def _secrets_path() -> Path:
    return application_support_root() / "model-secrets.json"


def _read(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _atomic(path: Path, payload: dict[str, Any], *, secret: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        if secret:
            try:
                os.fchmod(fd, 0o600)
            except OSError:
                pass
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        if secret:
            try:
                os.chmod(path, 0o600)
            except OSError:
                pass
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _valid_base_url(value: str) -> str:
    raw = str(value or "").strip().rstrip("/")
    if not raw:
        return ""
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("模型地址必须是 http:// 或 https:// URL")
    return raw[:1000]


def load_model_connections(*, include_secrets: bool = False) -> dict[str, Any]:
    raw = _read(_connections_path())
    text = raw.get("text", {}) if isinstance(raw.get("text"), dict) else {}
    secrets = _read(_secrets_path()) if include_secrets else {}
    payload = {
        "version": 1,
        "text": {
            "enabled": bool(text.get("enabled", False)),
            "provider": str(text.get("provider", "openai-compatible") or "openai-compatible")[:80],
            "base_url": str(text.get("base_url", "") or "")[:1000],
            "model": str(text.get("model", "") or "")[:300],
            "has_api_key": bool(_read(_secrets_path()).get("text_api_key")),
        },
    }
    if include_secrets:
        payload["text"]["api_key"] = str(secrets.get("text_api_key", "") or "")
    return payload


def save_model_connections(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("模型连接设置必须是对象")
    current = load_model_connections(include_secrets=True)
    text_raw = raw.get("text", {}) if isinstance(raw.get("text"), dict) else {}
    current_text = current["text"]
    enabled = bool(text_raw.get("enabled", current_text.get("enabled", False)))
    provider = str(text_raw.get("provider", current_text.get("provider", "openai-compatible")) or "openai-compatible").strip().lower()
    if provider not in {"openai-compatible", "openai", "local", "llama", "llama.cpp", "llama-server"}:
        raise ValueError("当前只支持 OpenAI-compatible 或本地 llama 兼容接口")
    base_url = _valid_base_url(str(text_raw.get("base_url", current_text.get("base_url", "")) or ""))
    model = str(text_raw.get("model", current_text.get("model", "")) or "").strip()[:300]
    if enabled and (not base_url or not model):
        raise ValueError("启用语言模型需要模型地址和模型名")
    public = {
        "version": 1,
        "text": {
            "enabled": enabled,
            "provider": provider,
            "base_url": base_url,
            "model": model,
        },
    }
    _atomic(_connections_path(), public)
    secrets = _read(_secrets_path())
    if "api_key" in text_raw:
        key = str(text_raw.get("api_key", "") or "").strip()
        if key:
            secrets["text_api_key"] = key
        else:
            secrets.pop("text_api_key", None)
    _atomic(_secrets_path(), secrets, secret=True)
    return load_model_connections(include_secrets=False)
