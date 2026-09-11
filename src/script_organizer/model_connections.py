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


def _public_connection(raw: object, *, key_name: str) -> dict[str, Any]:
    row = raw if isinstance(raw, dict) else {}
    return {
        "enabled": bool(row.get("enabled", False)),
        "provider": str(row.get("provider", "openai-compatible") or "openai-compatible")[:80],
        "base_url": str(row.get("base_url", "") or "")[:1000],
        "model": str(row.get("model", "") or "")[:300],
        "has_api_key": bool(_read(_secrets_path()).get(key_name)),
    }


def load_model_connections(*, include_secrets: bool = False) -> dict[str, Any]:
    raw = _read(_connections_path())
    secrets = _read(_secrets_path()) if include_secrets else {}
    payload = {
        "version": 3,
        "text": _public_connection(raw.get("text", {}), key_name="text_api_key"),
        "vision": _public_connection(raw.get("vision", {}), key_name="vision_api_key"),
        "embedding": _public_connection(raw.get("embedding", {}), key_name="embedding_api_key"),
    }
    if include_secrets:
        payload["text"]["api_key"] = str(secrets.get("text_api_key", "") or "")
        payload["vision"]["api_key"] = str(secrets.get("vision_api_key", "") or "")
        payload["embedding"]["api_key"] = str(secrets.get("embedding_api_key", "") or "")
    return payload


def _normalize_connection(
    raw: dict[str, Any],
    current: dict[str, Any],
    *,
    label: str,
) -> dict[str, Any]:
    enabled = bool(raw.get("enabled", current.get("enabled", False)))
    provider = str(raw.get("provider", current.get("provider", "openai-compatible")) or "openai-compatible").strip().lower()
    if provider not in {"openai-compatible", "openai", "local", "llama", "llama.cpp", "llama-server"}:
        raise ValueError("当前只支持 OpenAI-compatible 或本地兼容接口")
    base_url = _valid_base_url(str(raw.get("base_url", current.get("base_url", "")) or ""))
    # 声称"本地"却指向远程地址通常是配置笔误：数据不出设备的承诺会被打破。
    if provider in {"local", "llama", "llama.cpp", "llama-server"} and base_url:
        host = urlparse(base_url).hostname or ""
        if host not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError(f"{label}声明为本地模型，但地址指向远程主机 {host}；请改为本机地址或改用 openai-compatible")
    model = str(raw.get("model", current.get("model", "")) or "").strip()[:300]
    if enabled and (not base_url or not model):
        raise ValueError(f"启用{label}需要模型地址和模型名")
    return {
        "enabled": enabled,
        "provider": provider,
        "base_url": base_url,
        "model": model,
    }


def save_model_connections(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("模型连接设置必须是对象")
    current = load_model_connections(include_secrets=True)
    text_raw = raw.get("text", {}) if isinstance(raw.get("text"), dict) else {}
    vision_raw = raw.get("vision", {}) if isinstance(raw.get("vision"), dict) else {}
    embedding_raw = raw.get("embedding", {}) if isinstance(raw.get("embedding"), dict) else {}
    text = _normalize_connection(text_raw, current["text"], label="语言模型")
    vision = _normalize_connection(vision_raw, current["vision"], label="多模态模型")
    embedding = _normalize_connection(embedding_raw, current["embedding"], label="语义检索模型")
    public = {"version": 3, "text": text, "vision": vision, "embedding": embedding}
    _atomic(_connections_path(), public)

    secrets = _read(_secrets_path())
    for row, key_name in (
        (text_raw, "text_api_key"),
        (vision_raw, "vision_api_key"),
        (embedding_raw, "embedding_api_key"),
    ):
        if "api_key" not in row:
            continue
        key = str(row.get("api_key", "") or "").strip()
        if key:
            secrets[key_name] = key
        else:
            secrets.pop(key_name, None)
    _atomic(_secrets_path(), secrets, secret=True)
    return load_model_connections(include_secrets=False)
