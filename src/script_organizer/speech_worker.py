"""Explicit device-local speech worker. Discovery is stat-only, never a launch."""
from __future__ import annotations

import json
import math
import os
import platform
import signal
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Callable

from .device_runtime_settings import application_support_root
from .resource_scheduler import ResourceCancelled

PROFILE = "local-mlx-small-v1"
MODEL_REVISION = "45f3915923c7a79a5a5b5a7d909d39aeb0e5630e"
MAX_SECONDS = 600
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
TIMEOUT_SECONDS = 240
MAX_RSS_KIB = 6 * 1024 * 1024
_LOCK = Lock()


@dataclass(frozen=True)
class Worker:
    python: Path
    packages: Path
    model: Path
    ffmpeg: Path


def _inside_file(path: Path, root: Path) -> bool:
    try:
        return path.resolve(strict=True).is_relative_to(root.resolve(strict=True)) and path.is_file() and path.stat().st_size > 0
    except (OSError, RuntimeError):
        return False


def cached_small_model(data_root: Path) -> Path | None:
    cache = data_root / "models" / "huggingface" / "hub" / "models--mlx-community--whisper-small-mlx"
    model = cache / "snapshots" / MODEL_REVISION
    if model.resolve().is_relative_to(data_root.resolve()) and all(
        _inside_file(model / name, cache) for name in ("config.json", "weights.npz")
    ):
        return model
    return None


def _discover(data_root: Path, resources: Path) -> tuple[Worker | None, str]:
    if platform.system() != "Darwin" or platform.machine() not in {"arm64", "aarch64"}:
        return None, "unsupported_platform"
    runtime = data_root / "speech" / PROFILE
    python = runtime / "python" / "bin" / "python3.11"
    packages = runtime / "site-packages"
    package_init = ("mlx_whisper/__init__.py", "mlx-0.32.1.dist-info/METADATA", "mlx_metal-0.32.1.dist-info/METADATA", "mlx_whisper-0.4.3.dist-info/METADATA")
    if not _inside_file(python, runtime) or not runtime.resolve().is_relative_to(data_root.resolve()) or not os.access(python, os.X_OK) or not all(_inside_file(packages / name, runtime) for name in package_init) or not _inside_file(runtime / "python/lib/python3.11/site-packages/numpy/__init__.py", runtime):
        return None, "optional_runtime_missing_or_incomplete"
    model = cached_small_model(data_root)
    if model is None:
        return None, "local_model_missing_or_incomplete"
    ffmpeg = resources / "mirrororder-tools" / "bin" / "ffmpeg"
    if not _inside_file(ffmpeg, resources) or not os.access(ffmpeg, os.X_OK):
        return None, "bundled_ffmpeg_missing"
    return Worker(python, packages, model, ffmpeg), "available"


def _resolve() -> tuple[Worker | None, str]:
    return _discover(application_support_root(), Path(__file__).resolve().parents[3])


def speech_runtime_status() -> dict[str, object]:
    worker, reason = _resolve()
    if worker is not None and not Path(__file__).with_name("speech_worker_entry.py").is_file():
        worker, reason = None, "worker_entry_missing"
    return {"profile": PROFILE, "available": worker is not None, "status": reason,
            "model": "whisper-small", "max_clip_seconds": MAX_SECONDS}


def _stop(process: subprocess.Popen) -> None:
    # Only the private session created by this task; never touch a host/app PID.
    try:
        os.killpg(process.pid, signal.SIGTERM)
        # Do not reap the leader before the final group signal.
        time.sleep(0.25)
    except (ProcessLookupError, PermissionError):
        pass
    # The group can outlive its leader while an FFmpeg child winds down.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    process.wait()


