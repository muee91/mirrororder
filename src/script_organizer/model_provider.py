from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


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
        provider = os.environ.get("MIRRORORDER_MODEL_PROVIDER", "none").strip().lower()
        base_url = os.environ.get("MIRRORORDER_MODEL_BASE_URL", "").strip().rstrip("/")
        api_key = os.environ.get("MIRRORORDER_MODEL_API_KEY", "").strip()
        model = os.environ.get("MIRRORORDER_MODEL_NAME", "").strip()
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
    """Minimal OpenAI-compatible JSON rescue client.

    The endpoint is configured by environment variables instead of project files
    so API secrets never become synchronized project state.
    """

    def __init__(self, config: ModelProviderConfig | None = None):
        self.config = config or ModelProviderConfig.from_env()

    def rescue(self, context: dict[str, Any]) -> dict[str, Any] | None:
        if not self.config.enabled:
            return None
        url = self.config.base_url
        if not url.endswith("/chat/completions"):
            url += "/chat/completions"
        system = (
            "你是影视素材剧本映射的二审器。只能在输入给出的 candidate_id 中选择，"
            "不能发明新的剧本范围。输出严格 JSON："
            '{"candidate_id":"...","confidence":0.0,"reason":"..."}。'
            "如果证据不足，candidate_id 设为空字符串且 confidence 低于 0.5。"
            "拍摄顺序、人工审核和素材时间关系高于语义猜测。"
        )
        payload = {
            "model": self.config.model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(context, ensure_ascii=False)},
            ],
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.config.api_key:
            headers["Authorization"] = "Bearer " + self.config.api_key
        request = urllib.request.Request(url, data=body, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.config.timeout_seconds) as response:
                raw = json.loads(response.read().decode("utf-8"))
        except (OSError, urllib.error.URLError, urllib.error.HTTPError, UnicodeDecodeError, ValueError):
            return None
        try:
            content = raw["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            return None
        if isinstance(content, list):
            content = "".join(str(item.get("text", "")) for item in content if isinstance(item, dict))
        text = str(content or "").strip()
        if text.startswith("```"):
            text = text.strip("`").removeprefix("json").strip()
        try:
            result = json.loads(text)
        except ValueError:
            left, right = text.find("{"), text.rfind("}")
            if left < 0 or right <= left:
                return None
            try:
                result = json.loads(text[left : right + 1])
            except ValueError:
                return None
        if not isinstance(result, dict):
            return None
        try:
            confidence = float(result.get("confidence", 0) or 0)
        except (TypeError, ValueError):
            confidence = 0.0
        return {
            "candidate_id": str(result.get("candidate_id", "") or "")[:160],
            "confidence": max(0.0, min(1.0, confidence)),
            "reason": str(result.get("reason", "") or "")[:1000],
        }
