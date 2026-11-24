"""统一多模态客户端与六个调用方的路由、错误码、脱敏透传测试。"""
from __future__ import annotations

import base64
import json
import urllib.error
from pathlib import Path
from unittest import mock

import pytest

from script_organizer import model_connections
from script_organizer.audit_provider import TakeAuditProvider
from script_organizer.clapperboard_ocr import extract_clapperboard_proposal
from script_organizer.model_provider import ModelProvider, ModelProviderConfig
from script_organizer.model_registry import AssistantLanguageModel, AssistantModelConfig
from script_organizer.multimodal_client import (
    MultimodalConfig,
    call_multimodal,
    parse_json_array,
    parse_json_object,
    strip_markdown_fence,
)
from script_organizer.paper_vlm_intake import extract_paper_slate_photo_candidates
from script_organizer.take_semantic_provider import TakeSemanticProvider
from script_organizer.vision_provider import VisionProvider, VisionProviderConfig

_JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32 + b"\xff\xd9"
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
)
_PNG_URI = "data:image/png;base64," + base64.b64encode(_PNG).decode("ascii")
_MODEL_ENV = (
    "MIRRORORDER_MODEL_PROVIDER",
    "MIRRORORDER_MODEL_BASE_URL",
    "MIRRORORDER_MODEL_API_KEY",
    "MIRRORORDER_MODEL_NAME",
)


class _FakeResponse:
    def __init__(self, payload: object):
        self._body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return self._body


def _openai_config(api_key: str = "SECRET-KEY") -> MultimodalConfig:
    return MultimodalConfig(
        provider="openai-compatible",
        base_url="http://127.0.0.1:9/v1",
        api_key=api_key,
        model="vision-model",
        timeout_seconds=5,
    )


def _gemini_config() -> MultimodalConfig:
    return MultimodalConfig(
        provider="gemini",
        base_url="https://generativelanguage.googleapis.com",
        api_key="GEMINI-KEY",
        model="models/gemini-4-hydrogen",
        timeout_seconds=5,
    )


def _vision_openai_config(api_key: str = "LEAKKEY") -> VisionProviderConfig:
    return VisionProviderConfig(
        provider="openai-compatible",
        base_url="http://127.0.0.1:9/v1",
        api_key=api_key,
        model="vision-model",
        timeout_seconds=5,
    )


def _clear_model_env(monkeypatch) -> None:
    for name in _MODEL_ENV:
        monkeypatch.delenv(name, raising=False)


# --- 统一客户端路由 -------------------------------------------------------


def test_openai_route_sends_chat_completions_with_images_and_auth() -> None:
    captured: dict[str, object] = {}

    def fake_urlopen(request, timeout=0):
        captured["url"] = request.full_url
        captured["headers"] = dict(request.header_items())
        captured["body"] = json.loads(request.data)
        return _FakeResponse({"choices": [{"message": {"content": '{"ok":true}'}}]})

    with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
        result = call_multimodal(
            _openai_config(), system="系统", context={"q": "第4场"},
            images=[(_JPEG, "image/jpeg")],
        )

    assert result.ok and result.text == '{"ok":true}'
    assert captured["url"] == "http://127.0.0.1:9/v1/chat/completions"
    assert captured["headers"]["Authorization"] == "Bearer SECRET-KEY"
    body = captured["body"]
    assert body["model"] == "vision-model"
    content = body["messages"][1]["content"]
    assert content[0] == {"type": "text", "text": '{"q": "第4场"}'}
    assert content[1]["image_url"]["url"] == "data:image/jpeg;base64," + base64.b64encode(_JPEG).decode("ascii")


def test_gemini_route_sends_text_only_interactions_payload() -> None:
    captured: dict[str, object] = {}

    def fake_urlopen(request, timeout=0):
        captured["url"] = request.full_url
        captured["headers"] = dict(request.header_items())
        captured["body"] = json.loads(request.data)
        return _FakeResponse({"output_text": "纯文本回答"})

    with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
        result = call_multimodal(_gemini_config(), system="系统", context="问题")

    assert result.ok and result.text == "纯文本回答"
    assert captured["url"] == "https://generativelanguage.googleapis.com/v1beta/interactions"
    assert captured["headers"]["X-goog-api-key"] == "GEMINI-KEY"
    assert "Authorization" not in captured["headers"]
    body = captured["body"]
    assert body["model"] == "gemini-4-hydrogen"  # models/ 前缀按协议剥离
    assert body["input"] == [{"type": "text", "text": "问题"}]
    assert body["system_instruction"] == "系统"
    assert body["store"] is False


