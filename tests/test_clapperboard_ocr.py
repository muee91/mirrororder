from __future__ import annotations

import base64
import json
import subprocess
import tempfile
from pathlib import Path
from unittest import mock

import pytest

from script_organizer.clapperboard_ocr import (
    CONTRACT_VERSION,
    extract_clapperboard_frames,
    extract_clapperboard_proposal,
)
from script_organizer.vision_provider import VisionProviderConfig


_JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32 + b"\xff\xd9"
_FRAMES: list[tuple[float, bytes]] = [(0.5, _JPEG), (2.0, _JPEG + b"2"), (4.5, _JPEG + b"3")]


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


def _gemini_config() -> VisionProviderConfig:
    return VisionProviderConfig(
        provider="gemini",
        base_url="https://generativelanguage.googleapis.com/v1beta",
        api_key="GEMINI_SECRET",
        model="gemini-4-hydrogen",
        timeout_seconds=5,
    )


def _openai_config(api_key: str = "OPENAI_SECRET") -> VisionProviderConfig:
    return VisionProviderConfig(
        provider="openai-compatible",
        base_url="http://127.0.0.1:9/v1",
        api_key=api_key,
        model="local-vlm",
        timeout_seconds=5,
    )


def _local_config() -> VisionProviderConfig:
    return VisionProviderConfig(
        provider="local",
        base_url="",
        api_key="",
        model="mlx-community/Qwen2.5-VL-7B-Instruct-4bit",
        timeout_seconds=5,
    )


def test_gemini_multiframe_interactions_detects_clapperboard_and_never_trusts_authority() -> None:
    model_payload = {
        "detected": True,
        "clapper_time_seconds": 1.25,
        "episode": "第12集",
        "scene": "S12 仓库",
        "shot": "C5",
        "take": "2",
        "camera": "A机",
        "roll": "R03",
        "slate_note": "开场打板",
        "confidence": 1.4,
        "authority": True,
    }
    fake = _FakeResponse({"output_text": json.dumps(model_payload, ensure_ascii=False)})
    with mock.patch("urllib.request.urlopen", return_value=fake) as urlopen:
        result = extract_clapperboard_proposal(frames=_FRAMES, config=_gemini_config())

    request = urlopen.call_args.args[0]
    assert "/interactions" in request.full_url
    assert "generateContent" not in request.full_url  # 禁止 legacy Gemini 端点
    assert request.get_header("X-goog-api-key") == "GEMINI_SECRET"
    sent = json.loads(request.data)
    assert sent["model"] == "gemini-4-hydrogen"
    assert sent["input"][0]["type"] == "text"
    assert "frame_times_seconds" in sent["input"][0]["text"]
    assert [part["type"] for part in sent["input"][1:]] == ["image", "image", "image"]
    assert all(part["mime_type"] == "image/jpeg" for part in sent["input"][1:])
    assert sent["input"][1]["data"] == base64.b64encode(_JPEG).decode("ascii")
    assert "JSON" in sent["system_instruction"]

    assert result["contract"] == CONTRACT_VERSION
    assert result["authority"] is False  # 模型伪造 authority=True 被强制覆盖
    assert result["detected"] is True
    assert result["clapper_time_seconds"] == 1.25
    assert result["episode"] == 12
    assert result["scene"] == "S12 仓库"
    assert result["camera"] == "A机"
    assert result["roll"] == "R03"
    assert result["confidence"] == 1.0
    assert result["provider"] == "gemini"
    assert result["model"] == "gemini-4-hydrogen"
    assert result["frames_inspected"] == 3
    assert result["warning"] == ""
    assert "GEMINI_SECRET" not in json.dumps(result, ensure_ascii=False)


