from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from .local_vision_runtime import LocalVisionRuntime, LocalVisionRuntimeConfig
from .model_connections import load_model_connections
from .model_provider import ModelProviderConfig
from .semantic_encoder import SemanticEmbeddingConfig
from .vision_provider import VisionProviderConfig


@dataclass(frozen=True)
class AssistantModelConfig:
    provider: str = "none"
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    timeout_seconds: int = 60
    source: str = "none"

    @classmethod
    def from_env(cls) -> "AssistantModelConfig":
        raw_provider = os.environ.get("MIRRORORDER_ASSISTANT_MODEL_PROVIDER")
        raw_base = os.environ.get("MIRRORORDER_ASSISTANT_MODEL_BASE_URL")
        raw_key = os.environ.get("MIRRORORDER_ASSISTANT_MODEL_API_KEY")
        raw_model = os.environ.get("MIRRORORDER_ASSISTANT_MODEL_NAME")
        if any(value is not None for value in (raw_provider, raw_base, raw_key, raw_model)):
            provider = str(raw_provider or "openai-compatible").strip().lower()
            base_url = str(raw_base or "").strip().rstrip("/")
            api_key = str(raw_key or "").strip()
            model = str(raw_model or "").strip()
            source = "assistant-env"
        else:
            saved = load_model_connections(include_secrets=True).get("text", {})
            if isinstance(saved, dict) and saved.get("enabled") and saved.get("base_url") and saved.get("model"):
                provider = str(saved.get("provider", "openai-compatible") or "openai-compatible").strip().lower()
                base_url = str(saved.get("base_url", "") or "").strip().rstrip("/")
                api_key = str(saved.get("api_key", "") or "").strip()
                model = str(saved.get("model", "") or "").strip()
                source = "device-model-connection"
            else:
                rescue = ModelProviderConfig.from_env()
                if rescue.enabled:
                    provider = rescue.provider
                    base_url = rescue.base_url
                    api_key = rescue.api_key
                    model = rescue.model
                    source = "production-rescue"
                else:
                    vision = VisionProviderConfig.from_env()
                    if vision.enabled and vision.is_local:
                        provider = "local-vision"
                        base_url = ""
                        api_key = ""
                        model = vision.model
                        source = "local-vision-text-fallback"
                    else:
                        provider = "none"
                        base_url = ""
                        api_key = ""
                        model = ""
                        source = "none"
        try:
            timeout = max(10, min(180, int(os.environ.get("MIRRORORDER_ASSISTANT_MODEL_TIMEOUT", "60") or 60)))
        except ValueError:
            timeout = 60
        return cls(provider, base_url, api_key, model, timeout, source)

    @property
    def is_local(self) -> bool:
        return self.provider in {"local", "local-vision", "llama", "llama.cpp", "llama-server"}

    @property
    def enabled(self) -> bool:
        if self.provider in {"", "none", "off", "disabled"} or not self.model:
            return False
        return self.is_local or bool(self.base_url)

    def public(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "provider": self.provider or "none",
            "model": self.model,
            "source": self.source,
            "local": self.is_local,
        }


