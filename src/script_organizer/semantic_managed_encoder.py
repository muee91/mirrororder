from __future__ import annotations

import math
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from .device_runtime_settings import application_support_root, load_runtime_settings
from .semantic_encoder import SemanticEmbeddingConfig, SemanticEncoder
from .semantic_profiles import SEMANTIC_QUERY_INSTRUCTION, semantic_profile, semantic_runtime_support


QUERY_INSTRUCTION_VERSION = "editor-retrieval-v1"


@dataclass(frozen=True)
class ManagedSemanticConfig:
    enabled: bool
    profile: str
    model: str
    runtime: str
    dimensions: int
    source: str
    local: bool
    runtime_available: bool

    def public(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "profile": self.profile,
            "model": self.model,
            "runtime": self.runtime,
            "dimensions": self.dimensions,
            "source": self.source,
            "local": self.local,
            "runtime_available": self.runtime_available,
            "query_instruction_version": QUERY_INSTRUCTION_VERSION,
        }


class ManagedSemanticEncoder:
    """First-party embedding selector for production semantic retrieval.

    Explicit OpenAI-compatible model connections keep priority. Without one,
    the device-local semantic profile may use Qwen3-VL-Embedding-2B through
    Sentence Transformers. Model loading/downloading is allowed only for a
    background indexing task. Search requests instantiate this class with
    ``allow_prepare=False`` so Cmd/Ctrl+K can always fall back to FTS instead of
    silently downloading or loading several gigabytes of model weights.
    """

    _lock = threading.RLock()
    _models: dict[str, Any] = {}
    _model_errors: dict[str, str] = {}

    def __init__(self, *, allow_prepare: bool = False):
        self.allow_prepare = bool(allow_prepare)
        self.last_error = ""
        external_config = SemanticEmbeddingConfig.from_env()
        self._external = SemanticEncoder(external_config) if external_config.enabled else None
        self._profile = None

        if self._external is not None:
            self.config = ManagedSemanticConfig(
                enabled=True,
                profile="external",
                model=external_config.model,
                runtime=external_config.provider,
                dimensions=0,
                source=external_config.source,
                local=external_config.local,
                runtime_available=True,
            )
            return

        settings = load_runtime_settings()
        enabled = bool(settings.get("semantic_embedding_enabled", False))
        profile_key = str(
            os.environ.get(
                "MIRRORORDER_SEMANTIC_PROFILE",
                settings.get("semantic_embedding_profile", "standard"),
            )
            or "standard"
        ).strip().lower()
        profile = semantic_profile(profile_key)
        self._profile = profile
        support = semantic_runtime_support(profile)
        dimensions = int(settings.get("semantic_embedding_dimensions", profile.default_dimensions) or profile.default_dimensions)
        dimensions = max(64, min(profile.max_dimensions, dimensions))
        runtime_available = bool(support.get("available", False))
        # The first managed implementation is deliberately limited to the
        # official Sentence Transformers integration. The llama.cpp text-only
        # profile remains a declared fallback target until packaged macOS smoke
        # proves stable pooling/embedding behavior with our bundled binary.
        implemented = profile.runtime == "sentence-transformers"
        self.config = ManagedSemanticConfig(
            enabled=bool(enabled and runtime_available and implemented),
            profile=profile.key,
            model=profile.model,
            runtime=profile.runtime,
            dimensions=dimensions,
            source="device-semantic-profile",
            local=True,
            runtime_available=runtime_available and implemented,
        )

    @property
    def enabled(self) -> bool:
        if self._external is not None:
            return self._external.enabled
        return self.config.enabled

    @property
    def identity(self) -> str:
        if self._external is not None:
            return self._external.identity
        if not self.enabled:
            return ""
        return (
            f"managed:{self.config.profile}:{self.config.model}:"
            f"{self.config.dimensions}:{QUERY_INSTRUCTION_VERSION}"
        )

    @property
    def prepared(self) -> bool:
        if self._external is not None:
            return True
        if not self.enabled:
            return False
        with self._lock:
            return self.identity in self._models

    @property
    def cache_dir(self) -> Path:
        path = application_support_root() / "models" / "semantic"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @staticmethod
    def _device(torch_module: Any) -> str:
        try:
            if torch_module.cuda.is_available():
                return "cuda"
        except Exception:
            pass
        try:
            if torch_module.backends.mps.is_available():
                return "mps"
        except Exception:
            pass
        return "cpu"

    def prepare(self) -> bool:
        if self._external is not None:
            return True
        if not self.enabled or self._profile is None:
            self.last_error = "本地语义模型未启用或当前 runtime 不可用"
            return False
        if self.prepared:
            return True
        if not self.allow_prepare:
            self.last_error = "语义模型尚未由后台索引任务准备"
            return False

        identity = self.identity
        with self._lock:
            if identity in self._models:
                return True
            try:
                import torch
                from sentence_transformers import SentenceTransformer

                model = SentenceTransformer(
                    self.config.model,
                    cache_folder=str(self.cache_dir),
                    device=self._device(torch),
                    truncate_dim=self.config.dimensions,
                )
                self._models[identity] = model
                self._model_errors.pop(identity, None)
                self.last_error = ""
                return True
            except Exception as error:
                message = str(error)[:1000]
                self._model_errors[identity] = message
                self.last_error = message
                return False

    def _model(self) -> Any | None:
        if self._external is not None:
            return None
        with self._lock:
            model = self._models.get(self.identity)
        if model is not None:
            return model
        if self.allow_prepare and self.prepare():
            with self._lock:
                return self._models.get(self.identity)
        self.last_error = self._model_errors.get(self.identity, self.last_error or "语义模型尚未准备")
        return None

    @staticmethod
    def _validated(rows: object) -> list[list[float]] | None:
        try:
            values = rows.tolist() if hasattr(rows, "tolist") else list(rows)  # type: ignore[arg-type]
        except Exception:
            return None
        result: list[list[float]] = []
        for row in values:
            try:
                vector = [float(value) for value in row]
            except (TypeError, ValueError):
                return None
            if not vector or any(not math.isfinite(value) for value in vector):
                return None
            magnitude = math.sqrt(sum(value * value for value in vector))
            if magnitude <= 1e-12 or not math.isfinite(magnitude):
                return None
            result.append([value / magnitude for value in vector])
        return result

    def _encode_local(self, inputs: Sequence[object], *, query: bool) -> list[list[float]] | None:
        model = self._model()
        if model is None:
            return None
        try:
            kwargs = {
                "batch_size": max(1, min(16, len(inputs))),
                "show_progress_bar": False,
                "convert_to_numpy": True,
                "normalize_embeddings": True,
                "truncate_dim": self.config.dimensions,
            }
            if query and hasattr(model, "encode_query"):
                rows = model.encode_query(
                    list(inputs),
                    prompt=SEMANTIC_QUERY_INSTRUCTION + "\n",
                    **kwargs,
                )
            else:
                rows = model.encode(list(inputs), **kwargs)
            validated = self._validated(rows)
            if validated is None or len(validated) != len(inputs):
                raise ValueError("本地语义模型返回了无效 embedding")
            self.last_error = ""
            return validated
        except Exception as error:
            self.last_error = str(error)[:1000]
            return None

    def encode(self, texts: Sequence[str]) -> list[list[float]] | None:
        values = [str(value or "").strip()[:12000] for value in texts]
        if not values:
            return []
        if self._external is not None:
            return self._external.encode(values)
        return self._encode_local(values, query=False)

    def encode_one(self, text: str) -> list[float] | None:
        value = str(text or "").strip()[:12000]
        if not value:
            return None
        if self._external is not None:
            return self._external.encode_one(value)
        rows = self._encode_local([value], query=True)
        return rows[0] if rows else None

    def encode_multimodal(self, inputs: Sequence[object]) -> list[list[float]] | None:
        """Encode text/image/mixed SentenceTransformer inputs in the shared space.

        This is intentionally not wired to media paths yet. The frame-indexing
        layer must supply bounded representative-frame inputs and safe media
        provenance; search stores must continue to avoid persisting device paths.
        """
        if self._external is not None or self.config.profile != "standard":
            self.last_error = "当前 encoder 不支持第一方多模态输入"
            return None
        return self._encode_local(list(inputs), query=False)
