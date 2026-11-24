"""统一的多模态文本 / 图文底层客户端。

后端原本在六处各自拼接 OpenAI ``/chat/completions`` 或 Gemini Interactions
请求，并各自吞掉异常。本模块收敛协议适配：所有调用方只提供配置、系统指令、
上下文与（可选的）图片，由这里负责路由、请求、错误码归一化和脱敏。

设计约束：

- 绝不把 API Key、Authorization 头或设备绝对路径写进返回值、日志或提案；
- 本地 llama-server 只在确认模型已下载后启动，请求路径绝不静默触发 GB 级下载；
- 错误以结构化 ``CompletionResult`` 返回，调用方决定降级还是显式报错；
- 只使用标准库 ``urllib.request``，与现有 monkeypatch 测试方式保持一致。
"""
from __future__ import annotations

import base64
import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from http.client import HTTPException
from typing import Any, Iterator, Sequence

from .model_connections import (
    DEFAULT_GEMINI_BASE_URL,
    _extract_gemini_interaction_text,
    resolve_openai_endpoint,
)

LOCAL_PROVIDERS = frozenset({"local", "local-vision", "llama", "llama.cpp", "llama-server"})
GEMINI_PROVIDERS = frozenset({"gemini"})

# 与 clapperboard_ocr 的路径清洗规则一致：提案绝不能携带设备绝对路径。
_PATH_RE = re.compile(
    r"(?:(?:[A-Za-z]:[\\/])|/(?:Users|Volumes|home|private|tmp|var)/)[^\s，。；：、\"'<>]+"
)
_AUTH_RE = re.compile(
    r"(?i)(authorization\s*[:=]\s*bearer\s+|x-goog-api-key\s*[:=]\s+|bearer\s+|(?:[?&](?:key|api_key|token)=))[^\s,;&\"']+"
)

_FENCE_RE = re.compile(r"\A\s*(`{3,}|~{3,})[^\n]*\n(?P<body>.*?)\1\s*\Z", re.DOTALL)


@dataclass(frozen=True)
class MultimodalConfig:
    """一个后端调用方交给统一客户端的最小连接配置。"""

    provider: str = "none"
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    timeout_seconds: int = 60

    @property
    def is_local(self) -> bool:
        return str(self.provider or "").strip().lower() in LOCAL_PROVIDERS

    @property
    def is_gemini(self) -> bool:
        return str(self.provider or "").strip().lower() in GEMINI_PROVIDERS

    @property
    def enabled(self) -> bool:
        if not self.model or str(self.provider or "").strip().lower() in {"", "none", "off", "disabled"}:
            return False
        return self.is_local or self.is_gemini or bool(self.base_url)


@dataclass(frozen=True)
class CompletionResult:
    """一次统一调用的结构化结果，所有字符串都已完成脱敏。"""

    ok: bool
    text: str = ""
    error_code: str = ""
    error_detail: str = ""
    provider: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "text": self.text,
            "error_code": self.error_code,
            "error_detail": self.error_detail,
            "provider": self.provider,
        }


def strip_markdown_fence(text: object) -> str:
    """去掉 ```` ```json ... ``` ```` / `~~~` 围栏，保留内部正文。"""
    value = str(text or "").strip()
    match = _FENCE_RE.match(value)
    if match:
        return match.group("body").strip()
    if value.startswith("```") and value.endswith("```") and len(value) >= 6:
        value = value[3:-3].strip()
        if value[:4].lower() == "json":
            value = value[4:].strip()
    return value.strip()


def _iter_balanced(text: str, opener: str, closer: str) -> Iterator[str]:
    """按深度配对的括号提取候选片段，忽略字符串字面量内的括号。"""
    depth = 0
    start = -1
    in_string = False
    escaped = False
    for index, char in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == opener:
            if depth == 0:
                start = index
            depth += 1
        elif char == closer and depth > 0:
            depth -= 1
            if depth == 0 and start >= 0:
                yield text[start : index + 1]
                start = -1


def parse_json_object(text: object) -> dict[str, Any] | None:
    """从可能带围栏或包围文字的模型输出中安全解析一个 JSON 对象。"""
    value = strip_markdown_fence(text)
    for candidate in (value, *_iter_balanced(value, "{", "}")):
        try:
            parsed = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def parse_json_array(text: object) -> list[Any] | None:
    """从可能带围栏或包围文字的模型输出中安全解析一个 JSON 数组。"""
    value = strip_markdown_fence(text)
    for candidate in (value, *_iter_balanced(value, "[", "]")):
        try:
            parsed = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        if isinstance(parsed, list):
            return parsed
    return None


