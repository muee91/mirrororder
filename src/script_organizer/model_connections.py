from __future__ import annotations

import json
import os
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Sequence
from urllib.parse import quote, urlparse

from .device_runtime_settings import application_support_root


_LEGACY_EXTERNAL_VISION_PROVIDERS = {"renamerx", "renamerx-local", "renamerx-local-ai"}
DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com"
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
SUPPORTED_PROVIDERS = {
    "gemini",
    "openai-compatible",
    "openai",
    "local",
    "llama",
    "llama.cpp",
    "llama-server",
}


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
    provider = str(row.get("provider", "openai-compatible") or "openai-compatible")[:80]
    # Older development builds stored the reference app as a provider. It is
    # no longer a runtime capability; expose a disabled local slot so the
    # existing device setting can be reselected without a broken URL/model.
    if provider.strip().lower() in _LEGACY_EXTERNAL_VISION_PROVIDERS:
        return {
            "enabled": False,
            "provider": "local",
            "base_url": "",
            "model": "",
            "has_api_key": False,
        }
    return {
        "enabled": bool(row.get("enabled", False)),
        "provider": provider,
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
    if provider not in SUPPORTED_PROVIDERS:
        raise ValueError("当前只支持 Gemini、OpenAI / OpenAI-compatible 或本地兼容接口")
    raw_base_url = str(raw.get("base_url", current.get("base_url", "")) or "").strip()
    if not raw_base_url:
        if provider == "gemini":
            raw_base_url = DEFAULT_GEMINI_BASE_URL
        elif provider == "openai":
            raw_base_url = DEFAULT_OPENAI_BASE_URL
    base_url = _valid_base_url(raw_base_url)
    model = str(raw.get("model", current.get("model", "")) or "").strip()[:300]
    # 声称"本地"却指向远程地址通常是配置笔误：数据不出设备的承诺会被打破。
    if provider in {"local", "llama", "llama.cpp", "llama-server"} and base_url:
        host = urlparse(base_url).hostname or ""
        if host not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError(f"{label}声明为本地模型，但地址指向远程主机 {host}；请改为本机地址或改用 openai-compatible")
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


def resolve_openai_endpoint(base_url: str, suffix: str) -> str:
    """Resolve an OpenAI-compatible endpoint without double-appending /v1."""
    url = str(base_url or "").strip().rstrip("/")
    clean_suffix = "/" + suffix.lstrip("/")
    if url.endswith(clean_suffix):
        return url
    lower = url.lower()
    if lower.endswith(("/v1", "/v1beta", "/v1beta/openai", "/openai")):
        return url + clean_suffix
    return url + "/v1" + clean_suffix


def _extract_gemini_interaction_text(raw: object) -> str:
    if not isinstance(raw, dict):
        return ""
    if isinstance(raw.get("output_text"), str) and raw["output_text"].strip():
        return raw["output_text"]
    texts: list[str] = []
    for key in ("outputs", "steps"):
        items = raw.get(key)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "text" and isinstance(item.get("text"), str):
                texts.append(item["text"])
            content = item.get("content")
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and isinstance(part.get("text"), str):
                        texts.append(part["text"])
            elif isinstance(content, str):
                texts.append(content)
    return "".join(texts).strip()


def gemini_interactions_request(
    *,
    base_url: str,
    api_key: str,
    model: str,
    system_instruction: str,
    input_payload: str | list[dict[str, Any]],
    timeout_seconds: int = 60,
) -> str | None:
    """Invoke the official Gemini Interactions REST API (v1beta/v1)."""
    root = (str(base_url or "").strip().rstrip("/") or DEFAULT_GEMINI_BASE_URL)
    if root.endswith("/interactions"):
        url = root
    elif root.endswith(("/v1", "/v1beta")):
        url = root + "/interactions"
    else:
        url = root + "/v1beta/interactions"
    payload: dict[str, Any] = {
        "model": model.removeprefix("models/"),
        "input": input_payload,
        "store": False,
    }
    if system_instruction:
        payload["system_instruction"] = system_instruction
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if api_key:
        headers["x-goog-api-key"] = api_key
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            raw = json.loads(response.read().decode("utf-8"))
        text = _extract_gemini_interaction_text(raw)
        return text or None
    except (OSError, urllib.error.URLError, urllib.error.HTTPError, UnicodeDecodeError, ValueError, TypeError):
        return None


def gemini_embed_texts(
    *,
    base_url: str,
    api_key: str,
    model: str,
    texts: Sequence[str],
    timeout_seconds: int = 30,
) -> list[list[float]] | None:
    """Call native Gemini embedContent per text so gemini-embedding-2 returns distinct vectors."""
    root = (str(base_url or "").strip().rstrip("/") or DEFAULT_GEMINI_BASE_URL)
    clean_model = model.removeprefix("models/")
    if root.endswith(("/v1", "/v1beta")):
        url = f"{root}/models/{quote(clean_model, safe='')}:embedContent"
    else:
        url = f"{root}/v1beta/models/{quote(clean_model, safe='')}:embedContent"
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if api_key:
        headers["x-goog-api-key"] = api_key
    vectors: list[list[float]] = []
    for text in texts:
        payload = {
            "model": f"models/{clean_model}",
            "content": {"parts": [{"text": text}]},
        }
        request = urllib.request.Request(
            url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers=headers,
        )
        with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
            raw = json.loads(response.read().decode("utf-8"))
        embedding = raw.get("embedding", {}) if isinstance(raw, dict) else {}
        values = embedding.get("values", []) if isinstance(embedding, dict) else []
        if not isinstance(values, list) or not values:
            raise ValueError("gemini embedding response missing values")
        vectors.append([float(v) for v in values])
    return vectors


def test_model_connection(raw: object) -> dict[str, Any]:
    """Verify reachability and auth of a model provider without leaking secrets."""
    if not isinstance(raw, dict):
        raise ValueError("测试参数必须是对象")
    role = str(raw.get("role", "text") or "text").strip().lower()
    if role not in {"text", "vision", "embedding"}:
        raise ValueError("role 必须是 text、vision 或 embedding")
    saved = load_model_connections(include_secrets=True).get(role, {})
    provider = str(raw.get("provider", saved.get("provider", "openai-compatible")) or "openai-compatible").strip().lower()
    if provider not in SUPPORTED_PROVIDERS:
        raise ValueError("不支持的模型提供方")
    raw_base = str(raw.get("base_url", saved.get("base_url", "")) or "").strip()
    if not raw_base:
        raw_base = DEFAULT_GEMINI_BASE_URL if provider == "gemini" else DEFAULT_OPENAI_BASE_URL if provider == "openai" else ""
    base_url = _valid_base_url(raw_base)
    model = str(raw.get("model", saved.get("model", "")) or "").strip()[:300]
    if not base_url:
        raise ValueError("请先填写模型服务地址")
    if provider in {"local", "llama", "llama.cpp", "llama-server"}:
        host = urlparse(base_url).hostname or ""
        if host not in {"127.0.0.1", "localhost", "::1"}:
            raise ValueError(f"本地模型地址指向远程主机 {host}，已拒绝外连测试")
    api_key = str(raw.get("api_key", "") or "").strip() or str(saved.get("api_key", "") or "").strip()
    headers = {"Accept": "application/json"}
    if provider == "gemini":
        clean_model = model.removeprefix("models/")
        root = base_url.rstrip("/")
        prefix = root if root.endswith(("/v1", "/v1beta")) else root + "/v1beta"
        url = f"{prefix}/models/{quote(clean_model, safe='')}" if clean_model else f"{prefix}/models"
        if api_key:
            headers["x-goog-api-key"] = api_key
    else:
        url = resolve_openai_endpoint(base_url, "/models")
        if api_key:
            headers["Authorization"] = "Bearer " + api_key

    started = time.monotonic()
    req = urllib.request.Request(url, method="GET", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            status_code = int(getattr(resp, "status", 200) or 200)
            resp.read(4096)
        latency_ms = max(1, int((time.monotonic() - started) * 1000))
        return {
            "ok": True,
            "role": role,
            "provider": provider,
            "model": model,
            "status_code": status_code,
            "latency_ms": latency_ms,
            "detail": f"已连通（{latency_ms} ms）",
        }
    except urllib.error.HTTPError as error:
        latency_ms = max(1, int((time.monotonic() - started) * 1000))
        hint = "鉴权失败，请检查 API Key" if error.code in {401, 403} else f"服务返回 HTTP {error.code}"
        if error.code == 404 and model:
            hint = f"未找到模型 {model}（HTTP 404），请确认模型名称"
        return {
            "ok": False,
            "role": role,
            "provider": provider,
            "model": model,
            "status_code": int(error.code),
            "latency_ms": latency_ms,
            "detail": hint,
        }
    except (OSError, urllib.error.URLError, ValueError) as error:
        latency_ms = max(1, int((time.monotonic() - started) * 1000))
        return {
            "ok": False,
            "role": role,
            "provider": provider,
            "model": model,
            "status_code": 0,
            "latency_ms": latency_ms,
            "detail": f"无法连接服务：{str(error)[:240]}",
        }
