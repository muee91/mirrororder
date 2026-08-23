from __future__ import annotations

import base64
import json
import mimetypes
import os
import subprocess
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .device_runtime_settings import load_runtime_settings
from .model_connections import load_model_connections
from .local_vision_runtime import (
    DEFAULT_LOCAL_VISION_MODEL,
    LocalVisionRuntime,
    LocalVisionRuntimeConfig,
)


_LOCAL_PROVIDERS = {"local", "llama", "llama.cpp", "llama-server"}


@dataclass(frozen=True)
class VisionProviderConfig:
    provider: str = "none"
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    timeout_seconds: int = 90
    min_confidence: float = 0.90
    frame_count: int = 3

    @classmethod
    def from_env(cls) -> "VisionProviderConfig":
        device = load_runtime_settings()
        raw_provider = os.environ.get("MIRRORORDER_VISION_PROVIDER")
        raw_base = os.environ.get("MIRRORORDER_VISION_BASE_URL")
        raw_key = os.environ.get("MIRRORORDER_VISION_API_KEY")
        raw_model = os.environ.get("MIRRORORDER_VISION_MODEL")
        explicit_env = any(value is not None for value in (raw_provider, raw_base, raw_key, raw_model))
        saved = load_model_connections(include_secrets=True).get("vision", {})
        if explicit_env:
            if raw_provider is not None:
                provider = str(raw_provider or "none").strip().lower()
            elif device.get("local_vision_enabled") and not str(raw_base or "").strip():
                # Backward compatibility: MIRRORORDER_VISION_MODEL alone has
                # historically meant "override the local model", not "switch
                # to a remote provider".
                provider = "local"
            else:
                provider = "openai-compatible"
            base_url = str(raw_base or "").strip().rstrip("/")
            api_key = str(raw_key or "").strip()
            model = str(raw_model or "").strip()
        elif isinstance(saved, dict) and saved.get("enabled") and saved.get("base_url") and saved.get("model"):
            provider = str(saved.get("provider", "openai-compatible") or "openai-compatible").strip().lower()
            base_url = str(saved.get("base_url", "") or "").strip().rstrip("/")
            api_key = str(saved.get("api_key", "") or "").strip()
            model = str(saved.get("model", "") or "").strip()
        else:
            provider = "local" if device.get("local_vision_enabled") else "none"
            base_url = ""
            api_key = ""
            model = ""
        if provider in _LOCAL_PROVIDERS and not model:
            model = str(device.get("local_vision_model") or DEFAULT_LOCAL_VISION_MODEL)
        try:
            timeout = max(10, min(300, int(os.environ.get("MIRRORORDER_VISION_TIMEOUT", "90"))))
        except ValueError:
            timeout = 90
        try:
            threshold = float(os.environ.get("MIRRORORDER_VISION_MIN_CONFIDENCE", "0.90"))
        except ValueError:
            threshold = 0.90
        try:
            frames = max(1, min(5, int(os.environ.get("MIRRORORDER_VISION_FRAME_COUNT", "3"))))
        except ValueError:
            frames = 3
        return cls(provider, base_url, api_key, model, timeout, max(0.5, min(0.99, threshold)), frames)

    @property
    def is_local(self) -> bool:
        return self.provider in _LOCAL_PROVIDERS

    @property
    def enabled(self) -> bool:
        if self.provider in {"", "none", "off", "disabled"}:
            return False
        if self.is_local:
            return bool(self.model)
        return bool(self.base_url and self.model)

    def public(self) -> dict[str, Any]:
        payload = {
            "enabled": self.enabled,
            "provider": self.provider or "none",
            "model": self.model,
            "frame_count": self.frame_count,
        }
        if self.is_local:
            payload["runtime"] = LocalVisionRuntime(LocalVisionRuntimeConfig.from_env(self.model)).public()
        return payload


class VisionProvider:
    """Small local/remote OpenAI-compatible VLM rescue provider.

    The Host extracts a few low-resolution frames and constrains the model to a
    bounded list of nearby script candidates. Raw video is never uploaded by
    this class; only sampled JPEG frames are sent to the configured endpoint.

    Local mode owns llama-server automatically. It never downloads a model
    during Codex/build time; download can only happen at runtime after local
    vision has explicitly been enabled and a visual rescue actually needs it.
    """

    def __init__(self, config: VisionProviderConfig | None = None):
        self.config = config or VisionProviderConfig.from_env()
        self._local_runtime: LocalVisionRuntime | None = None

    def _base_url(self) -> str:
        if not self.config.enabled:
            return ""
        if not self.config.is_local:
            return self.config.base_url
        if self._local_runtime is None:
            self._local_runtime = LocalVisionRuntime(LocalVisionRuntimeConfig.from_env(self.config.model))
        return self._local_runtime.ensure_server()

    @staticmethod
    def _encode_image(path: Path) -> str:
        mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
        return f"data:{mime};base64,{encoded}"

    def extract_frames(
        self,
        media_path: str,
        source_start: float,
        source_end: float | None,
    ) -> list[Path]:
        if not self.config.enabled:
            return []
        source = Path(media_path)
        if not source.is_file():
            return []
        start = max(0.0, float(source_start or 0.0))
        end = float(source_end) if source_end is not None else start + 3.0
        if end <= start:
            end = start + 1.0
        span = max(0.2, end - start)
        fractions = [0.5] if self.config.frame_count == 1 else [
            0.15 + (0.70 * index / (self.config.frame_count - 1))
            for index in range(self.config.frame_count)
        ]
        output_dir = Path(tempfile.mkdtemp(prefix="mirrororder-vision-"))
        frames: list[Path] = []
        for index, fraction in enumerate(fractions):
            timestamp = start + span * fraction
            target = output_dir / f"frame-{index + 1}.jpg"
            command = [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-ss", f"{timestamp:.3f}", "-i", str(source),
                "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "3", str(target),
            ]
            try:
                subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45)
            except (OSError, subprocess.SubprocessError):
                continue
            if target.is_file() and target.stat().st_size > 0:
                frames.append(target)
        return frames

    def rescue(self, context: dict[str, Any], frames: list[Path]) -> dict[str, Any] | None:
        if not self.config.enabled or not frames:
            return None
        base_url = self._base_url()
        if not base_url:
            return None
        url = base_url
        if not url.endswith("/v1"):
            url += "/v1"
        url += "/chat/completions"
        system = (
            "你是短剧素材的视觉二审器。根据抽帧判断人物、场景和动作，但只能从输入给出的 candidate_id 中选择。"
            "禁止发明剧本位置。输出严格 JSON："
            '{"candidate_id":"...","confidence":0.0,"visual_summary":"...","reason":"..."}。'
            "证据不足时 candidate_id 为空且 confidence 低于0.5。"
        )
        content: list[dict[str, Any]] = [
            {"type": "text", "text": json.dumps(context, ensure_ascii=False)},
        ]
        for frame in frames:
            content.append({"type": "image_url", "image_url": {"url": self._encode_image(frame)}})
        payload = {
            "model": self.config.model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": content},
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
            text = raw["choices"][0]["message"]["content"]
        except (OSError, urllib.error.URLError, urllib.error.HTTPError, UnicodeDecodeError, ValueError, KeyError, IndexError, TypeError):
            return None
        if isinstance(text, list):
            text = "".join(str(item.get("text", "")) for item in text if isinstance(item, dict))
        text = str(text or "").strip()
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
            "visual_summary": str(result.get("visual_summary", "") or "")[:1000],
            "reason": str(result.get("reason", "") or "")[:1000],
        }