def _rss_kib(pid: int) -> int | None:
    try:
        out = subprocess.run(["/bin/ps", "-o", "rss=", "-p", str(pid)], capture_output=True,
                             check=False, timeout=0.5, env={"LC_ALL": "C"})
        return int(out.stdout.strip()) if out.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def transcribe_local(media_path: str, language: str, cancelled: Callable[[], bool]) -> list[dict]:
    worker, reason = _resolve()
    if worker is None:
        raise RuntimeError(f"本机语音运行时不可用：{reason}")
    media = Path(media_path)
    if not media.is_absolute() or not media.is_file():
        raise ValueError("语音转写需要已验证的本机原片")
    if cancelled():
        raise ResourceCancelled("转写已取消")
    if not _LOCK.acquire(blocking=False):
        raise RuntimeError("本机语音运行时正在处理其他任务")
    try:
        with tempfile.TemporaryDirectory(prefix="mirrororder-speech-") as scratch:
            result = Path(scratch) / "result.json"
            args = [str(worker.python), "-I", "-B", str(Path(__file__).with_name("speech_worker_entry.py")),
                    str(worker.packages), str(worker.model), str(worker.ffmpeg), str(media), language,
                    str(result), str(MAX_SECONDS), str(MAX_RESPONSE_BYTES)]
            env = {"HOME": scratch, "TMPDIR": scratch, "HF_HUB_OFFLINE": "1",
                   "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
                   "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1", "DO_NOT_TRACK": "1"}
            end = time.monotonic() + TIMEOUT_SECONDS
            process = subprocess.Popen(args, cwd=scratch, env=env, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            try:
                next_sample = time.monotonic()
                while process.poll() is None:
                    if cancelled():
                        raise ResourceCancelled("转写已取消")
                    if time.monotonic() >= end:
                        raise RuntimeError("本机语音处理超时")
                    now = time.monotonic()
                    if now >= next_sample:
                        rss = _rss_kib(process.pid)
                        if rss is not None and rss > MAX_RSS_KIB:
                            raise RuntimeError("本机语音处理超出内存预算")
                        next_sample = now + 1
                    time.sleep(0.1)
            finally:
                if process.poll() is None:
                    _stop(process)
            if cancelled():
                raise ResourceCancelled("转写已取消")
            try:
                with result.open("rb") as stream:
                    raw = stream.read(MAX_RESPONSE_BYTES + 1)
            except OSError as exc:
                raise RuntimeError("本机语音处理未返回结果") from exc
            if len(raw) > MAX_RESPONSE_BYTES:
                raise RuntimeError("语音结果超过本机响应预算")
            payload = json.loads(raw)
            if process.returncode != 0 or not isinstance(payload, dict) or payload.get("protocol") != 1:
                error = payload.get("error") if isinstance(payload, dict) else None
                raise RuntimeError("素材超过 10 分钟，请分段后转写" if error == "source_too_long" else "本机语音处理失败")
            segments = payload.get("segments")
            duration = payload.get("duration")
            if not isinstance(segments, list) or not _time(duration) or duration > MAX_SECONDS:
                raise RuntimeError("本机语音结果无效")
            return [_segment(row, duration) for row in segments]
    finally:
        _LOCK.release()


def _time(v: object) -> bool:
    return type(v) in (int, float) and math.isfinite(v) and v >= 0


def _segment(row: dict, duration: float) -> dict:
    if not isinstance(row, dict):
        raise ValueError("无效转写片段")
    start, end, text = row.get("start"), row.get("end"), row.get("text")
    if not _time(start) or not _time(end) or not start <= end <= duration + 0.1 or not isinstance(text, str):
        raise ValueError("无效转写时间戳")
    words = row.get("words", [])
    if not isinstance(words, list):
        raise ValueError("无效词时间戳")
    for word in words:
        if not isinstance(word, dict) or not _time(word.get("start")) or not _time(word.get("end")) or not word["start"] <= word["end"] <= duration + 0.1 or not isinstance(word.get("word"), str):
            raise ValueError("无效词时间戳")
    return {"start": min(start, duration), "end": min(end, duration), "text": text,
            "words": [{"start": min(w["start"], duration), "end": min(w["end"], duration), "word": w["word"]} for w in words]}