def test_gemini_route_sends_image_parts() -> None:
    captured: dict[str, object] = {}

    def fake_urlopen(request, timeout=0):
        captured["body"] = json.loads(request.data)
        return _FakeResponse({"outputs": [{"type": "text", "text": "已识别"}]})

    with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
        result = call_multimodal(
            _gemini_config(), system="", context={"task": "看板"},
            images=[(_JPEG, "image/jpeg")],
        )

    assert result.ok and result.text == "已识别"
    parts = captured["body"]["input"]
    assert [part["type"] for part in parts] == ["text", "image"]
    assert parts[1]["mime_type"] == "image/jpeg"
    assert parts[1]["data"] == base64.b64encode(_JPEG).decode("ascii")


def test_local_route_rejects_undownloaded_model_without_starting_server() -> None:
    fake_runtime = mock.MagicMock()
    fake_runtime.model_downloaded.return_value = False
    with mock.patch(
        "script_organizer.local_vision_runtime.LocalVisionRuntime", return_value=fake_runtime
    ), mock.patch("urllib.request.urlopen") as urlopen:
        result = call_multimodal(
            MultimodalConfig(provider="llama-server", model="local.gguf"),
            system="系统", context={},
        )

    assert not result.ok
    assert result.error_code == "local_model_not_downloaded"
    assert "尚未下载" in result.error_detail
    fake_runtime.ensure_server.assert_not_called()
    urlopen.assert_not_called()


def test_local_route_uses_llama_server_endpoint_once_downloaded() -> None:
    fake_runtime = mock.MagicMock()
    fake_runtime.model_downloaded.return_value = True
    fake_runtime.ensure_server.return_value = "http://127.0.0.1:1234"
    captured: dict[str, object] = {}

    def fake_urlopen(request, timeout=0):
        captured["url"] = request.full_url
        return _FakeResponse({
            "choices": [{"message": {"content": json.dumps({"ok": True})}}]
        })

    with mock.patch(
        "script_organizer.local_vision_runtime.LocalVisionRuntime", return_value=fake_runtime
    ), mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
        result = call_multimodal(
            MultimodalConfig(provider="local", model="local.gguf"),
            system="系统", context={},
        )

    assert result.ok
    fake_runtime.ensure_server.assert_called_once_with()
    assert captured["url"] == "http://127.0.0.1:1234/v1/chat/completions"


# --- 错误码与脱敏 ---------------------------------------------------------


@pytest.mark.parametrize(
    ("error", "code", "hint"),
    [
        (urllib.error.HTTPError("url", 401, "SECRET-KEY用来鉴权", {}, None), "http_401", "401"),
        (urllib.error.HTTPError("url", 404, "SECRET-KEY-not-found", {}, None), "http_404", "404"),
        (urllib.error.HTTPError("url", 429, "rate-limit-SECRET-KEY", {}, None), "http_429", "429"),
        (TimeoutError("/Users/muee/SECRET-KEY"), "timeout", "超时"),
        (urllib.error.URLError("/Volumes/RAW/SECRET-KEY"), "network_error", "无法连接"),
    ],
)
def test_error_codes_are_stable_and_details_are_scrubbed(error, code: str, hint: str) -> None:
    with mock.patch("urllib.request.urlopen", side_effect=error):
        result = call_multimodal(_openai_config(), system="系统", context={})

    assert not result.ok
    assert result.error_code == code
    assert hint in result.error_detail
    serialized = json.dumps(result.to_dict(), ensure_ascii=False)
    assert "SECRET-KEY" not in serialized
    assert "/Users/" not in serialized
    assert "/Volumes/" not in serialized


def test_malformed_json_response_is_invalid_json_not_raised() -> None:
    class _BadResponse(_FakeResponse):
        def read(self) -> bytes:
            return b"not json"

    with mock.patch("urllib.request.urlopen", return_value=_BadResponse({})):
        result = call_multimodal(_openai_config(), system="系统", context={})

    assert not result.ok
    assert result.error_code == "invalid_json"


# --- 解析辅助函数 ---------------------------------------------------------


def test_markdown_fence_and_json_helpers() -> None:
    assert strip_markdown_fence("```text\n请先核对 B 机。\n```") == "请先核对 B 机。"
    assert strip_markdown_fence("```json\n{\"a\": 1}\n```") == '{"a": 1}'
    assert strip_markdown_fence("~~~json\n[1, 2]\n~~~") == "[1, 2]"
    assert parse_json_object('说明\n```json\n{"a": 1}\n```\n以上') == {"a": 1}
    assert parse_json_array('前言 [{"a": 1}, {"a": 2}] 后记') == [{"a": 1}, {"a": 2}]
    assert parse_json_object("没有 JSON") is None
    assert parse_json_array("没有 JSON") is None


