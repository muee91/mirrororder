"""Cloud ASR providers and non-authoritative audio role hints.

Every network call and ffmpeg invocation is mocked; no real provider, binary or
media file is required.  Secrets are synthetic test strings only.
"""
from __future__ import annotations

import base64
import json
import logging
import wave
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace

import pytest

import script_organizer.asr_runtime as asr_runtime
import script_organizer.cloud_asr_provider as cloud_asr_provider
from script_organizer.cloud_asr_provider import CloudASRConfig, CloudASRProvider
from script_organizer.config import ProjectConfig
from script_organizer.media_identity import media_id_for_path
from script_organizer.models import Clip
from script_organizer.recording_inventory import discover_recordings
from script_organizer.transcript import TranscriptStore


def _clip(tmp_path: Path, name: str = "A001.wav") -> Clip:
    source = tmp_path / name
    source.write_bytes(b"RIFFfake-audio-bytes")
    return Clip(
        clip_id="clip-1",
        name=name,
        camera="A",
        media_path=str(source),
        timeline_start=Fraction(0),
        timeline_end=Fraction(1),
        duration=Fraction(1),
        exists=True,
        media_id="media-1",
    )


def _store(tmp_path: Path) -> TranscriptStore:
    return TranscriptStore(tmp_path / "transcripts")


def _config(tmp_path: Path, backend: str) -> ProjectConfig:
    return ProjectConfig(
        config_path=tmp_path / "project.toml",
        name="synthetic",
        fcpxml=None,
        script=None,
        output_dir=tmp_path / "out",
        transcript_dir=tmp_path / "transcripts",
        asr_backend=backend,
        asr_model="small",
    )


def _write_wav(path: Path, frames: int = 48000, *, rate: int = 48000, channels: int = 1) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\x00\x00" * frames)


# --------------------------------------------------------------------------
# Gemini Interactions audio request
# --------------------------------------------------------------------------


def test_gemini_audio_interactions_request_and_json_segments(tmp_path: Path, monkeypatch) -> None:
    clip = _clip(tmp_path)
    store = _store(tmp_path)
    captured: dict = {}

    def fake_request(**kwargs):
        captured.update(kwargs)
        parts = kwargs["input_payload"]
        assert kwargs["model"] == "gemini-4-hydrogen"
        assert kwargs["api_key"] == "gemini-secret-key"
        assert len(parts) == 2
        assert parts[0]["type"] == "text"
        assert parts[0]["text"].startswith(cloud_asr_provider._TRANSCRIBE_INSTRUCTION)
        assert "人物：甲" in parts[0]["text"]
        assert parts[1]["type"] == "audio"
        assert parts[1]["mime_type"] == "audio/wav"
        assert base64.b64decode(parts[1]["data"]) == b"RIFFfake-audio-bytes"
        return (
            '```json\n{"segments":['
            '{"start":0.0,"end":1.25,"text":"你好"},'
            '{"start":1.25,"end":2.0,"text":"世界"}]}\n```'
        )

    monkeypatch.setattr(cloud_asr_provider.model_connections, "gemini_interactions_request", fake_request)
    # A legacy model in device config must never be sent to the provider.
    config = CloudASRConfig(
        provider="gemini",
        api_key="gemini-secret-key",
        base_url="https://generativelanguage.googleapis.com",
        model="gemini-2.5-pro",
    )
    result = CloudASRProvider(config).transcribe(clip, store, initial_prompt="人物：甲")

    assert captured["timeout_seconds"] == 120
    assert result.backend == "gemini:gemini-4-hydrogen"
    assert result.text == "你好世界"
    assert [segment.start for segment in result.segments] == [0.0, 1.25]
    assert [segment.end for segment in result.segments] == [1.25, 2.0]
    cached = (tmp_path / "transcripts" / "media-1.json").read_text(encoding="utf-8")
    assert "gemini-secret-key" not in json.dumps(result.to_dict())
    assert "gemini-secret-key" not in cached
    assert json.loads(cached)["backend"] == "gemini:gemini-4-hydrogen"


# --------------------------------------------------------------------------
# OpenAI-compatible multipart transcription
# --------------------------------------------------------------------------