def test_openai_compatible_route_send_multimodal_content_and_clean_result() -> None:
    model_payload = {
        "detected": True,
        "clapper_time_seconds": "2.0",
        "episode": 3,
        "scene": "场" * 200,
        "shot": "镜" * 200,
        "take": "T" * 100,
        "camera": "C" * 100,
        "roll": "R" * 100,
        "slate_note": "备" * 500,
        "confidence": 0.87,
    }
    fake = _FakeResponse(
        {"choices": [{"message": {"content": "说明\n```json\n" + json.dumps(model_payload, ensure_ascii=False) + "\n```"}}]}
    )
    with mock.patch("urllib.request.urlopen", return_value=fake) as urlopen:
        result = extract_clapperboard_proposal(frames=_FRAMES[:2], config=_openai_config())

    request = urlopen.call_args.args[0]
    assert request.full_url == "http://127.0.0.1:9/v1/chat/completions"
    assert request.get_header("Authorization") == "Bearer OPENAI_SECRET"
    sent = json.loads(request.data)
    assert sent["messages"][0]["role"] == "system"
    content = sent["messages"][1]["content"]
    assert content[0]["type"] == "text"
    assert len(content) == 3
    assert content[1]["image_url"]["url"] == "data:image/jpeg;base64," + base64.b64encode(_JPEG).decode("ascii")

    assert result["authority"] is False
    assert result["detected"] is True
    assert result["clapper_time_seconds"] == 2.0
    assert result["episode"] == 3
    assert result["provider"] == "openai-compatible"
    assert result["frames_inspected"] == 2
    assert len(result["scene"]) == 120
    assert len(result["shot"]) == 120
    assert len(result["take"]) == 60
    assert len(result["camera"]) == 40
    assert len(result["roll"]) == 60
    assert len(result["slate_note"]) == 400
    assert result["confidence"] == 0.87
    assert "OPENAI_SECRET" not in json.dumps(result, ensure_ascii=False)


def test_no_clapperboard_returns_detected_false_with_warning() -> None:
    fake = _FakeResponse(
        {"choices": [{"message": {"content": json.dumps({"detected": False, "confidence": 0.2})}}]}
    )
    with mock.patch("urllib.request.urlopen", return_value=fake):
        result = extract_clapperboard_proposal(frames=_FRAMES, config=_openai_config())

    assert result["detected"] is False
    assert result["clapper_time_seconds"] is None
    assert result["episode"] is None
    assert result["authority"] is False
    assert result["confidence"] == 0.2
    assert "场记板" in result["warning"]


def test_local_model_not_downloaded_rejected_without_starting_server() -> None:
    fake_runtime = mock.MagicMock()
    fake_runtime.model_downloaded.return_value = False
    with mock.patch(
        "script_organizer.local_vision_runtime.LocalVisionRuntime", return_value=fake_runtime
    ), mock.patch("urllib.request.urlopen") as urlopen:
        with pytest.raises(ValueError, match="尚未下载"):
            extract_clapperboard_proposal(frames=_FRAMES, config=_local_config())

    fake_runtime.ensure_server.assert_not_called()
    urlopen.assert_not_called()


def test_local_model_downloaded_starts_server_before_request() -> None:
    fake_runtime = mock.MagicMock()
    fake_runtime.model_downloaded.return_value = True
    fake_runtime.ensure_server.return_value = "http://127.0.0.1:1234"
    fake = _FakeResponse(
        {"choices": [{"message": {"content": json.dumps({"detected": True, "confidence": 0.9})}}]}
    )
    with mock.patch(
        "script_organizer.local_vision_runtime.LocalVisionRuntime", return_value=fake_runtime
    ), mock.patch("urllib.request.urlopen", return_value=fake) as urlopen:
        result = extract_clapperboard_proposal(frames=_FRAMES, config=_local_config())

    fake_runtime.ensure_server.assert_called_once_with()
    request = urlopen.call_args.args[0]
    assert request.full_url == "http://127.0.0.1:1234/v1/chat/completions"
    assert result["detected"] is True
    assert result["authority"] is False


def test_upstream_failure_returns_warning_without_crash() -> None:
    with mock.patch("urllib.request.urlopen", side_effect=OSError("connection refused")):
        result = extract_clapperboard_proposal(frames=_FRAMES, config=_openai_config())

    assert result["authority"] is False
    assert result["detected"] is False
    assert result["frames_inspected"] == 3
    assert "请求失败" in result["warning"]


