"""Cloud ASR providers: Gemini Interactions and OpenAI-compatible transcriptions.

This module is a leaf provider.  It reuses the device-local model connection
store for credentials and writes results through the existing
``TranscriptStore``.  Two invariants are enforced here:

* An API key only ever appears in an outbound request header.  It is never
  copied into a ``Transcript``, a transcript cache file, a log line or an
  exception message.
* Uploaded audio is bounded (<= 20 MB).  Video or oversized input is reduced to
  16 kHz mono audio in a temporary directory which is always removed, including
  on failure.

No provider library is imported at module import time; network I/O happens only
inside :meth:`CloudASRProvider.transcribe`.
"""
from __future__ import annotations

import base64
import json
import re
import subprocess
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from . import model_connections
from .models import Clip, Transcript, TranscriptSegment
from .transcript import TranscriptStore, transcript_fingerprint

DEFAULT_GEMINI_MODEL = "gemini-4-hydrogen"
DEFAULT_OPENAI_MODEL = "gpt-4o-mini-transcribe"
OPENAI_FALLBACK_MODEL = "whisper-1"
MAX_AUDIO_UPLOAD_BYTES = 20 * 1024 * 1024

# Legacy Gemini models must not be selected by a cloud ASR request even if an
# old device configuration still names one.
_LEGACY_GEMINI_PREFIXES = ("gemini-2.5", "gemini-2.0", "gemini-1.5")

_TRANSCRIBE_INSTRUCTION = (
    "Transcribe this recording into timed segments. "
    'Return ONLY strict JSON: {"segments":[{"start":0.0,"end":1.2,"text":"..."}]}. '
    "start/end are seconds from the beginning of the audio; text is the spoken "
    "words in their original language. No markdown fences, no commentary."
)

# Extra defence-in-depth: even if a caller passes a key-bearing error string,
# common key shapes are scrubbed before it can reach a log or a result.
_SECRET_SHAPE = re.compile(r"(?:sk-[A-Za-z0-9_-]{6,}|AIza[A-Za-z0-9_-]{10,})")
_FENCE_START = re.compile(r"^```(?:json)?\s*")
_FENCE_END = re.compile(r"\s*```$")


def _safe_error(prefix: str, error: BaseException, *secrets: str) -> str:
    """Return a short message with every known secret removed."""
    message = f"{type(error).__name__}: {error}"
    for secret in secrets:
        if secret and len(secret) >= 4:
            message = message.replace(secret, "[REDACTED]")
    message = _SECRET_SHAPE.sub("[REDACTED]", message)
    return f"{prefix}：{message[:240]}"


def _normalize_provider(value: str) -> str:
    provider = str(value or "").strip().lower()
    if provider == "gemini":
        return "gemini"
    if provider in {"openai", "openai-compatible"}:
        return "openai"
    return ""


def _segments_from_payload(payload: object) -> tuple[str, list[dict[str, Any]]]:
    """Extract ``(text, segments)`` from a parsed JSON response."""
    if isinstance(payload, list):
        items: list[Any] = payload
    elif isinstance(payload, dict):
        items = payload.get("segments")
        if not isinstance(items, list):
            whole = str(payload.get("text", "") or "").strip()
            return whole, []
    else:
        raise RuntimeError("云端转写响应格式无效")

    segments: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text", "") or "").strip()
        if not text:
            continue
        try:
            start = float(item.get("start", item.get("start_time", 0)) or 0)
            end_value = item.get("end", item.get("end_time", start))
            end = float(end_value if end_value is not None else start)
        except (TypeError, ValueError):
            continue
        segments.append({"start": start, "end": max(start, end), "text": text})
    return "".join(segment["text"] for segment in segments), segments


def parse_cloud_transcript_json(raw: object) -> tuple[str, list[dict[str, Any]]]:
    """Parse a model's text response, tolerating a surrounding Markdown fence."""
    if not isinstance(raw, str):
        raise RuntimeError("云端转写响应不是文本")
    body = _FENCE_START.sub("", raw.strip())
    body = _FENCE_END.sub("", body).strip()
    try:
        payload = json.loads(body)
    except ValueError:
        raise RuntimeError("云端转写响应不是合法 JSON") from None
    return _segments_from_payload(payload)


@dataclass
class CloudASRConfig:
    """Resolved, device-local cloud ASR settings.  Never serialized to a project."""

    provider: str
    api_key: str = ""
    base_url: str = ""
    model: str = ""
    language: str = "zh"
    timeout_seconds: int = 120

    def resolved_model(self) -> str:
        provider = _normalize_provider(self.provider)
        model = str(self.model or "").strip()
        if provider == "gemini":
            if not model or model.startswith(_LEGACY_GEMINI_PREFIXES):
                return DEFAULT_GEMINI_MODEL
            return model.removeprefix("models/")
        if not model:
            return DEFAULT_OPENAI_MODEL
        return model

    def public(self) -> dict[str, Any]:
        """Path-free, key-free status for UI/logging."""
        return {
            "provider": _normalize_provider(self.provider),
            "model": self.resolved_model(),
            "has_api_key": bool(self.api_key),
        }