def test_openai_multipart_transcription_and_verbose_json_segments(tmp_path: Path, monkeypatch) -> None:
    clip = _clip(tmp_path)
    store = _store(tmp_path)
    captured: dict = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self) -> bytes:
            return json.dumps({
                "text": "你好世界",
                "segments": [
                    {"start": 0.0, "end": 0.5, "text": "你好"},
                    {"start": 0.5, "end": 1.0, "text": "世界"},
                ],
            }).encode("utf-8")

    def fake_urlopen(request, timeout=None):
        captured["request"] = request
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr(cloud_asr_provider.urllib.request, "urlopen", fake_urlopen)
    config = CloudASRConfig(
        provider="openai",
        api_key="sk-openai-secret-key",
        base_url="https://api.openai.com/v1",
        model="gpt-4o-mini-transcribe",
    )
    result = CloudASRProvider(config).transcribe(clip, store)

    request = captured["request"]
    assert request.get_method() == "POST"
    assert request.full_url == "https://api.openai.com/v1/audio/transcriptions"
    headers = dict(request.header_items())
    assert headers["Authorization"] == "Bearer sk-openai-secret-key"
    # urllib.capitalize() turns "Content-Type" into "Content-type".
    assert headers["Content-type"].startswith("multipart/form-data; boundary=")
    body = request.data.decode("utf-8", errors="replace")
    assert 'name="model"' in body and "gpt-4o-mini-transcribe" in body
    assert 'name="response_format"' in body and "verbose_json" in body
    assert 'name="file"' in body and 'filename="A001.wav"' in body
    assert result.backend == "openai:gpt-4o-mini-transcribe"
    assert result.text == "你好世界"
    assert [segment.end for segment in result.segments] == [0.5, 1.0]
    cached = (tmp_path / "transcripts" / "media-1.json").read_text(encoding="utf-8")
    assert "sk-openai-secret-key" not in cached
    assert "sk-openai-secret-key" not in json.dumps(result.to_dict())


# --------------------------------------------------------------------------
# Runtime routing and degradation
# --------------------------------------------------------------------------


def test_from_config_cloud_routes_configured_provider_and_keeps_auto(tmp_path: Path, monkeypatch) -> None:
    connections = {
        "text": {
            "provider": "gemini",
            "base_url": "https://generativelanguage.googleapis.com",
            "model": "gemini-4-hydrogen",
            "api_key": "device-only-key",
        },
        "vision": {},
        "embedding": {},
    }
    monkeypatch.setattr(
        asr_runtime.model_connections,
        "load_model_connections",
        lambda **kwargs: connections,
    )
    monkeypatch.setattr(asr_runtime, "_is_apple_silicon", lambda: False)

    cloud = asr_runtime.ASRRuntime.from_config(_config(tmp_path, "cloud"))
    assert cloud.backend == "gemini"
    assert cloud.model == "gemini-4-hydrogen"
    assert cloud.fallback_allowed is True
    assert cloud._cloud_config.api_key == "device-only-key"
    assert "device-only-key" not in json.dumps(cloud.public())

    explicit = asr_runtime.ASRRuntime.from_config(_config(tmp_path, "gemini"))
    assert explicit.fallback_allowed is False
    assert explicit.backend == "gemini"

    auto = asr_runtime.ASRRuntime.from_config(_config(tmp_path, "auto"))
    assert auto.backend == "faster-whisper"
    assert auto.model == "small"
    assert auto._cloud_config is None


