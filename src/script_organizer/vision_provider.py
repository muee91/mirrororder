from __future__ import annotations

import math
import mimetypes
import os
import shutil
import subprocess
import tempfile
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
from .multimodal_client import MultimodalConfig, call_multimodal, parse_json_object


_LOCAL_PROVIDERS = {"local", "llama", "llama.cpp", "llama-server"}
_SCENE_CROSS_CHECK = (
    "你正在独立核对实拍画面和剧本的场景说明。候选根据声音取得，但你只用这些帧判断。"
    "选一个候选需要看到能区分场次的具体动作、物件或人物站位。普通室内或有人交谈不够。"
    "script_quote 必须逐字摘自该候选的 script_text，visual_summary 写出照片里实际可见的对应细节。"
    "如果同样适用于多个候选、看不清或缺少具体证据，candidate_id 和 script_quote 留空。"
    '只输出 JSON {"candidate_id":"","confidence":0.0,"script_quote":"","visual_summary":"","reason":""}。'
)


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
        elif isinstance(saved, dict) and saved.get("enabled"):
            saved_provider = str(saved.get("provider", "openai-compatible") or "openai-compatible").strip().lower()
            if saved.get("base_url") and saved.get("model"):
                provider = saved_provider
                base_url = str(saved.get("base_url", "") or "").strip().rstrip("/")
                api_key = str(saved.get("api_key", "") or "").strip()
                model = str(saved.get("model", "") or "").strip()
            else:
                provider = "local" if device.get("local_vision_enabled") else "none"
                base_url = ""
                api_key = ""
                model = ""
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
        if not frames:
            shutil.rmtree(output_dir, ignore_errors=True)
        return frames

    def rescue(self, context: dict[str, Any], frames: list[Path]) -> dict[str, Any] | None:
        if not self.config.enabled or not frames:
            return None
        pictures: list[tuple[bytes, str]] = []
        for frame in frames:
            if not frame:
                continue
            path = Path(frame)
            if not path.is_file():
                continue
            mime = mimetypes.guess_type(path.name)[0] or "image/jpeg"
            pictures.append((path.read_bytes(), mime))
        if not pictures:
            return None
        system = (
            "你是短剧素材的视觉二审器。根据抽帧判断人物、场景和动作，但只能从输入给出的 candidate_id 中选择。"
            "禁止发明剧本位置。输出严格 JSON："
            '{"candidate_id":"...","confidence":0.0,"visual_summary":"...","reason":"..."}。'
            "证据不足时 candidate_id 为空且 confidence 低于0.5。"
        )
        result = call_multimodal(
            MultimodalConfig(
                provider=self.config.provider,
                base_url=self.config.base_url,
                api_key=self.config.api_key,
                model=self.config.model,
                timeout_seconds=self.config.timeout_seconds,
            ),
            system=_SCENE_CROSS_CHECK if context.get("purpose") == "scene_cross_check" else system,
            context=context,
            images=pictures,
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
            "visual_summary": str(parsed.get("visual_summary", "") or "")[:1000],
            "script_quote": str(parsed.get("script_quote", "") or "")[:400],
            "reason": str(parsed.get("reason", "") or "")[:1000],
        }