# --- ModelProvider 环境变量优先 / 设置页回退 ------------------------------


def test_model_provider_env_takes_priority(monkeypatch, tmp_path: Path) -> None:
    _clear_model_env(monkeypatch)
    monkeypatch.setenv("MIRRORORDER_MODEL_PROVIDER", "openai-compatible")
    monkeypatch.setenv("MIRRORORDER_MODEL_BASE_URL", "https://env.example/v1")
    monkeypatch.setenv("MIRRORORDER_MODEL_API_KEY", "env-key")
    monkeypatch.setenv("MIRRORORDER_MODEL_NAME", "env-model")
    with mock.patch.object(model_connections, "application_support_root", return_value=tmp_path):
        config = ModelProviderConfig.from_env()

    assert config.provider == "openai-compatible"
    assert config.base_url == "https://env.example/v1"
    assert config.api_key == "env-key"
    assert config.model == "env-model"
    assert config.enabled


def test_model_provider_env_none_overrides_saved_connection(monkeypatch, tmp_path: Path) -> None:
    _clear_model_env(monkeypatch)
    with mock.patch.object(model_connections, "application_support_root", return_value=tmp_path):
        model_connections.save_model_connections({
            "text": {
                "enabled": True, "provider": "gemini", "base_url": "",
                "model": "saved-model", "api_key": "saved-key",
            }
        })
        monkeypatch.setenv("MIRRORORDER_MODEL_PROVIDER", "none")
        config = ModelProviderConfig.from_env()

    assert not config.enabled
    assert config.public() == {"enabled": False, "provider": "none", "model": ""}


def test_model_provider_falls_back_to_enabled_text_connection(monkeypatch, tmp_path: Path) -> None:
    _clear_model_env(monkeypatch)
    with mock.patch.object(model_connections, "application_support_root", return_value=tmp_path):
        model_connections.save_model_connections({
            "text": {
                "enabled": True, "provider": "gemini", "base_url": "",
                "model": "gemini-saved", "api_key": "saved-key",
            }
        })
        config = ModelProviderConfig.from_env()

    assert config.provider == "gemini"
    assert config.model == "gemini-saved"
    assert config.api_key == "saved-key"
    assert config.enabled
    assert "saved-key" not in json.dumps(config.public())


def test_model_provider_gemini_rescue_uses_interactions_api(monkeypatch) -> None:
    _clear_model_env(monkeypatch)
    monkeypatch.setenv("MIRRORORDER_MODEL_PROVIDER", "gemini")
    monkeypatch.setenv("MIRRORORDER_MODEL_BASE_URL", "https://generativelanguage.googleapis.com")
    monkeypatch.setenv("MIRRORORDER_MODEL_API_KEY", "GEMINI-KEY")
    monkeypatch.setenv("MIRRORORDER_MODEL_NAME", "gemini-4-hydrogen")
    captured: dict[str, object] = {}

    def fake_urlopen(request, timeout=0):
        captured["url"] = request.full_url
        return _FakeResponse({
            "output_text": json.dumps(
                {"candidate_id": "C1", "confidence": 0.91, "reason": "匹配"}
            )
        })

    with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
        result = ModelProvider().rescue({"candidates": ["C1"]})

    assert result == {"candidate_id": "C1", "confidence": 0.91, "reason": "匹配"}
    assert captured["url"].endswith("/v1beta/interactions")
    assert "GEMINI-KEY" not in json.dumps(result)


# --- TakeSemanticProvider Gemini 路径 ------------------------------------


def test_take_semantic_provider_supports_gemini_parts(tmp_path: Path) -> None:
    frame = tmp_path / "frame.jpg"
    frame.write_bytes(_JPEG)
    captured: dict[str, object] = {}

    def fake_urlopen(request, timeout=0):
        captured["url"] = request.full_url
        captured["body"] = json.loads(request.data)
        return _FakeResponse({
            "output_text": json.dumps({
                "description": "仓库门口两人对话", "location": "仓库", "shot_type": "中景",
                "visible_people": ["甲", "乙"], "actions": ["对话"], "props": ["纸箱"],
                "emotion": ["紧张"], "continuity_clues": ["同一盏灯"],
                "extracted_text": "场记板 3-12", "tags": ["仓库", "对话"], "summary": "仓库对话",
            }, ensure_ascii=False)
        })

    config = VisionProviderConfig(
        provider="gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta",
        api_key="GEMINI-KEY",
        model="gemini-4-hydrogen",
        timeout_seconds=5,
    )
    with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
        result = TakeSemanticProvider(config).describe({"take": "T2"}, [frame])

    assert captured["url"].endswith("/interactions")
    parts = captured["body"]["input"]
    assert parts[0]["type"] == "text" and parts[1]["type"] == "image"
    assert result is not None
    assert result["provider"] == "gemini"
    assert result["extracted_text"] == "场记板 3-12"
    assert result["tags"] == ["仓库", "对话"]
    assert result["visible_people"] == ["甲", "乙"]
    assert "GEMINI-KEY" not in json.dumps(result, ensure_ascii=False)


