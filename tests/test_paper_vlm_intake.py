from __future__ import annotations

import base64
import json
from unittest import mock

import pytest

from script_organizer import paper_vlm_intake
from script_organizer.paper_vlm_intake import (
    CONTRACT_VERSION,
    MAX_IMAGE_BYTES,
    extract_paper_slate_photo_candidates,
    normalize_candidate_rows,
    validate_image_payload,
)
from script_organizer.vision_provider import VisionProviderConfig


_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
)


class _FakeResponse:
    def __init__(self, payload: object):
        self._body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.status = 200

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self) -> bytes:
        return self._body


def _data_uri(data: bytes = _PNG_BYTES, mime: str = "image/png") -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def _gemini_config() -> VisionProviderConfig:
    return VisionProviderConfig(
        provider="gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta",
        api_key="GEMINI_SECRET",
        model="gemini-4-hydrogen",
        timeout_seconds=5,
    )


def _openai_config() -> VisionProviderConfig:
    return VisionProviderConfig(
        provider="openai-compatible",
        base_url="http://127.0.0.1:9/v1",
        api_key="OPENAI_SECRET",
        model="local-vlm",
        timeout_seconds=5,
    )


def test_gemini_native_route_sends_interactions_parts() -> None:
    rows = [
        {
            "episode": "3",
            "scene": "S12",
            "shot": "C5",
            "take": "2",
            "status": "OK",
            "note": "手持特写",
            "confidence": 0.93,
            "authority": True,
        }
    ]
    fake = _FakeResponse({"output_text": json.dumps(rows, ensure_ascii=False)})
    with mock.patch("urllib.request.urlopen", return_value=fake) as urlopen:
        result = extract_paper_slate_photo_candidates(
            {"image_base64": _data_uri(), "page_label": "P2", "authority": True},
            config=_gemini_config(),
        )

    request = urlopen.call_args.args[0]
    assert "/interactions" in request.full_url
    assert request.get_header("X-goog-api-key") == "GEMINI_SECRET"
    sent = json.loads(request.data)
    assert sent["model"] == "gemini-4-hydrogen"
    assert sent["input"][0]["type"] == "text"
    assert sent["input"][1]["type"] == "image"
    assert sent["input"][1]["mime_type"] == "image/png"
    assert sent["input"][1]["data"] == base64.b64encode(_PNG_BYTES).decode("ascii")

    assert result["contract"] == CONTRACT_VERSION
    assert result["authority"] is False
    assert result["provider"] == "gemini"
    assert result["page"] == "P2"
    assert result["candidate_count"] == 1
    assert result["candidates"][0] == {
        "page": "P2",
        "row": 1,
        "episode": 3,
        "scene": "S12",
        "shot": "C5",
        "take": "2",
        "status": "usable",
        "note": "手持特写",
        "confidence": 0.93,
        "authority": False,
    }
    assert "GEMINI_SECRET" not in json.dumps(result, ensure_ascii=False)


def test_openai_compatible_route_sends_multimodal_messages() -> None:
    rows = [{"episode": 4, "scene": "场7", "shot": "镜3", "take": "1", "status": "NG", "confidence": 0.42}]
    fake = _FakeResponse({"choices": [{"message": {"content": json.dumps({"rows": rows}, ensure_ascii=False)}}]})
    with mock.patch("urllib.request.urlopen", return_value=fake) as urlopen:
        result = extract_paper_slate_photo_candidates(
            {"image_base64": base64.b64encode(_PNG_BYTES).decode("ascii")},
            config=_openai_config(),
        )

    request = urlopen.call_args.args[0]
    assert request.full_url == "http://127.0.0.1:9/v1/chat/completions"
    assert request.get_header("Authorization") == "Bearer OPENAI_SECRET"
    sent = json.loads(request.data)
    content = sent["messages"][1]["content"]
    assert content[0]["type"] == "text"
    assert content[1]["image_url"]["url"] == _data_uri()
    assert sent["messages"][0]["role"] == "system"

    assert result["provider"] == "openai-compatible"
    assert result["page"] == "1"
    assert result["candidate_count"] == 1
    row = result["candidates"][0]
    assert row["episode"] == 4
    assert row["status"] == "ng"
    assert row["confidence"] == 0.42
    assert row["authority"] is False
    assert "OPENAI_SECRET" not in json.dumps(result, ensure_ascii=False)


def test_validate_image_payload_accepts_supported_magic_bytes() -> None:
    jpeg = b"\xff\xd8\xff\xe0" + b"\x00" * 32 + b"\xff\xd9"
    webp = b"RIFF" + b"\x00" * 4 + b"WEBP" + b"VP8 " + b"\x00" * 16
    assert validate_image_payload(base64.b64encode(jpeg).decode("ascii")) == (jpeg, "image/jpeg")
    assert validate_image_payload(base64.b64encode(_PNG_BYTES).decode("ascii")) == (_PNG_BYTES, "image/png")
    assert validate_image_payload(_data_uri(webp, "image/webp"))[1] == "image/webp"


