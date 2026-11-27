from __future__ import annotations

import os
import platform
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable

from . import model_connections
from .cloud_asr_provider import CloudASRConfig, CloudASRProvider
from .config import ProjectConfig
from .device_runtime_settings import application_support_root
from .models import Clip, Transcript, TranscriptSegment
from .resource_scheduler import ResourceCancelled
from .script_parser import parse_script
from .speech_worker import cached_small_model, transcribe_local
from .transcript import TranscriptStore, transcript_fingerprint


_CLOUD_BACKENDS = {"gemini", "openai", "cloud"}

_MLX_MODEL_ALIASES = {
    "tiny": "mlx-community/whisper-tiny-mlx",
    "base": "mlx-community/whisper-base-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "turbo": "mlx-community/whisper-large-v3-turbo",
}


def _is_apple_silicon() -> bool:
    return platform.system() == "Darwin" and platform.machine().lower() in {"arm64", "aarch64"}


def _configure_model_cache() -> Path:
    """Keep downloaded MLX/Hugging Face weights in MirrorOrder device state."""
    root = application_support_root() / "models" / "huggingface"
    root.mkdir(parents=True, exist_ok=True)
    # Respect an explicit operator cache. Otherwise prevent project/workspace
    # paths or a developer checkout from becoming an accidental model store.
    if not any(os.environ.get(key, "").strip() for key in ("HF_HOME", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE")):
        os.environ["HF_HOME"] = str(root)
    return root


def _cloud_config_from_connections(requested: str, config: ProjectConfig) -> CloudASRConfig | None:
    """Resolve an explicit cloud request from device-local model connections.

    Credentials are read only from the device secret store and stay inside the
    returned config; they are never placed on a shared project or a log line.
    """
    try:
        connections = model_connections.load_model_connections(include_secrets=True)
    except Exception:
        return None
    rows = [connections.get(role, {}) for role in ("text", "vision", "embedding")]
    selected: dict[str, Any] | None = None
    for row in rows:
        if not isinstance(row, dict):
            continue
        if row.get("enabled") is False:
            continue
        provider = str(row.get("provider", "") or "").strip().lower()
        normalized = "gemini" if provider == "gemini" else "openai" if provider in {"openai", "openai-compatible"} else ""
        if not normalized:
            continue
        if requested != "cloud" and normalized != requested:
            continue
        if not str(row.get("api_key", "") or "").strip():
            continue
        selected = row
        break
    if selected is None:
        return None
    provider = str(selected.get("provider", "")).strip().lower()
    normalized = "gemini" if provider == "gemini" else "openai"
    raw_model = str(selected.get("model", "") or "").strip()
    if normalized == "openai" and raw_model and not any(tok in raw_model.lower() for tok in ("whisper", "transcribe")):
        # Do not pass a chat model such as gpt-4.1 to /audio/transcriptions.
        raw_model = ""
    return CloudASRConfig(
        provider=normalized,
        api_key=str(selected.get("api_key", "") or "").strip(),
        base_url=str(selected.get("base_url", "") or "").strip(),
        model=raw_model,
        language=config.asr_language,
    )


def script_asr_prompt(script_path: str | Path | None, max_speakers: int = 80) -> str:
    """Build a small vocabulary prompt from script speaker names.

    The prompt is deliberately small: it improves proper-name recognition without
    leaking whole dialogue lines into ASR and then mistaking prompted text for
    acoustic evidence.
    """
    if script_path is None:
        return ""
    try:
        document = parse_script(script_path)
    except Exception:
        return ""
    speakers: list[str] = []
    seen: set[str] = set()
    for segment in document.segments:
        speaker = str(getattr(segment, "speaker", "") or "").strip()
        if speaker and speaker not in seen:
            seen.add(speaker)
            speakers.append(speaker)
        if len(speakers) >= max_speakers:
            break
    if not speakers:
        return ""
    return "人物姓名和专有词：" + "、".join(speakers)


@dataclass
class ASRRuntime:
    backend: str
    model: str
    language: str
    device: str = "auto"
    fallback_allowed: bool = False
    _faster_model: Any = None
    _cloud_config: CloudASRConfig | None = None
    _local_model: str = "small"
    cancelled: Callable[[], bool] | None = None

    @classmethod
    def from_config(cls, config: ProjectConfig) -> "ASRRuntime":
        requested = str(config.asr_backend or "auto").strip().lower()
        if requested == "cache":
            return cls("cache", config.asr_model, config.asr_language, config.asr_device)
        if requested in _CLOUD_BACKENDS:
            cloud = _cloud_config_from_connections(requested, config)
            if cloud is None:
                # No usable cloud credential: stay usable locally, but mark the
                # results so a cloud request is never mistaken for a cloud run.
                if _is_apple_silicon():
                    runtime = cls(
                        "mlx-whisper", _MLX_MODEL_ALIASES.get(config.asr_model, config.asr_model),
                        config.asr_language, config.asr_device, fallback_allowed=True,
                        _local_model=config.asr_model,
                    )
                else:
                    runtime = cls(
                        "faster-whisper", config.asr_model, config.asr_language,
                        config.asr_device, fallback_allowed=True,
                        _local_model=config.asr_model,
                    )
                runtime.degraded_from = ("cloud", requested)
                return runtime
            return cls(
                cloud.provider,
                cloud.resolved_model(),
                config.asr_language,
                config.asr_device,
                # ``cloud`` is a preference with a local safety net; requesting
                # a named provider is explicit and should fail loudly instead.
                fallback_allowed=requested == "cloud",
                _cloud_config=cloud,
                _local_model=config.asr_model,
            )
        if requested in {"auto", "mlx", "mlx-whisper"} and _is_apple_silicon():
            return cls(
                "mlx-whisper",
                _MLX_MODEL_ALIASES.get(config.asr_model, config.asr_model),
                config.asr_language,
                config.asr_device,
                fallback_allowed=requested == "auto",
            )
        if requested in {"mlx", "mlx-whisper"}:
            return cls("mlx-whisper", _MLX_MODEL_ALIASES.get(config.asr_model, config.asr_model), config.asr_language, config.asr_device)
        return cls("faster-whisper", config.asr_model, config.asr_language, config.asr_device)

    @property
    def enabled(self) -> bool:
        return self.backend != "cache"

    @property
    def backend_id(self) -> str:
        return f"{self.backend}:{self.model}"

    def public(self) -> dict[str, Any]:
        return {
            "backend": self.backend,
            "model": self.model,
            "language": self.language,
            "apple_silicon": _is_apple_silicon(),
        }

    def transcribe(self, clip: Clip, store: TranscriptStore, initial_prompt: str = "") -> Transcript:
        if not self.enabled:
            raise RuntimeError("ASR backend=cache，不能主动转写")
        if self._cloud_config is not None:
            try:
                return CloudASRProvider(self._cloud_config).transcribe(clip, store, initial_prompt)
            except Exception:
                if not self.fallback_allowed:
                    raise
                # Never log the raw exception: a provider error may echo the
                # API key.  Only the clip identity and provider are safe here.
                import logging

                logging.getLogger("mirrororder.asr").warning(
                    "云端转写失败，降级为本地 ASR：%s（%s）", clip.clip_id, self._cloud_config.provider
                )
                self._switch_to_local_after_cloud_failure()
        if self.backend == "mlx-whisper":
            try:
                transcript = self._transcribe_mlx(clip, store, initial_prompt)
                return self._with_degrade_marker(transcript)
            except ResourceCancelled:
                raise
            except Exception:
                if not self.fallback_allowed:
                    raise
                # MLX 降级要留下可发现的痕迹：换名字必须可还原，且降级记录
                # 写进转写缓存，否则同一项目里会混入两种无法区分的 backend。
                import logging

                logging.getLogger("mirrororder.asr").warning(
                    "MLX 转写失败，本次起降级为 faster-whisper：%s", clip.clip_id
                )
                original_model = self.model
                self.backend = "faster-whisper"
                self.model = self.model.split("/")[-1].replace("whisper-", "").replace("-mlx", "")
                if self.model == "large-v3-turbo":
                    self.model = "large-v3-turbo"
                self.degraded_from = ("mlx-whisper", original_model)
        transcript = self._transcribe_faster(clip, store, initial_prompt)
        return self._with_degrade_marker(transcript)

    def _switch_to_local_after_cloud_failure(self) -> None:
        """Switch this runtime to a local backend and leave a discoverable mark."""
        failed = f"{self._cloud_config.provider}:{self.model}"
        self.degraded_from = ("cloud", failed)
        self._cloud_config = None
        if _is_apple_silicon():
            self.backend = "mlx-whisper"
            self.model = _MLX_MODEL_ALIASES.get(self._local_model, self._local_model)
        else:
            self.backend = "faster-whisper"
            self.model = self._local_model

    def _marked_backend(self) -> str:
        degraded = getattr(self, "degraded_from", None)
        if not degraded:
            return self.backend_id
        if degraded[0] == "cloud":
            return f"{self.backend_id}（云端 {degraded[1]} 失败已降级本地）"
        return f"{self.backend_id}（已从 mlx 降级；原模型 {degraded[1]}）"

    def _with_degrade_marker(self, transcript: Transcript) -> Transcript:
        marked = self._marked_backend()
        if transcript.backend == marked:
            return transcript
        return replace(transcript, backend=marked)

    def _transcribe_mlx(self, clip: Clip, store: TranscriptStore, initial_prompt: str) -> Transcript:
        _configure_model_cache()
        small = self.model == _MLX_MODEL_ALIASES["small"]
        try:
            import mlx_whisper  # type: ignore
        except ImportError:
            if not small or os.environ.get("MIRRORORDER_PACKAGED_RUNTIME") != "1":
                raise
            segments = transcribe_local(clip.media_path, self.language, self.cancelled or (lambda: False))
            return self._write_result(clip, store, [segment["text"] for segment in segments], segments)

        cached_model = cached_small_model(application_support_root()) if small else None
        result = mlx_whisper.transcribe(
            clip.media_path,
            path_or_hf_repo=str(cached_model) if cached_model else self.model,
            language=self.language or None,
            word_timestamps=True,
            verbose=None,
            initial_prompt=initial_prompt or None,
        )
        segments: list[dict[str, Any]] = []
        texts: list[str] = []
        for item in result.get("segments", []) if isinstance(result, dict) else []:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text", "") or "").strip()
            if not text:
                continue
            texts.append(text)
            row: dict[str, Any] = {
                "start": float(item.get("start", 0) or 0),
                "end": float(item.get("end", item.get("start", 0)) or 0),
                "text": text,
            }
            words = []
            for word in item.get("words", []) or []:
                if not isinstance(word, dict):
                    continue
                words.append({
                    "start": float(word.get("start", 0) or 0),
                    "end": float(word.get("end", word.get("start", 0)) or 0),
                    "word": str(word.get("word", "") or ""),
                })
            if words:
                row["words"] = words
            segments.append(row)
        return self._write_result(clip, store, texts, segments)

    def _transcribe_faster(self, clip: Clip, store: TranscriptStore, initial_prompt: str) -> Transcript:
        if self._faster_model is None:
            from faster_whisper import WhisperModel  # type: ignore

            self._faster_model = WhisperModel(self.model, device=self.device, compute_type="auto")
        result, _info = self._faster_model.transcribe(
            clip.media_path,
            language=self.language,
            word_timestamps=True,
            vad_filter=True,
            initial_prompt=initial_prompt or None,
        )
        segments: list[dict[str, Any]] = []
        texts: list[str] = []
        for item in result:
            text = str(getattr(item, "text", "") or "").strip()
            if not text:
                continue
            texts.append(text)
            row: dict[str, Any] = {"start": float(item.start), "end": float(item.end), "text": text}
            words = []
            for word in getattr(item, "words", []) or []:
                words.append({"start": float(word.start), "end": float(word.end), "word": str(word.word)})
            if words:
                row["words"] = words
            segments.append(row)
        return self._write_result(clip, store, texts, segments)

    def _write_result(
        self,
        clip: Clip,
        store: TranscriptStore,
        texts: list[str],
        segments: list[dict[str, Any]],
    ) -> Transcript:
        text = "".join(texts)
        error = "" if text.strip() or segments else "no_speech_or_only_production_command"
        backend_label = self._marked_backend()
        store.write(clip, text, segments, backend=backend_label, error=error)
        typed_segments = tuple(
            TranscriptSegment(float(item["start"]), float(item["end"]), str(item["text"]))
            for item in segments
            if str(item.get("text", "")).strip()
        )
        return Transcript(
            clip_id=clip.clip_id,
            source_clip=clip.name,
            fingerprint=transcript_fingerprint(clip),
            text=text,
            segments=typed_segments,
            backend=backend_label,
            error=error,
        )