class CloudASRProvider:
    """Transcribe one clip through a configured cloud provider."""

    def __init__(self, config: CloudASRConfig):
        if _normalize_provider(config.provider) not in {"gemini", "openai"}:
            raise ValueError("仅支持 gemini 或 openai 云端转写")
        self.config = config
        self.provider = _normalize_provider(config.provider)
        self.model = config.resolved_model()

    @property
    def backend_id(self) -> str:
        return f"{self.provider}:{self.model}"

    def transcribe(self, clip: Clip, store: TranscriptStore, initial_prompt: str = "") -> Transcript:
        """Run cloud ASR and persist a standard Transcript; always clean up audio."""
        with tempfile.TemporaryDirectory(prefix="mirrororder-asr-") as temporary:
            audio_path, mime_type = self._prepare_audio(clip, Path(temporary))
            if self.provider == "gemini":
                encoded = base64.b64encode(audio_path.read_bytes()).decode("ascii")
                raw = self._gemini_transcribe(encoded, mime_type, initial_prompt)
                text, segments = parse_cloud_transcript_json(raw)
            else:
                payload = self._openai_transcribe(audio_path, mime_type)
                text, segments = _segments_from_payload(payload)

        error = "" if text.strip() or segments else "no_speech_or_only_production_command"
        store.write(clip, text, segments, backend=self.backend_id, error=error)
        typed_segments = tuple(
            TranscriptSegment(float(item["start"]), float(item["end"]), item["text"])
            for item in segments
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

    def _prepare_audio(self, clip: Clip, temporary: Path) -> tuple[Path, str]:
        """Return an uploadable audio path and its MIME type.

        Plain small WAV/MP3 files are sent as-is.  Video and oversized files are
        reduced to 16 kHz mono MP3 via ffmpeg; the converted file lives only in
        ``temporary`` and disappears when the caller's context exits.
        """
        source = Path(clip.media_path)
        if not source.is_file():
            raise RuntimeError("云端转写找不到音频源文件")
        suffix = source.suffix.lower()
        if suffix in {".wav", ".mp3"}:
            if source.stat().st_size <= MAX_AUDIO_UPLOAD_BYTES:
                return source, ("audio/wav" if suffix == ".wav" else "audio/mp3")

        target = temporary / "asr_audio.mp3"
        command = [
            "ffmpeg", "-nostdin", "-v", "error", "-y",
            "-i", str(source), "-vn", "-ac", "1", "-ar", "16000",
            "-c:a", "libmp3lame", "-b:a", "64k", str(target),
        ]
        try:
            completed = subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=self.config.timeout_seconds,
            )
        except (OSError, subprocess.SubprocessError):
            # Do not chain the original exception: its text could contain paths
            # or credentials from the caller's environment.
            raise RuntimeError("无法从媒体提取 16kHz 单声道音频") from None
        if completed.returncode != 0 or not target.is_file():
            raise RuntimeError("从媒体提取音频失败")
        if target.stat().st_size > MAX_AUDIO_UPLOAD_BYTES:
            raise RuntimeError("提取后的音频仍超过 20MB 上传上限")
        return target, "audio/mp3"

    def _gemini_transcribe(self, encoded_audio: str, mime_type: str, initial_prompt: str) -> str:
        instruction = _TRANSCRIBE_INSTRUCTION
        if initial_prompt.strip():
            instruction += "\nContext for proper names: " + initial_prompt.strip()[:500]
        payload: list[dict[str, Any]] = [
            {"type": "text", "text": instruction},
            {"type": "audio", "data": encoded_audio, "mime_type": mime_type},
        ]
        raw = model_connections.gemini_interactions_request(
            base_url=self.config.base_url,
            api_key=self.config.api_key,
            model=self.model,
            system_instruction="",
            input_payload=payload,
            timeout_seconds=self.config.timeout_seconds,
        )
        if not raw:
            raise RuntimeError("Gemini 转写未返回可用文本")
        return raw

    def _openai_transcribe(self, audio_path: Path, mime_type: str) -> dict[str, Any]:
        url = model_connections.resolve_openai_endpoint(self.config.base_url, "/audio/transcriptions")
        boundary = "----MirrorOrderASR" + uuid4().hex
        chunks: list[bytes] = []

        def add_field(name: str, value: str) -> None:
            chunks.append(
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
                f"{value}\r\n".encode("utf-8")
            )

        add_field("model", self.model)
        add_field("response_format", "verbose_json")
        if self.config.language.strip():
            add_field("language", self.config.language.strip())
        safe_filename = re.sub(r"[^A-Za-z0-9._-]", "_", audio_path.name) or "audio.mp3"
        chunks.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{safe_filename}"\r\n'
            f"Content-Type: {mime_type}\r\n\r\n".encode("utf-8")
            + audio_path.read_bytes()
            + b"\r\n"
        )
        chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
        body = b"".join(chunks)

        headers = {
            "Accept": "application/json",
            "Authorization": "Bearer " + self.config.api_key,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        }
        request = urllib.request.Request(url, data=body, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.config.timeout_seconds) as response:
                raw = response.read()
            payload = json.loads(raw.decode("utf-8"))
        except (OSError, urllib.error.URLError, ValueError, UnicodeDecodeError) as error:
            raise RuntimeError(
                _safe_error("OpenAI 转写请求失败", error, self.config.api_key)
            ) from None
        if not isinstance(payload, dict):
            raise RuntimeError("OpenAI 转写响应格式无效")
        return payload
