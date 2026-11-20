"""视频打板帧（Clapperboard）AI 识别提案。

本模块只产出「证据 / 提案」：输出永远 ``authority=False``，不写入任何项目
事实。抽帧只在临时目录中落盘，读取为 JPEG bytes 后立即清理；请求体只携带
base64 帧和采样时间，结果绝不携带 API Key 或本机绝对文件路径。
"""
from __future__ import annotations

import base64
import json
import math
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .model_connections import gemini_interactions_request, resolve_openai_endpoint
from .vision_provider import VisionProviderConfig


CONTRACT_VERSION = "clapperboard_ocr_proposal.v1"
DEFAULT_SAMPLE_TIMES: tuple[float, ...] = (0.5, 2.0, 4.5)
DEFAULT_MAX_FRAMES = 3
DEFAULT_TIMEOUT_SECONDS = 15.0

# 提案是可能进入共享 artifact 的证据，绝不回显设备绝对路径。
_ABSOLUTE_PATH_RE = re.compile(
    r"(?:(?:[A-Za-z]:[\\/])|/(?:Users|Volumes|home|private|tmp|var)/)[^\s，。；：、\"'<>]+"
)

_SYSTEM_INSTRUCTION = (
    "你是短剧片场视频打板帧（场记板/clapperboard）的结构化识别器。只转录画面中"
    "肉眼可见的事实，不要猜测、不要把文件名或剧本内容当成拍摄事实。"
    "返回严格 JSON 对象，不要 Markdown 代码块，不要解释文字。字段："
    "detected(布尔，画面没有场记板则为 false)、clapper_time_seconds(数字或null，"
    "打板发生的视频秒数)、episode(正整数或null)、scene(字符串)、shot(字符串)、"
    "take(字符串)、camera(字符串)、roll(字符串)、slate_note(字符串)、"
    "confidence(0 到 1 之间的数字)。你只提供证据提案，不拥有最终 authority。"
)


def _as_text(value: object, limit: int) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False)
    return _ABSOLUTE_PATH_RE.sub("", str(value).strip())[:limit]


def _as_episode(value: object) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        parsed = int(value)
        return parsed if parsed > 0 else None
    match = re.search(r"-?\d+", str(value).strip())
    if not match:
        return None
    parsed = int(match.group())
    return parsed if parsed > 0 else None


def _as_confidence(value: object) -> float:
    if value is None or isinstance(value, bool):
        return 0.0
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(number):
        return 0.0
    return max(0.0, min(1.0, number))


def _as_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value == 1
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "y", "是", "有"}
    return False


def _as_time_seconds(value: object) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number < 0:
        return None
    return number


def _parse_model_json(text: object) -> dict[str, Any] | None:
    """Best-effort extraction of a single JSON object from free-form model text."""
    value = str(text or "").strip()
    if not value:
        return None
    if value.startswith("```"):
        value = value.strip("`")
        if value.lower().startswith("json"):
            value = value[4:]
        value = value.strip()

    parsed: object = None
    try:
        parsed = json.loads(value)
    except (ValueError, TypeError):
        left, right = value.find("{"), value.rfind("}")
        if left < 0 or right <= left:
            return None
        try:
            parsed = json.loads(value[left : right + 1])
        except (ValueError, TypeError):
            return None
    return parsed if isinstance(parsed, dict) else None


def _clean_frames(frames: object) -> list[tuple[float, bytes]]:
    cleaned: list[tuple[float, bytes]] = []
    if not isinstance(frames, (list, tuple)):
        return cleaned
    for item in frames:
        if not isinstance(item, (list, tuple)) or len(item) != 2:
            continue
        timestamp, data = item
        if not isinstance(data, (bytes, bytearray)) or not data:
            continue
        try:
            seconds = float(timestamp)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(seconds):
            continue
        cleaned.append((max(0.0, seconds), bytes(data)))
    return cleaned


def _openai_base_url(config: VisionProviderConfig) -> str:
    base = str(config.base_url or "").strip().rstrip("/")
    if base:
        return base
    if config.is_local:
        # 请求路径绝不静默触发 GB 级模型下载：必须先确认模型已在设备上准备。
        from .local_vision_runtime import LocalVisionRuntime, LocalVisionRuntimeConfig

        runtime = LocalVisionRuntime(LocalVisionRuntimeConfig.from_env(config.model))
        if not runtime.model_downloaded():
            raise ValueError("本地视觉模型尚未下载，请先在设置中准备本地视觉模型，或切换为 Gemini / OpenAI")
        base = str(runtime.ensure_server() or "").strip().rstrip("/")
    if not base:
        raise ValueError("本地视觉模型服务未就绪，请先在设置中启用并启动本地视觉模型")
    return base


