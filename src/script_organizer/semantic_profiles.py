from __future__ import annotations

import importlib.util
from dataclasses import asdict, dataclass
from typing import Any

from .local_vision_runtime import LocalVisionRuntime


DEFAULT_SEMANTIC_PROFILE = "standard"
SEMANTIC_QUERY_INSTRUCTION = (
    "Retrieve video-production evidence relevant to the editor's search query. "
    "Prefer concrete visual actions, spoken lines, human slate notes and production context."
)


@dataclass(frozen=True)
class SemanticEmbeddingProfile:
    key: str
    title: str
    description: str
    model: str
    runtime: str
    modalities: tuple[str, ...]
    max_dimensions: int
    default_dimensions: int
    instruction_aware: bool
    mrl: bool
    managed_local: bool = True

    def public(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["modalities"] = list(self.modalities)
        payload["runtime_support"] = semantic_runtime_support(self)
        return payload


PROFILES: dict[str, SemanticEmbeddingProfile] = {
    "standard": SemanticEmbeddingProfile(
        key="standard",
        title="标准",
        description="多模态语义检索；用于画面、对白、场记与后续相似镜头检索。",
        model="Qwen/Qwen3-VL-Embedding-2B",
        runtime="sentence-transformers",
        modalities=("text", "image", "video", "mixed"),
        max_dimensions=2048,
        default_dimensions=1024,
        instruction_aware=True,
        mrl=True,
    ),
    "lightweight": SemanticEmbeddingProfile(
        key="lightweight",
        title="轻量",
        description="仅文本语义检索；低内存设备和标准多模态 runtime 不可用时使用。",
        model="Qwen/Qwen3-Embedding-0.6B-GGUF",
        runtime="llama-server",
        modalities=("text",),
        max_dimensions=1024,
        default_dimensions=1024,
        instruction_aware=True,
        mrl=True,
    ),
}


def semantic_profile(value: object = DEFAULT_SEMANTIC_PROFILE) -> SemanticEmbeddingProfile:
    key = str(value or DEFAULT_SEMANTIC_PROFILE).strip().lower()
    return PROFILES.get(key, PROFILES[DEFAULT_SEMANTIC_PROFILE])


def _module_available(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, AttributeError, ValueError):
        return False


def semantic_runtime_support(profile: SemanticEmbeddingProfile) -> dict[str, Any]:
    if profile.runtime == "sentence-transformers":
        modules = {
            "PIL": _module_available("PIL"),
            "torch": _module_available("torch"),
            "transformers": _module_available("transformers"),
            "sentence_transformers": _module_available("sentence_transformers"),
            "torchvision": _module_available("torchvision"),
        }
        return {
            "available": all(modules.values()),
            "runtime": profile.runtime,
            "modules": modules,
            "multimodal": True,
            "reason": "" if all(modules.values()) else "标准多模态语义 runtime 尚未随当前 App 打包",
        }

    llama = LocalVisionRuntime().public()
    available = bool(llama.get("available", False))
    return {
        "available": available,
        "runtime": profile.runtime,
        "modules": {},
        "multimodal": False,
        "reason": "" if available else "llama-server 不可用",
    }


def semantic_profiles_public() -> dict[str, Any]:
    return {
        "default": DEFAULT_SEMANTIC_PROFILE,
        "query_instruction": SEMANTIC_QUERY_INSTRUCTION,
        "profiles": {key: profile.public() for key, profile in PROFILES.items()},
        "authority": {
            "retrieval_only": True,
            "review_write": False,
            "editorial_write": False,
            "best_selection": False,
        },
    }
