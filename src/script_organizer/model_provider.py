from __future__ import annotations

import math
import os
from dataclasses import dataclass
from typing import Any

from .model_connections import (
    DEFAULT_GEMINI_BASE_URL,
    DEFAULT_OPENAI_BASE_URL,
    load_model_connections,
)
from .multimodal_client import MultimodalConfig, call_multimodal, parse_json_object

_MODEL_ENV_NAMES = (
    "MIRRORORDER_MODEL_PROVIDER",
    "MIRRORORDER_MODEL_BASE_URL",
    "MIRRORORDER_MODEL_API_KEY",
    "MIRRORORDER_MODEL_NAME",
)

_RESCUE_SYSTEM = (
    "你是影视素材剧本映射的二审器。只能在输入给出的 candidate_id 中选择，"
    "不能发明新的剧本范围。输出严格 JSON："
    '{"candidate_id":"...","confidence":0.0,"reason":"..."}。'
    "如果证据不足，candidate_id 设为空字符串且 confidence 低于 0.5。"
    "拍摄顺序、人工审核和素材时间关系高于语义猜测。"
)


@dataclass(frozen=True)
class ModelProviderConfig:
    provider: str = "none"
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    timeout_seconds: int = 45
    min_confidence: float = 0.84

    @classmethod
    def from_env(cls) -> "ModelProviderConfig":
        # 显式环境变量优先；只有完全未设置时才回退到设置页保存的 text 连接。
        explicit = any(os.environ.get(name) is not None for name in _MODEL_ENV_NAMES)
        if explicit:
            provider = str(os.environ.get("MIRRORORDER_MODEL_PROVIDER", "none") or "none").strip().lower()
            base_url = str(os.environ.get("MIRRORORDER_MODEL_BASE_URL", "") or "").strip().rstrip("/")
            if not base_url:
                if provider == "gemini":
                    base_url = DEFAULT_GEMINI_BASE_URL
                elif provider == "openai":
                    base_url = DEFAULT_OPENAI_BASE_URL
            api_key = str(os.environ.get("MIRRORORDER_MODEL_API_KEY", "") or "").strip()
            model = str(os.environ.get("MIRRORORDER_MODEL_NAME", "") or "").strip()
        else:
            saved = load_model_connections(include_secrets=True).get("text", {})
            row = saved if isinstance(saved, dict) else {}
            if row.get("enabled") and row.get("base_url") and row.get("model"):
                provider = str(row.get("provider", "openai-compatible") or "openai-compatible").strip().lower()
                base_url = str(row.get("base_url", "") or "").strip().rstrip("/")
                api_key = str(row.get("api_key", "") or "").strip()
                model = str(row.get("model", "") or "").strip()
            else:
                provider, base_url, api_key, model = "none", "", "", ""
        try:
            timeout = max(5, min(180, int(os.environ.get("MIRRORORDER_MODEL_TIMEOUT", "45"))))
        except ValueError:
            timeout = 45
        try:
            threshold = float(os.environ.get("MIRRORORDER_MODEL_MIN_CONFIDENCE", "0.84"))
        except ValueError:
            threshold = 0.84
        threshold = max(0.5, min(0.99, threshold))
        return cls(provider, base_url, api_key, model, timeout, threshold)

    @property
    def enabled(self) -> bool:
        return self.provider not in {"", "none", "off", "disabled"} and bool(self.base_url and self.model)

    def public(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "provider": self.provider or "none", "model": self.model}


class ModelProvider:
    """Bounded OpenAI-compatible / Gemini JSON rescue client.

    Secrets come from process environment or the device-local connection store;
    they never become synchronized project state. The unified multimodal client
    owns protocol adaptation and error scrubbing.
    """

    def __init__(self, config: ModelProviderConfig | None = None):
        self.config = config or ModelProviderConfig.from_env()

    def rescue(self, context: dict[str, Any]) -> dict[str, Any] | None:
        if not self.config.enabled:
            return None
        result = call_multimodal(
            MultimodalConfig(
                provider=self.config.provider,
                base_url=self.config.base_url,
                api_key=self.config.api_key,
                model=self.config.model,
                timeout_seconds=self.config.timeout_seconds,
            ),
            system=_RESCUE_SYSTEM,
            context=context,
            temperature=0.0,
        )
        if not result.ok:
            return None
        parsed = parse_json_object(result.text)
        if parsed is None:
            return None
        try:
            confidence = float(parsed.get("confidence", 0) or 0)
        except (TypeError, ValueError):
            confidence = 0.0
        if not math.isfinite(confidence):
            confidence = 0.0
        return {
            "candidate_id": str(parsed.get("candidate_id", "") or "")[:160],
            "confidence": max(0.0, min(1.0, confidence)),
            "reason": str(parsed.get("reason", "") or "")[:1000],
        }


__all__ = ["ModelProvider", "ModelProviderConfig"]