# --- paper / clapperboard 错误透传 ---------------------------------------


@pytest.mark.parametrize(
    ("error", "hint"),
    [
        (urllib.error.HTTPError("url", 401, "LEAKKEY", {}, None), "401"),
        (urllib.error.HTTPError("url", 404, "LEAKKEY", {}, None), "404"),
        (urllib.error.HTTPError("url", 429, "LEAKKEY", {}, None), "429"),
        (TimeoutError("/Users/muee/LEAKKEY"), "超时"),
        (OSError("/Volumes/RAW/LEAKKEY connection refused"), "无法连接"),
    ],
)
def test_paper_and_clapperboard_surface_desensitized_failure(error, hint: str) -> None:
    config = _vision_openai_config()
    with mock.patch("urllib.request.urlopen", side_effect=error):
        paper = extract_paper_slate_photo_candidates(
            {"image_base64": _PNG_URI}, config=config
        )
        clapperboard = extract_clapperboard_proposal(
            frames=[(0.5, _JPEG)], config=config
        )

    for result in (paper, clapperboard):
        assert result["authority"] is False
        assert "请求失败" in result["warning"]
        assert hint in result["warning"]
        serialized = json.dumps(result, ensure_ascii=False)
        assert "LEAKKEY" not in serialized
        assert "/Users/" not in serialized
        assert "/Volumes/" not in serialized


# --- 边界回归：显式本地地址 / ensure_server 异常 / Gemini 默认地址 / 缺失帧 ---


def test_local_route_respects_explicit_base_url_without_managed_runtime() -> None:
    captured: dict[str, object] = {}

    def fake_urlopen(request, timeout=0):
        captured["url"] = request.full_url
        return _FakeResponse({"choices": [{"message": {"content": "本地服务回复"}}]})

    with mock.patch(
        "script_organizer.local_vision_runtime.LocalVisionRuntime"
    ) as runtime_cls, mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
        result = call_multimodal(
            MultimodalConfig(
                provider="local",
                base_url="http://127.0.0.1:11434/v1",
                model="qwen2.5vl:7b",
                timeout_seconds=5,
            ),
            system="系统",
            context="测试",
        )

    assert result.ok and result.text == "本地服务回复"
    assert captured["url"] == "http://127.0.0.1:11434/v1/chat/completions"
    runtime_cls.assert_not_called()


def test_local_route_catches_ensure_server_failure_without_crash() -> None:
    fake_runtime = mock.MagicMock()
    fake_runtime.model_downloaded.return_value = True
    fake_runtime.ensure_server.side_effect = RuntimeError("/Users/muee/bin/llama-server failed")

    with mock.patch(
        "script_organizer.local_vision_runtime.LocalVisionRuntime", return_value=fake_runtime
    ):
        result = call_multimodal(
            MultimodalConfig(provider="local", model="local.gguf"),
            system="系统",
            context={},
        )

    assert not result.ok
    assert result.error_code == "local_server_unavailable"
    assert "/Users/" not in result.error_detail


def test_gemini_config_without_base_url_defaults_to_official_endpoint(monkeypatch) -> None:
    _clear_model_env(monkeypatch)
    monkeypatch.setenv("MIRRORORDER_MODEL_PROVIDER", "gemini")
    monkeypatch.setenv("MIRRORORDER_MODEL_API_KEY", "GEMINI-KEY")
    monkeypatch.setenv("MIRRORORDER_MODEL_NAME", "gemini-2.5-flash")

    cfg = ModelProviderConfig.from_env()
    assert cfg.enabled
    assert cfg.base_url == model_connections.DEFAULT_GEMINI_BASE_URL

    captured: dict[str, object] = {}

    def fake_urlopen(request, timeout=0):
        captured["url"] = request.full_url
        return _FakeResponse({"output_text": "ok"})

    with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
        result = call_multimodal(
            MultimodalConfig(provider="gemini", base_url="", api_key="GEMINI-KEY", model="gemini-2.5-flash"),
            system="系统",
            context="你好",
        )

    assert result.ok and result.text == "ok"
    assert captured["url"] == "https://generativelanguage.googleapis.com/v1beta/interactions"