def test_validate_image_payload_rejects_invalid_magic() -> None:
    with pytest.raises(ValueError, match="仅接受 JPEG / PNG / WEBP"):
        validate_image_payload(base64.b64encode(b"this is definitely not an image").decode("ascii"))
    with pytest.raises(ValueError, match="base64"):
        validate_image_payload("!!!not-base64!!!")


def test_validate_image_payload_rejects_oversize() -> None:
    oversized = b"\xff\xd8\xff" + b"\x00" * MAX_IMAGE_BYTES
    with pytest.raises(ValueError, match="8MB"):
        validate_image_payload(base64.b64encode(oversized).decode("ascii"))


def test_extract_rejects_bad_image_without_network_call() -> None:
    with mock.patch("urllib.request.urlopen") as urlopen:
        with pytest.raises(ValueError):
            extract_paper_slate_photo_candidates(
                {"image_base64": base64.b64encode(b"nope").decode("ascii")},
                config=_openai_config(),
            )
    urlopen.assert_not_called()


def test_disabled_vision_returns_clear_error() -> None:
    with pytest.raises(ValueError, match="未启用多模态视觉模型"):
        extract_paper_slate_photo_candidates(
            {"image_base64": _data_uri()},
            config=VisionProviderConfig(),
        )


def test_messy_model_json_is_cleaned_and_authority_is_never_trusted() -> None:
    note = "现场备注" * 300
    rows = [
        {"episode": "第12集", "scene": "仓库", "shot": "C2", "take": "3", "status": "??", "note": note, "confidence": 5, "authority": True},
        {"episode": "bad", "status": "NG", "confidence": "oops", "authority": True},
        "not a row",
    ]
    messy = '模型说明：\n```json\n' + json.dumps({"candidates": rows}, ensure_ascii=False) + "\n```\n以上。\n"
    fake = _FakeResponse({"choices": [{"message": {"content": messy}}]})
    with mock.patch("urllib.request.urlopen", return_value=fake):
        result = extract_paper_slate_photo_candidates(
            {"image_base64": _data_uri(), "authority": True},
            config=_openai_config(),
        )

    assert result["authority"] is False
    assert result["candidate_count"] == 2
    first, second = result["candidates"]
    assert first["episode"] == 12
    assert first["status"] == "unmarked"
    assert first["confidence"] == 1.0
    assert len(first["note"]) <= 600
    assert first["authority"] is False
    assert second["episode"] is None
    assert second["status"] == "ng"
    assert second["confidence"] == 0.0
    assert second["authority"] is False


def test_unparseable_model_output_yields_empty_candidate_list() -> None:
    fake = _FakeResponse({"choices": [{"message": {"content": "模型拒绝回答，没有返回任何结构。"}}]})
    with mock.patch("urllib.request.urlopen", return_value=fake):
        result = extract_paper_slate_photo_candidates(
            {"image_base64": _data_uri()},
            config=_openai_config(),
        )
    assert result["candidates"] == []
    assert result["candidate_count"] == 0
    assert result["authority"] is False


def test_normalize_candidate_rows_forces_authority_false() -> None:
    rows = normalize_candidate_rows(
        [
            {"episode": True, "status": "可用", "confidence": float("nan"), "authority": True},
            {"episode": None, "status": "莫名其妙", "confidence": -3},
            42,
        ],
        page_label="7",
    )
    assert len(rows) == 2
    assert all(row["authority"] is False for row in rows)
    assert rows[0]["episode"] is None
    assert rows[0]["status"] == "usable"
    assert rows[0]["confidence"] == 0.0
    assert rows[1]["status"] == "unmarked"
    assert rows[1]["confidence"] == 0.0
    assert [row["row"] for row in rows] == [1, 2]
    assert all(row["page"] == "7" for row in rows)


def test_local_vlm_never_triggers_silent_download_when_not_downloaded() -> None:
    local_cfg = VisionProviderConfig(
        provider="local",
        base_url="",
        api_key="",
        model="mlx-community/Qwen2.5-VL-7B-Instruct-4bit",
        timeout_seconds=5,
    )
    fake_runtime = mock.MagicMock()
    fake_runtime.model_downloaded.return_value = False
    with mock.patch("script_organizer.local_vision_runtime.LocalVisionRuntime", return_value=fake_runtime):
        with pytest.raises(ValueError, match="尚未下载"):
            extract_paper_slate_photo_candidates({"image_base64": _data_uri()}, config=local_cfg)
    fake_runtime.ensure_server.assert_not_called()


def test_negative_episode_sanitized_and_upstream_failure_surfaces_warning() -> None:
    rows = normalize_candidate_rows([{"episode": -3, "status": "ok"}], page_label="1")
    assert rows[0]["episode"] is None

    with mock.patch("urllib.request.urlopen", side_effect=OSError("connection refused")):
        result = extract_paper_slate_photo_candidates(
            {"image_base64": _data_uri()},
            config=_openai_config(),
        )
    assert result["authority"] is False
    assert result["candidates"] == []
    assert "请求失败" in result["warning"]
