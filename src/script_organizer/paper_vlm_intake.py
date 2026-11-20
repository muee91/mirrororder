"""手写纸质场记照片的 VLM 结构化候选提取。

本模块只产出「候选」(evidence/proposal)：输出永远 ``authority=False``，
不得写入任何项目事实。图片数据只在调用模型时使用，绝不回写到返回值。
"""
from __future__ import annotations

import base64
import binascii
import json
import math
import re
import urllib.error
import urllib.request
from typing import Any

from .model_connections import gemini_interactions_request, resolve_openai_endpoint
from .vision_provider import VisionProviderConfig


CONTRACT_VERSION = "paper_vlm_candidates.v1"
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_BASE64_CHARS = (MAX_IMAGE_BYTES * 4) // 3 + 16
MAX_CANDIDATE_ROWS = 200

_IMAGE_MIMES = {"image/jpeg", "image/png", "image/webp"}
_STATUS_VALUES = {"usable", "partial", "ng", "unmarked"}
_STATUS_ALIASES = {
    "usable": "usable",
    "ok": "usable",
    "pass": "usable",
    "good": "usable",
    "yes": "usable",
    "可用": "usable",
    "通过": "usable",
    "良": "usable",
    "✓": "usable",
    "√": "usable",
    "partial": "partial",
    "part": "partial",
    "maybe": "partial",
    "存疑": "partial",
    "部分": "partial",
    "待定": "partial",
    "不清": "partial",
    "?": "partial",
    "ng": "ng",
    "no": "ng",
    "bad": "ng",
    "fail": "ng",
    "reject": "ng",
    "不通过": "ng",
    "废": "ng",
    "重拍": "ng",
    "x": "ng",
    "✗": "ng",
    "×": "ng",
    "unmarked": "unmarked",
    "unknown": "unmarked",
    "none": "unmarked",
    "null": "unmarked",
    "": "unmarked",
    "未标": "unmarked",
    "未标注": "unmarked",
}

_SYSTEM_INSTRUCTION = (
    "你是短剧片场纸质场记照片的结构化提取器。只转录照片上肉眼可见的事实，"
    "不要猜测、不要补造剧本位置。返回严格 JSON 数组，不要 Markdown 代码块，不要解释文字。"
    "每个元素必须包含字段：episode(整数或null)、scene(字符串)、shot(字符串)、take(字符串)、"
    "status(只能是 usable/partial/ng/unmarked 之一，照片未标注用 unmarked)、"
    "note(字符串)、confidence(0 到 1 之间的数字)。"
)


def _detect_image_mime(data: bytes) -> str:
    """Identify the image format strictly from the file header magic bytes."""
    if len(data) >= 3 and data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if len(data) >= 8 and data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return ""


def validate_image_payload(image_b64: str, mime_type: str = "") -> tuple[bytes, str]:
    """Decode and validate a base64 image payload.

    Accepts either raw base64 or a ``data:image/...;base64,`` data URI. The
    returned mime type is always derived from the magic bytes, never trusted
    from the caller. Raises ``ValueError`` on any invalid input.
    """
    if not isinstance(image_b64, str) or not image_b64.strip():
        raise ValueError("图片数据为空")

    raw = image_b64.strip()
    if raw.startswith("data:"):
        header, separator, encoded = raw.partition(",")
        if not separator:
            raise ValueError("data URI 格式无效，缺少逗号分隔符")
        meta = header[len("data:"):]
        pieces = [piece.strip().lower() for piece in meta.split(";")]
        if "base64" not in pieces[1:]:
            raise ValueError("data URI 必须使用 base64 编码")
        raw = encoded.strip()

    raw = "".join(raw.split())
    if not raw:
        raise ValueError("图片数据为空")
    if len(raw) > MAX_BASE64_CHARS:
        raise ValueError("图片超过 8MB 大小上限")
    raw += "=" * (-len(raw) % 4)
    try:
        data = base64.b64decode(raw, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("图片 base64 解码失败") from error
    if not data:
        raise ValueError("图片数据为空")
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("图片超过 8MB 大小上限")

    detected = _detect_image_mime(data)
    if not detected:
        raise ValueError("不支持的图片格式，仅接受 JPEG / PNG / WEBP")
    return data, detected


def _as_text(value: object, limit: int) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False)
    return str(value).strip()[:limit]


def _as_episode(value: object) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        parsed = int(value)
        return parsed if parsed > 0 else None
    match = re.search(r"-?\d+", str(value).strip())
    if not match:
        return None
    parsed = int(match.group())
    return parsed if parsed > 0 else None


def _as_confidence(value: object) -> float:
    if value is None or isinstance(value, bool):
        return 0.0
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(number):
        return 0.0
    return max(0.0, min(1.0, number))


def normalize_candidate_rows(raw_rows: object, page_label: str = "1") -> list[dict[str, Any]]:
    """Clean untrusted VLM output into a bounded, authority-free row list."""
    if not isinstance(raw_rows, (list, tuple)):
        return []
    page = _as_text(page_label, 60) or "1"
    rows: list[dict[str, Any]] = []
    for item in raw_rows:
        if len(rows) >= MAX_CANDIDATE_ROWS:
            break
        if not isinstance(item, dict):
            continue
        raw_status = _as_text(item.get("status"), 40).lower()
        status = _STATUS_ALIASES.get(raw_status, "unmarked")
        if status not in _STATUS_VALUES:
            status = "unmarked"
        rows.append(
            {
                "page": page,
                "row": len(rows) + 1,
                "episode": _as_episode(item.get("episode")),
                "scene": _as_text(item.get("scene"), 120),
                "shot": _as_text(item.get("shot"), 120),
                "take": _as_text(item.get("take"), 60),
                "status": status,
                "note": _as_text(item.get("note"), 600),
                "confidence": _as_confidence(item.get("confidence")),
                "authority": False,
            }
        )
    return rows