def parse_json_value(text: object) -> Any | None:
    """尽量解析完整 JSON；失败时按出现顺序解析最外层配对片段。"""
    value = strip_markdown_fence(text)
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        pass
    candidates: list[tuple[int, str]] = []
    for opener, closer in (("{", "}"), ("[", "]")):
        for candidate in _iter_balanced(value, opener, closer):
            position = value.find(candidate)
            if position >= 0:
                candidates.append((position, candidate))
    for _, candidate in sorted(candidates):
        try:
            return json.loads(candidate)
        except (ValueError, TypeError):
            continue
    return None


def _scrub_detail(detail: object, secrets: Sequence[str] = ()) -> str:
    """移除密钥、鉴权头和设备绝对路径，错误详情才允许离开本模块。"""
    text = str(detail or "")
    for secret in secrets:
        key = str(secret or "").strip()
        if key:
            text = text.replace(key, "[REDACTED]")
    text = _AUTH_RE.sub(r"\1[REDACTED]", text)
    text = _PATH_RE.sub("[PATH]", text)
    return text[:300]


def _classify_error(error: BaseException) -> str:
    if isinstance(error, urllib.error.HTTPError):
        code = error.code
        if type(code) is int and 100 <= code <= 599:
            return f"http_{code}"
        return "network_error"
    if isinstance(error, TimeoutError):
        return "timeout"
    if isinstance(error, urllib.error.URLError):
        return "timeout" if isinstance(error.reason, TimeoutError) else "network_error"
    if isinstance(error, (OSError, HTTPException)):
        return "network_error"
    if isinstance(error, (ValueError, TypeError)):
        return "invalid_json"
    if isinstance(error, (KeyError, IndexError)):
        return "empty_response"
    return "network_error"


def _error_detail(code: str, error: BaseException | None, secrets: Sequence[str]) -> str:
    if code.startswith("http_"):
        status = code[5:]
        if status in {"401", "403"}:
            return f"鉴权失败（HTTP {status}），请检查 API Key"
        if status == "404":
            return "请求地址或模型不存在（HTTP 404），请确认模型名与服务地址"
        if status == "429":
            return "请求被限流（HTTP 429），请稍后重试"
        return f"服务返回 HTTP {status}"
    if code == "timeout":
        return "请求超时，请稍后重试"
    if code == "invalid_json":
        return "服务返回内容不是有效 JSON"
    if code == "empty_response":
        return "服务返回内容为空"
    if code == "local_model_not_downloaded":
        return "本地视觉模型尚未下载，请先在设置中准备本地视觉模型，或切换为 Gemini / OpenAI"
    if code == "local_server_unavailable":
        return "本地视觉模型服务未就绪，请先在设置中启用并启动本地视觉模型"
    return f"无法连接服务：{_scrub_detail(error, secrets)}"


def _local_base_url(model: str) -> tuple[str, CompletionResult | None]:
    """解析本地 llama-server 地址；延迟导入以兼容现有 monkeypatch。"""
    from .local_vision_runtime import LocalVisionRuntime, LocalVisionRuntimeConfig

    try:
        runtime = LocalVisionRuntime(LocalVisionRuntimeConfig.from_env(model))
        if not runtime.model_downloaded():
            # 请求路径只拒绝本次推理，不调用 ensure_server()，避免静默 GB 级下载。
            return "", CompletionResult(
                ok=False,
                error_code="local_model_not_downloaded",
                error_detail=_error_detail("local_model_not_downloaded", None, ()),
            )
        base_url = str(runtime.ensure_server() or "").strip().rstrip("/")
    except Exception:
        return "", CompletionResult(
            ok=False,
            error_code="local_server_unavailable",
            error_detail=_error_detail("local_server_unavailable", None, ()),
        )
    if not base_url:
        return "", CompletionResult(
            ok=False,
            error_code="local_server_unavailable",
            error_detail=_error_detail("local_server_unavailable", None, ()),
        )
    return base_url, None