def extract_clapperboard_frames(
    video_path: str | Path,
    sample_times: tuple[float, ...] = DEFAULT_SAMPLE_TIMES,
    max_frames: int = DEFAULT_MAX_FRAMES,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> list[tuple[float, bytes]]:
    """抽取视频开头的少量压缩 JPEG 帧。

    单帧失败或超时只跳过该帧，已成功抽出的帧照常返回；ffmpeg 不存在或视频
    不可读取则抛出中文 ValueError。临时文件在读取 bytes 后立即清理。
    """
    if not shutil.which("ffmpeg"):
        raise ValueError("未找到 ffmpeg，无法从视频抽取打板帧；请先安装 ffmpeg 后再试")
    source = Path(video_path)
    if not source.is_file():
        raise ValueError("视频文件不存在或不可读取，无法抽取打板帧")

    limit = max(0, int(max_frames))
    times: list[float] = []
    for raw in tuple(sample_times)[:limit]:
        try:
            value = float(raw)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(value):
            continue
        times.append(max(0.0, value))

    frames: list[tuple[float, bytes]] = []
    with tempfile.TemporaryDirectory(prefix="mirrororder-clapperboard-") as folder:
        for index, timestamp in enumerate(times):
            target = Path(folder) / f"frame-{index + 1}.jpg"
            command = [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-ss", f"{timestamp:.3f}", "-i", str(source),
                "-frames:v", "1", "-vf", "scale=1024:-2", "-q:v", "4", str(target),
            ]
            try:
                subprocess.run(
                    command,
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=max(1.0, float(timeout_seconds)),
                )
            except (OSError, subprocess.SubprocessError):
                continue
            try:
                if target.is_file() and target.stat().st_size > 0:
                    frames.append((timestamp, target.read_bytes()))
            except OSError:
                continue
    return frames


def extract_clapperboard_proposal(
    video_path: str | Path | None = None,
    *,
    frames: list[tuple[float, bytes]] | None = None,
    config: VisionProviderConfig | None = None,
) -> dict[str, Any]:
    """从打板帧生成严格清洗的证据提案，永远不写入 authority。"""
    active = config or VisionProviderConfig.from_env()
    if not active.enabled:
        raise ValueError("未启用多模态视觉模型，请先在设置中配置 Gemini / OpenAI 或本地视觉模型")

    if frames is None:
        if video_path is None:
            raise ValueError("必须提供视频路径或已抽取的画面帧")
        frames = extract_clapperboard_frames(video_path)
    inspected = _clean_frames(frames)

    warning = ""
    parsed: dict[str, Any] = {}
    if not inspected:
        warning = "没有可识别的画面帧，请检查视频或重新抽帧。"
    else:
        context = json.dumps(
            {
                "task": "detect_clapperboard",
                "frame_times_seconds": [round(timestamp, 3) for timestamp, _ in inspected],
            },
            ensure_ascii=False,
        )
        model_text: str | None = None
        if active.provider == "gemini":
            parts: list[dict[str, Any]] = [{"type": "text", "text": context}]
            for _, data in inspected:
                parts.append(
                    {
                        "type": "image",
                        "data": base64.b64encode(data).decode("ascii"),
                        "mime_type": "image/jpeg",
                    }
                )
            model_text = gemini_interactions_request(
                base_url=active.base_url,
                api_key=active.api_key,
                model=active.model,
                system_instruction=_SYSTEM_INSTRUCTION,
                input_payload=parts,
                timeout_seconds=active.timeout_seconds,
            )
        else:
            url = resolve_openai_endpoint(_openai_base_url(active), "/chat/completions")
            content: list[dict[str, Any]] = [{"type": "text", "text": context}]
            for _, data in inspected:
                content.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")},
                    }
                )
            request_payload: dict[str, Any] = {
                "model": active.model,
                "temperature": 0,
                "messages": [
                    {"role": "system", "content": _SYSTEM_INSTRUCTION},
                    {"role": "user", "content": content},
                ],
            }
            headers = {"Content-Type": "application/json", "Accept": "application/json"}
            if active.api_key:
                headers["Authorization"] = "Bearer " + active.api_key
            request = urllib.request.Request(
                url,
                data=json.dumps(request_payload, ensure_ascii=False).encode("utf-8"),
                method="POST",
                headers=headers,
            )
            try:
                with urllib.request.urlopen(request, timeout=active.timeout_seconds) as response:
                    raw = json.loads(response.read().decode("utf-8"))
                text = raw["choices"][0]["message"]["content"]
            except (
                OSError,
                urllib.error.URLError,
                urllib.error.HTTPError,
                UnicodeDecodeError,
                ValueError,
                KeyError,
                IndexError,
                TypeError,
            ):
                text = None
            if isinstance(text, list):
                text = "".join(str(item.get("text", "")) for item in text if isinstance(item, dict))
            model_text = None if text is None else str(text)

        if model_text is None:
            warning = "多模态模型请求失败或超时，请检查 API Key、网络或本地视觉服务后重试。"
        else:
            parsed = _parse_model_json(model_text) or {}
            if not parsed:
                warning = "模型未返回可解析的打板识别提案，请人工核对。"

    detected = _as_bool(parsed.get("detected"))
    if not warning and not detected:
        warning = "未在抽帧中识别到场记板，请人工核对。"

    result: dict[str, Any] = {
        "contract": CONTRACT_VERSION,
        "authority": False,
        "detected": detected,
        "clapper_time_seconds": _as_time_seconds(parsed.get("clapper_time_seconds")),
        "episode": _as_episode(parsed.get("episode")),
        "scene": _as_text(parsed.get("scene"), 120),
        "shot": _as_text(parsed.get("shot"), 120),
        "take": _as_text(parsed.get("take"), 60),
        "camera": _as_text(parsed.get("camera"), 40),
        "roll": _as_text(parsed.get("roll"), 60),
        "slate_note": _as_text(parsed.get("slate_note"), 400),
        "confidence": _as_confidence(parsed.get("confidence")),
        "provider": str(active.provider or "none")[:80],
        "model": str(active.model or "")[:300],
        "frames_inspected": len(inspected),
        "warning": _as_text(warning, 400),
    }
    # 模型不会收到密钥，但仍做最后一道清洗，防止上游回显造成泄露。
    secret = str(active.api_key or "").strip()
    if len(secret) >= 6:
        for key, value in result.items():
            if isinstance(value, str) and secret in value:
                result[key] = value.replace(secret, "")
    return result


__all__ = [
    "CONTRACT_VERSION",
    "extract_clapperboard_frames",
    "extract_clapperboard_proposal",
]