def test_result_never_leaks_api_key_or_absolute_paths() -> None:
    video_path = "/Users/muee/片场/secret/clip.mov"
    model_payload = {
        "detected": True,
        "clapper_time_seconds": 0.5,
        "slate_note": "素材位于 /Volumes/RAW/clip.mov 以及 /Users/muee/片场/secret/clip.mov，密钥 TOP_SECRET_KEY",
        "confidence": 0.6,
    }
    fake = _FakeResponse({"choices": [{"message": {"content": json.dumps(model_payload, ensure_ascii=False)}}]})
    with mock.patch("urllib.request.urlopen", return_value=fake):
        result = extract_clapperboard_proposal(
            video_path, frames=_FRAMES, config=_openai_config(api_key="TOP_SECRET_KEY")
        )

    serialized = json.dumps(result, ensure_ascii=False)
    assert "TOP_SECRET_KEY" not in serialized
    assert video_path not in serialized
    assert "/Users/" not in serialized
    assert "/Volumes/" not in serialized
    assert result["authority"] is False


def test_extract_frames_uses_ffmpeg_tempdir_and_keeps_successful_frames() -> None:
    created: list[str] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        created.append(command[-1])
        Path(command[-1]).write_bytes(_JPEG)
        return subprocess.CompletedProcess(command, 0)

    with tempfile.TemporaryDirectory() as workspace:
        video = Path(workspace) / "input.mov"
        video.write_bytes(b"fake video")
        with mock.patch("script_organizer.clapperboard_ocr.shutil.which", return_value="/usr/bin/ffmpeg"), mock.patch(
            "script_organizer.clapperboard_ocr.subprocess.run", side_effect=fake_run
        ) as run:
            frames = extract_clapperboard_frames(video)

    assert [timestamp for timestamp, _ in frames] == [0.5, 2.0, 4.5]
    assert [data for _, data in frames] == [_JPEG, _JPEG, _JPEG]
    assert len(created) == 3
    first_command = run.call_args_list[0].args[0]
    assert "-vf" in first_command and "scale=1024:-2" in first_command
    assert "-q:v" in first_command and "4" in first_command
    assert first_command[first_command.index("-ss") + 1].startswith("0.500")
    assert run.call_args.kwargs["timeout"] == 15.0
    # 临时目录中的帧已被读取进 bytes 并清理，路径不应继续存在。
    assert all(not Path(path).exists() for path in created)


def test_extract_frames_skips_timeout_frame_and_returns_rest() -> None:
    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        if command[-1].endswith("frame-1.jpg"):
            raise subprocess.TimeoutExpired(command, 15.0)
        Path(command[-1]).write_bytes(_JPEG)
        return subprocess.CompletedProcess(command, 0)

    with tempfile.TemporaryDirectory() as workspace:
        video = Path(workspace) / "input.mov"
        video.write_bytes(b"fake video")
        with mock.patch("script_organizer.clapperboard_ocr.shutil.which", return_value="/usr/bin/ffmpeg"), mock.patch(
            "script_organizer.clapperboard_ocr.subprocess.run", side_effect=fake_run
        ):
            frames = extract_clapperboard_frames(video, sample_times=(0.5, 2.0))

    assert [timestamp for timestamp, _ in frames] == [2.0]


def test_extract_frames_without_ffmpeg_raises_clear_error() -> None:
    with mock.patch("script_organizer.clapperboard_ocr.shutil.which", return_value=None):
        with pytest.raises(ValueError, match="未找到 ffmpeg"):
            extract_clapperboard_frames("fake-input.mov")


def test_disabled_provider_is_rejected_without_network() -> None:
    with mock.patch("urllib.request.urlopen") as urlopen:
        with pytest.raises(ValueError, match="未启用多模态视觉模型"):
            extract_clapperboard_proposal(frames=_FRAMES, config=VisionProviderConfig())
    urlopen.assert_not_called()
