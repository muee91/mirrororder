from __future__ import annotations

import json
import math
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Sequence
from urllib.parse import urlparse

from .model_connections import load_model_connections


@dataclass(frozen=True)
class SemanticEmbeddingConfig:
    """Device-local configuration for the shared document/query encoder.

    MirrorOrder deliberately does not ship a fake vector fallback. When no
    embedding endpoint is configured, the semantic retrieval layer remains
    useful through FTS/lexical recall. Once enabled, both indexing and querying
    use this exact model identity so incompatible vector spaces are never mixed.
    """

    provider: str = "none"
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    timeout_seconds: int = 30
    source: str = "none"

    @classmethod
    def from_env(cls) -> "SemanticEmbeddingConfig":
        raw_provider = os.environ.get("MIRRORORDER_EMBEDDING_PROVIDER")
        raw_base = os.environ.get("MIRRORORDER_EMBEDDING_BASE_URL")
        raw_key = os.environ.get("MIRRORORDER_EMBEDDING_API_KEY")
        raw_model = os.environ.get("MIRRORORDER_EMBEDDING_MODEL")
        if any(value is not None for value in (raw_provider, raw_base, raw_key, raw_model)):
            provider = str(raw_provider or "openai-compatible").strip().lower()
            base_url = str(raw_base or "").strip().rstrip("/")
            api_key = str(raw_key or "").strip()
            model = str(raw_model or "").strip()
            source = "embedding-env"
        else:
            saved = load_model_connections(include_secrets=True).get("embedding", {})
            if isinstance(saved, dict) and saved.get("enabled") and saved.get("base_url") and saved.get("model"):
                provider = str(saved.get("provider", "openai-compatible") or "openai-compatible").strip().lower()
                base_url = str(saved.get("base_url", "") or "").strip().rstrip("/")
                api_key = str(saved.get("api_key", "") or "").strip()
                model = str(saved.get("model", "") or "").strip()
                source = "device-model-connection"
            else:
                provider = "none"
                base_url = ""
                api_key = ""
                model = ""
                source = "none"
        try:
            timeout = max(5, min(120, int(os.environ.get("MIRRORORDER_EMBEDDING_TIMEOUT", "30") or 30)))
        except ValueError:
            timeout = 30
        return cls(provider, base_url, api_key, model, timeout, source)

    @property
    def enabled(self) -> bool:
        return bool(
            self.provider not in {"", "none", "off", "disabled"}
            and self.base_url
            and self.model
        )

    @property
    def local(self) -> bool:
        if self.provider in {"local", "llama", "llama.cpp", "llama-server"}:
            return True
        try:
            host = (urlparse(self.base_url).hostname or "").lower()
        except ValueError:
            return False
        return host in {"127.0.0.1", "localhost", "::1"}

    @property
    def identity(self) -> str:
        return f"{self.provider}:{self.model}" if self.enabled else ""

    def public(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "provider": self.provider or "none",
            "model": self.model,
            "source": self.source,
            "local": self.local,
        }


class SemanticEncoder:
    """OpenAI-compatible embedding client shared by index and query paths."""

    def __init__(self, config: SemanticEmbeddingConfig | None = None):
        self.config = config or SemanticEmbeddingConfig.from_env()
        self.last_error = ""

    @property
    def enabled(self) -> bool:
        return self.config.enabled

    @property
    def identity(self) -> str:
        return self.config.identity

    @staticmethod
    def _normalize(values: Sequence[object]) -> list[float] | None:
        try:
            vector = [float(value) for value in values]
        except (TypeError, ValueError):
            return None
        if not vector or len(vector) > 16384:
            return None
        magnitude = math.sqrt(sum(value * value for value in vector))
        if not math.isfinite(magnitude) or magnitude <= 1e-12:
            return None
        result = [value / magnitude for value in vector]
        return result if all(math.isfinite(value) for value in result) else None

    def encode(self, texts: Sequence[str]) -> list[list[float]] | None:
        clean = [str(text or "").strip()[:12000] for text in texts]
        if not clean:
            return []
        if not self.enabled:
            self.last_error = "embedding encoder disabled"
            return None
        url = self.config.base_url.rstrip("/")
        if not url.endswith("/v1"):
            url += "/v1"
        url += "/embeddings"
        payload = {
            "model": self.config.model,
            "input": clean,
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
            rows = raw.get("data", []) if isinstance(raw, dict) else []
            if not isinstance(rows, list) or len(rows) != len(clean):
                raise ValueError("embedding response count mismatch")
            ordered: list[list[float] | None] = [None] * len(clean)
            for fallback_index, row in enumerate(rows):
                if not isinstance(row, dict):
                    raise ValueError("invalid embedding row")
                index = int(row.get("index", fallback_index) or 0)
                if index < 0 or index >= len(clean):
                    raise ValueError("invalid embedding index")
                vector = self._normalize(row.get("embedding", []))
                if vector is None:
                    raise ValueError("invalid embedding vector")
                ordered[index] = vector
            if any(vector is None for vector in ordered):
                raise ValueError("missing embedding vector")
            dimensions = {len(vector or []) for vector in ordered}
            if len(dimensions) != 1:
                raise ValueError("embedding dimensions differ")
            self.last_error = ""
            return [vector or [] for vector in ordered]
        except (
            OSError,
            urllib.error.URLError,
            urllib.error.HTTPError,
            UnicodeDecodeError,
            ValueError,
            TypeError,
        ) as error:
            self.last_error = str(error)[:500]
            return None

    def encode_one(self, text: str) -> list[float] | None:
        rows = self.encode([text])
        return rows[0] if rows else None