def test_assistant_language_model_handles_ensure_server_exception_and_explicit_local_url(monkeypatch) -> None:
    fake_runtime = mock.MagicMock()
    fake_runtime.model_downloaded.return_value = True
    fake_runtime.ensure_server.side_effect = RuntimeError("boom")
    monkeypatch.setattr("script_organizer.model_registry.LocalVisionRuntime", lambda _cfg: fake_runtime)

    managed = AssistantLanguageModel(AssistantModelConfig(provider="local", model="local.gguf"))
    assert managed.complete_answer(system="回答", context={}) is None
    assert managed.last_status == {"mode": "error", "reason": "local_server_unavailable"}

    captured: dict[str, object] = {}

    def fake_urlopen(request, timeout=0):
        captured["url"] = request.full_url
        return _FakeResponse({"choices": [{"message": {"content": "直接连本地 Ollama"}}]})

    explicit = AssistantLanguageModel(
        AssistantModelConfig(provider="local", base_url="http://127.0.0.1:11434/v1", model="qwen3:8b")
    )
    with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
        answer = explicit.complete_answer(system="回答", context={})

    assert answer == "直接连本地 Ollama"
    assert captured["url"] == "http://127.0.0.1:11434/v1/chat/completions"


def test_vision_and_semantic_providers_skip_call_when_all_frames_missing(tmp_path: Path) -> None:
    missing = tmp_path / "does-not-exist.jpg"
    config = _vision_openai_config()
    with mock.patch("urllib.request.urlopen") as urlopen:
        assert VisionProvider(config).rescue({"candidates": []}, [missing]) is None
        assert TakeSemanticProvider(config).describe({"take": "T1"}, [missing]) is None
    urlopen.assert_not_called()


@pytest.mark.parametrize("provider", ["openai-compatible", "gemini"])
def test_take_audit_provider_routes_through_multimodal_client(tmp_path: Path, provider: str) -> None:
    frame = tmp_path / "cam_a.jpg"
    frame.write_bytes(_JPEG)
    captured: dict[str, object] = {}

    payload = {
        "verdict": "disagree",
        "confidence": 0.88,
        "reason": "B 机处于反应镜头",
        "issues": [{"code": "angle_mismatch", "severity": "warning", "detail": "镜头人物未开口"}],
        "angles": [{"clip_id": "CA", "camera": "A", "shot_type": "closeup", "coverage_role": "reaction"}],
        "rough_cut": {"technical_usability": "good", "take_completeness": "complete"},
    }

    def fake_urlopen(request, timeout=0):
        captured["url"] = request.full_url
        captured["body"] = json.loads(request.data)
        if provider == "gemini":
            return _FakeResponse({"output_text": json.dumps(payload, ensure_ascii=False)})
        return _FakeResponse({"choices": [{"message": {"content": json.dumps(payload, ensure_ascii=False)}}]})

    config = VisionProviderConfig(
        provider=provider,
        base_url="https://generativelanguage.googleapis.com" if provider == "gemini" else "http://127.0.0.1:9/v1",
        api_key="AUDIT-KEY",
        model="gemini-2.5-flash" if provider == "gemini" else "audit-vlm",
        timeout_seconds=5,
    )
    context = {
        "take": "T1",
        "people": {"speakers": [{"identity_id": "spk_secret", "label": "声音 01"}]},
    }
    frames = [{"path": str(frame), "clip_id": "CA", "camera": "A", "source_time": 1.25}]

    with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
        result = TakeAuditProvider(config).audit(context, frames)

    assert result is not None
    assert result["verdict"] == "disagree"
    assert result["provider"] == provider
    assert result["angles"] == [
        {
            "clip_id": "CA",
            "camera": "A",
            "shot_type": "closeup",
            "visible_people": [],
            "technical_issues": [],
            "coverage_role": "reaction",
        }
    ]
    serialized_req = json.dumps(captured["body"], ensure_ascii=False)
    assert "spk_secret" not in serialized_req
    assert "frame 1: clip_id=CA camera=A source_time=1.25" in serialized_req
    if provider == "gemini":
        assert str(captured["url"]).endswith("/v1beta/interactions")
        parts = captured["body"]["input"]
        assert [part["type"] for part in parts] == ["text", "text", "image"]
    else:
        assert str(captured["url"]).endswith("/v1/chat/completions")
        parts = captured["body"]["messages"][1]["content"]
        assert [part["type"] for part in parts] == ["text", "text", "image_url"]
