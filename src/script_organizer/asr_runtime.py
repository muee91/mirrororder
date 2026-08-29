from __future__ import annotations

import os
import platform
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import ProjectConfig
from .device_runtime_settings import application_support_root
from .models import Clip, Transcript, TranscriptSegment
from .script_parser import parse_script
from .transcript import TranscriptStore, transcript_fingerprint


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


def script_asr_prompt(script_path: str | Path, max_speakers: int = 80) -> str:
    """Build a small vocabulary prompt from script speaker names.

    The prompt is deliberately small: it improves proper-name recognition without
    leaking whole dialogue lines into ASR and then mistaking prompted text for
    acoustic evidence.
    """
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

    @classmethod
    def from_config(cls, config: ProjectConfig) -> "ASRRuntime":
        requested = str(config.asr_backend or "auto").strip().lower()
        if requested == "cache":
            return cls("cache", config.asr_model, config.asr_language, config.asr_device)
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
        if self.backend == "mlx-whisper":
            try:
                return self._transcribe_mlx(clip, store, initial_prompt)
            except Exception:
                if not self.fallback_allowed:
                    raise
                self.backend = "faster-whisper"
                self.model = self.model.split("/")[-1].replace("whisper-", "").replace("-mlx", "")
                if self.model == "large-v3-turbo":
                    self.model = "large-v3-turbo"
        return self._transcribe_faster(clip, store, initial_prompt)

    def _transcribe_mlx(self, clip: Clip, store: TranscriptStore, initial_prompt: str) -> Transcript:
        _configure_model_cache()
        import mlx_whisper  # type: ignore

        result = mlx_whisper.transcribe(
            clip.media_path,
            path_or_hf_repo=self.model,
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
        store.write(clip, text, segments, backend=self.backend_id, error=error)
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
            backend=self.backend_id,
            error=error,
        )