class ModelRegistry:
    """One public inventory for every optional model role used by MirrorOrder.

    Secrets remain process/device local. The registry exposes capability facts,
    never API keys or synchronized project configuration. Routing is derived
    from the same effective configs the runtimes use, so UI never has to guess
    which saved connection actually won precedence.
    """

    def __init__(self) -> None:
        self.rescue = ModelProviderConfig.from_env()
        self.vision = VisionProviderConfig.from_env()
        self.assistant = AssistantModelConfig.from_env()
        self.embedding = SemanticEmbeddingConfig.from_env()

    @staticmethod
    def _route(
        *,
        enabled: bool,
        provider: str,
        model: str,
        local: bool,
        source: str = "",
        fallback: str = "",
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "enabled": bool(enabled),
            "provider": provider or "none",
            "model": model,
            "local": bool(local),
        }
        if source:
            payload["source"] = source
        if fallback:
            payload["fallback"] = fallback
        return payload

    def routing(self) -> dict[str, Any]:
        text = self._route(
            enabled=self.assistant.enabled,
            provider=self.assistant.provider,
            model=self.assistant.model,
            local=self.assistant.is_local,
            source=self.assistant.source,
        )
        vision = self._route(
            enabled=self.vision.enabled,
            provider=self.vision.provider,
            model=self.vision.model,
            local=self.vision.is_local,
        )
        embedding = self._route(
            enabled=self.embedding.enabled,
            provider=self.embedding.provider,
            model=self.embedding.model,
            local=self.embedding.local,
            source=self.embedding.source,
            fallback="" if self.embedding.enabled else "keyword",
        )
        enabled_routes = [row for row in (text, vision, embedding) if row["enabled"]]
        has_local = any(bool(row["local"]) for row in enabled_routes)
        has_external = any(not bool(row["local"]) for row in enabled_routes)
        if has_local and has_external:
            mode = "hybrid"
            privacy = "mixed"
        elif has_external:
            mode = "external"
            privacy = "external-models"
        elif has_local:
            mode = "local"
            privacy = "local-only"
        else:
            mode = "fallback"
            privacy = "local-only"
        return {
            "contract": "model_routing.v1",
            "mode": mode,
            "privacy": privacy,
            "text": text,
            "vision": vision,
            "embedding": embedding,
        }

    def public(self) -> dict[str, Any]:
        vision = self.vision.public()
        return {
            "contract": "models.v1",
            "production_rescue": self.rescue.public(),
            "vision": vision,
            "multimodal_audit": {
                "enabled": bool(self.vision.enabled),
                "provider": self.vision.provider or "none",
                "model": self.vision.model,
                "local": bool(self.vision.is_local),
                "frame_count": int(self.vision.frame_count),
            },
            "assistant_language": self.assistant.public(),
            "semantic_embedding": self.embedding.public(),
        }


class AssistantLanguageModel:
    """Bounded JSON client used by the first-party assistant orchestrator.

    This is deliberately not a free-form code agent. The caller supplies a
    strict system contract and validates every returned tool action before it is
    executed. When no dedicated LLM exists, the already-enabled local VLM can
    be reused as a text-only fallback for concise planning and explanations.
    """

    def __init__(self, config: AssistantModelConfig | None = None):
        self.config = config or AssistantModelConfig.from_env()
        self._local_runtime: LocalVisionRuntime | None = None

    @property
    def enabled(self) -> bool:
        return self.config.enabled

    def _base_url(self) -> str:
        if not self.enabled:
            return ""
        if not self.config.is_local:
            return self.config.base_url.rstrip("/")
        if self._local_runtime is None:
            self._local_runtime = LocalVisionRuntime(LocalVisionRuntimeConfig.from_env(self.config.model))
        return self._local_runtime.ensure_server().rstrip("/")

    @staticmethod
    def _decode_content(raw: object) -> str:
        if isinstance(raw, list):
            return "".join(
                str(item.get("text", ""))
                for item in raw
                if isinstance(item, dict)
            )
        return str(raw or "")

    @staticmethod
    def _parse_json(text: str) -> dict[str, Any] | None:
        value = text.strip()
        if value.startswith("```"):
            value = value.strip("`").removeprefix("json").strip()
        try:
            payload = json.loads(value)
        except ValueError:
            left, right = value.find("{"), value.rfind("}")
            if left < 0 or right <= left:
                return None
            try:
                payload = json.loads(value[left : right + 1])
            except ValueError:
                return None
        return payload if isinstance(payload, dict) else None

    def complete_json(
        self,
        *,
        system: str,
        context: dict[str, Any],
        temperature: float = 0.0,
    ) -> dict[str, Any] | None:
        base = self._base_url()
        if not base:
            return None
        url = base
        if not url.endswith("/v1"):
            url += "/v1"
        url += "/chat/completions"
        payload = {
            "model": self.config.model,
            "temperature": max(0.0, min(1.0, float(temperature))),
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(context, ensure_ascii=False)},
            ],
        }
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.config.api_key:
            headers["Authorization"] = "Bearer " + self.config.api_key
        request = urllib.request.Request(
            url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers=headers,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.config.timeout_seconds) as response:
                raw = json.loads(response.read().decode("utf-8"))
            content = raw["choices"][0]["message"]["content"]
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
            return None
        return self._parse_json(self._decode_content(content))