def _context_text(context: object) -> str:
    if isinstance(context, str):
        return context
    try:
        return json.dumps(context, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(context or "")[:2000]


def _image_parts(
    images: Sequence[tuple[bytes, str] | tuple[bytes, str, str]] | None,
) -> list[tuple[bytes, str, str]]:
    parts: list[tuple[bytes, str, str]] = []
    for image in images or []:
        if not isinstance(image, (list, tuple)) or len(image) not in {2, 3}:
            continue
        data = image[0]
        mime = image[1]
        caption = str(image[2] or "").strip() if len(image) == 3 else ""
        if not isinstance(data, (bytes, bytearray)) or not data:
            continue
        parts.append((bytes(data), str(mime or "image/jpeg"), caption))
    return parts


def call_multimodal(
    config: MultimodalConfig,
    *,
    system: str,
    context: object,
    images: Sequence[tuple[bytes, str] | tuple[bytes, str, str]] | None = None,
    temperature: float = 0.0,
) -> CompletionResult:
    """执行一次文本或图文调用；网络/解析错误都返回结构化结果而不抛出。"""
    if not config.enabled:
        return CompletionResult(
            ok=False,
            error_code="unconfigured",
            error_detail="模型未配置或已停用",
            provider=config.provider,
        )

    prompt = _context_text(context)
    pictures = _image_parts(images)
    secrets = (str(config.api_key or ""),)
    explicit_base = str(config.base_url or "").strip().rstrip("/")

    if config.is_local:
        if explicit_base:
            base_url = explicit_base
        else:
            base_url, failure = _local_base_url(config.model)
            if failure is not None:
                return CompletionResult(
                    ok=False,
                    error_code=failure.error_code,
                    error_detail=failure.error_detail,
                    provider=config.provider,
                )
    elif config.is_gemini:
        base_url = explicit_base or DEFAULT_GEMINI_BASE_URL
    else:
        base_url = explicit_base

    if config.is_gemini:
        url = base_url
        if url.endswith("/interactions"):
            pass
        elif url.endswith(("/v1", "/v1beta")):
            url += "/interactions"
        else:
            url += "/v1beta/interactions"
        parts: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
        for data, mime, caption in pictures:
            if caption:
                parts.append({"type": "text", "text": caption})
            parts.append(
                {
                    "type": "image",
                    "data": base64.b64encode(data).decode("ascii"),
                    "mime_type": mime,
                }
            )
        payload: dict[str, Any] = {
            "model": config.model.removeprefix("models/"),
            "input": parts,
            "store": False,
        }
        if system:
            payload["system_instruction"] = system
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if config.api_key:
            headers["x-goog-api-key"] = config.api_key
        extract = _extract_gemini_interaction_text
    else:
        url = resolve_openai_endpoint(base_url, "/chat/completions")
        content: str | list[dict[str, Any]]
        if pictures:
            items: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
            for data, mime, caption in pictures:
                if caption:
                    items.append({"type": "text", "text": caption})
                items.append(
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
                        },
                    }
                )
            content = items
        else:
            content = prompt
        payload = {
            "model": config.model,
            "temperature": max(0.0, min(1.0, float(temperature or 0.0))),
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": content},
            ],
        }
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if config.api_key:
            headers["Authorization"] = "Bearer " + config.api_key

        def extract(raw: object) -> str:
            if not isinstance(raw, dict):
                return ""
            try:
                content_value = raw["choices"][0]["message"]["content"]
            except (KeyError, IndexError, TypeError):
                return ""
            if isinstance(content_value, list):
                return "".join(
                    str(item.get("text", ""))
                    for item in content_value
                    if isinstance(item, dict)
                )
            return str(content_value or "")

    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        method="POST",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=config.timeout_seconds) as response:
            raw = json.loads(response.read().decode("utf-8"))
        text = extract(raw).strip()
    except Exception as error:  # 分类交给 _classify_error，不允许任何原始异常外泄
        code = _classify_error(error)
        return CompletionResult(
            ok=False,
            error_code=code,
            error_detail=_error_detail(code, error, secrets),
            provider=config.provider,
        )
    if not text:
        return CompletionResult(
            ok=False,
            error_code="empty_response",
            error_detail=_error_detail("empty_response", None, secrets),
            provider=config.provider,
        )
    return CompletionResult(ok=True, text=text, provider=config.provider)


__all__ = [
    "LOCAL_PROVIDERS",
    "CompletionResult",
    "MultimodalConfig",
    "call_multimodal",
    "parse_json_array",
    "parse_json_object",
    "parse_json_value",
    "strip_markdown_fence",
]