def test_cloud_failure_degrades_to_local_with_marker_and_without_key_leak(
    tmp_path: Path, monkeypatch, caplog
) -> None:
    clip = _clip(tmp_path)
    store = _store(tmp_path)
    secret = "sk-leak-me-123456"

    def failing_provider(config):
        def transcribe(*args, **kwargs):
            raise RuntimeError("upstream echoed x-goog-api-key " + secret)
        return SimpleNamespace(transcribe=transcribe)

    monkeypatch.setattr(asr_runtime, "CloudASRProvider", failing_provider)
    monkeypatch.setattr(asr_runtime, "_is_apple_silicon", lambda: False)
    monkeypatch.setattr(
        asr_runtime.ASRRuntime,
        "_transcribe_faster",
        lambda self, clip, store, initial_prompt: self._write_result(
            clip, store, ["本地"], [{"start": 0.0, "end": 1.0, "text": "本地"}]
        ),
    )

    runtime = asr_runtime.ASRRuntime(
        "gemini",
        "gemini-4-hydrogen",
        "zh",
        fallback_allowed=True,
        _cloud_config=CloudASRConfig(provider="gemini", api_key=secret, model="gemini-4-hydrogen"),
        _local_model="small",
    )
    with caplog.at_level(logging.WARNING, logger="mirrororder.asr"):
        result = runtime.transcribe(clip, store)

    assert result.text == "本地"
    assert runtime.backend == "faster-whisper"
    assert runtime._cloud_config is None
    assert "失败已降级本地" in result.backend
    assert "gemini:gemini-4-hydrogen" in result.backend
    assert secret not in caplog.text
    assert secret not in json.dumps(result.to_dict())
    cached = (tmp_path / "transcripts" / "media-1.json").read_text(encoding="utf-8")
    assert secret not in cached
    assert "失败已降级本地" in json.loads(cached)["backend"]


def test_cloud_failure_without_fallback_raises(tmp_path: Path, monkeypatch) -> None:
    clip = _clip(tmp_path)
    store = _store(tmp_path)

    def failing_provider(config):
        def transcribe(*args, **kwargs):
            raise RuntimeError("cloud unavailable")
        return SimpleNamespace(transcribe=transcribe)

    monkeypatch.setattr(asr_runtime, "CloudASRProvider", failing_provider)
    runtime = asr_runtime.ASRRuntime(
        "gemini",
        "gemini-4-hydrogen",
        "zh",
        fallback_allowed=False,
        _cloud_config=CloudASRConfig(provider="gemini", api_key="unused", model="gemini-4-hydrogen"),
    )
    with pytest.raises(RuntimeError, match="cloud unavailable"):
        runtime.transcribe(clip, store)


# --------------------------------------------------------------------------
# Recording inventory role hints (read-only)
# --------------------------------------------------------------------------


def test_discover_recordings_attaches_role_hints_without_dropping_files(tmp_path: Path) -> None:
    root = tmp_path / "media"
    _write_wav(root / "BGM_01.wav", frames=2400)
    _write_wav(root / "T01_Zoom.wav", frames=48000)

    result = discover_recordings(
        (root,), output=tmp_path / "out", roles={}, check_cancelled=lambda: None
    )
    rows = {row["media_id"]: row for row in result["candidates"]}
    bgm = rows[media_id_for_path(root / "BGM_01.wav")]
    zoom = rows[media_id_for_path(root / "T01_Zoom.wav")]

    assert result["contract"] == "recording_inventory.v1"
    assert len(rows) == 2
    assert result["derived_candidates_excluded"] == 0
    assert result["explicitly_excluded"] == 0
    assert bgm["status"] == "unverified_candidate" and zoom["status"] == "unverified_candidate"
    assert bgm["audio_role_hint"]["role"] == "music"
    assert bgm["audio_role_hint"]["sync_eligible"] is False
    assert zoom["audio_role_hint"]["role"] == "sync_recording"
    assert zoom["audio_role_hint"]["sync_eligible"] is True
    # Both files survive: a hint is never a silent exclusion.
    assert (root / "BGM_01.wav").is_file()
    assert (root / "T01_Zoom.wav").is_file()
    assert all("audio_role_hint" in row for row in rows.values())


def test_discover_recordings_uses_wav_duration_for_plain_audio_hint(tmp_path: Path) -> None:
    root = tmp_path / "media"
    _write_wav(root / "plain-take.wav", frames=960)  # 0.02s at 48kHz

    result = discover_recordings(
        (root,), output=tmp_path / "out", roles={}, check_cancelled=lambda: None
    )
    row = result["candidates"][0]
    assert row["sample_count"] == 960
    assert row["sample_rate"] == 48000
    assert row["audio_role_hint"]["role"] == "sfx"
    assert row["audio_role_hint"]["sync_eligible"] is False