def _rows_from_model_text(text: object) -> list:
    """Best-effort extraction of a row list from free-form model text."""
    value = str(text or "").strip()
    if not value:
        return []
    if value.startswith("```"):
        value = value.strip("`")
        if value.lower().startswith("json"):
            value = value[4:]
        value = value.strip()

    parsed: object = None
    try:
        parsed = json.loads(value)
    except (ValueError, TypeError):
        for opener, closer in (("[", "]"), ("{", "}")):
            left = value.find(opener)
            right = value.rfind(closer)
            if left < 0 or right <= left:
                continue
            try:
                parsed = json.loads(value[left : right + 1])
                break
            except (ValueError, TypeError):
                continue

    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, dict):
        for key in ("candidates", "rows", "records", "results", "data", "slates"):
            nested = parsed.get(key)
            if isinstance(nested, list):
                return nested
    return []


def _openai_base_url(config: VisionProviderConfig) -> str:
    base = str(config.base_url or "").strip().rstrip("/")
    if base:
        return base
    if config.is_local:
        # Never trigger a GB-scale model download from an interactive request path.
        try:
            from .local_vision_runtime import LocalVisionRuntime, LocalVisionRuntimeConfig

            runtime = LocalVisionRuntime(LocalVisionRuntimeConfig.from_env(config.model))
            if not runtime.model_downloaded():
                raise ValueError("本地视觉模型尚未下载，请先在设置中准备本地视觉模型，或切换为 Gemini / OpenAI")
            base = str(runtime.ensure_server() or "").strip().rstrip("/")
        except ValueError:
            raise
        except Exception:
            base = ""
    if not base:
        raise ValueError("本地视觉模型服务未就绪，请先在设置中启用并启动本地视觉模型")
    return base


def extract_paper_slate_photo_candidates(
    body: object,
    *,
    config: VisionProviderConfig | None = None,
) -> dict[str, Any]:
    """Extract structured slate candidates from a handwritten paper photo.

    Only evidence/proposals are returned; ``authority`` is always False and no
    API key or absolute filesystem path is ever included in the result.
    """
    payload = body if isinstance(body, dict) else {}
    image_b64 = payload.get("image_base64")
    if not isinstance(image_b64, str) or not image_b64.strip():
        raise ValueError("image_base64 为必填项")

    active = config or VisionProviderConfig.from_env()
    if not active.enabled:
        raise ValueError("未启用多模态视觉模型，请先在设置中配置 Gemini / OpenAI 或本地视觉模型")

    image_bytes, mime_type = validate_image_payload(image_b64, str(payload.get("mime_type", "") or ""))
    page = _as_text(payload.get("page_label", payload.get("page", "1")), 60) or "1"
    encoded = base64.b64encode(image_bytes).decode("ascii")
    context = json.dumps({"page": page, "task": "transcribe_handwritten_paper_slate"}, ensure_ascii=False)

    model_text: str | None = None
    if active.provider == "gemini":
        parts: list[dict[str, Any]] = [
            {"type": "text", "text": context},
            {"type": "image", "data": encoded, "mime_type": mime_type},
        ]
        model_text = gemini_interactions_request(
            base_url=active.base_url,
            api_key=active.api_key,
            model=active.model,
            system_instruction=_SYSTEM_INSTRUCTION,
            input_payload=parts,
            timeout_seconds=active.timeout_seconds,
        )
    else:
        url = resolve_openai_endpoint(_openai_base_url(active), "/chat/completions")
        content: list[dict[str, Any]] = [
            {"type": "text", "text": context},
            {"type": "image_url", "image_url": {"url": f"data:{mime_type};base64,{encoded}"}},
        ]
        request_payload: dict[str, Any] = {
            "model": active.model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": _SYSTEM_INSTRUCTION},
                {"role": "user", "content": content},
            ],
        }
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if active.api_key:
            headers["Authorization"] = "Bearer " + active.api_key
        request = urllib.request.Request(
            url,
            data=json.dumps(request_payload, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=active.timeout_seconds) as response:
                raw = json.loads(response.read().decode("utf-8"))
            text = raw["choices"][0]["message"]["content"]
        except (
            OSError,
            urllib.error.URLError,
            urllib.error.HTTPError,
            UnicodeDecodeError,
            ValueError,
            KeyError,
            IndexError,
            TypeError,
        ):
            text = None
        if isinstance(text, list):
            text = "".join(str(item.get("text", "")) for item in text if isinstance(item, dict))
        model_text = None if text is None else str(text)

    candidates = normalize_candidate_rows(_rows_from_model_text(model_text), page)
    warning = ""
    if model_text is None:
        warning = "多模态模型请求失败或超时，请检查 API Key、网络或本地视觉服务后重试。"
    elif not candidates:
        warning = "模型未识别出可解析的场记行，请检查照片清晰度或改用人工转录。"
    return {
        "contract": CONTRACT_VERSION,
        "authority": False,
        "provider": str(active.provider or "none")[:80],
        "model": str(active.model or "")[:300],
        "page": page,
        "candidate_count": len(candidates),
        "candidates": candidates,
        "warning": warning,
    }


__all__ = [
    "CONTRACT_VERSION",
    "MAX_IMAGE_BYTES",
    "extract_paper_slate_photo_candidates",
    "normalize_candidate_rows",
    "validate_image_payload",
]
