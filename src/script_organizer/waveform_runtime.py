from __future__ import annotations

import array
import hashlib
import json
import math
import os
import subprocess
import sys
from pathlib import Path
from time import monotonic
from typing import Any, Callable
from uuid import uuid4

from .media_identity import DeviceMediaStore
from .resource_scheduler import ResourceCancelled

_INSTALLED = False
_CONTRACT = "waveform.v1"
_TASK_TYPE = "waveform_build"
_CACHE_VERSION = "logical-v3"
_MIN_SAMPLES = 64
_MAX_SAMPLES = 4096
_MIN_PCM_RATE = 4
_MAX_PCM_RATE = 1000
_OVERSAMPLE_FACTOR = 12


def _sample_count(value: object) -> int:
    try:
        parsed = int(value or 512)
    except (TypeError, ValueError):
        parsed = 512
    return max(_MIN_SAMPLES, min(_MAX_SAMPLES, parsed))


def _target_pcm_rate(duration: float, samples: int) -> int:
    """Choose a decode rate that keeps overview PCM bounded for long media."""
    if not math.isfinite(duration) or duration <= 0:
        return _MAX_PCM_RATE
    target_values = max(_MIN_SAMPLES, samples) * _OVERSAMPLE_FACTOR
    return max(_MIN_PCM_RATE, min(_MAX_PCM_RATE, int(math.ceil(target_values / duration))))


def _decode_timeout(duration: float) -> int:
    """Scale the guardrail for long media without allowing an unbounded worker."""
    if not math.isfinite(duration) or duration <= 0:
        return 60
    return max(60, min(600, int(math.ceil(duration / 30.0)) + 30))


def _stop_process(process: subprocess.Popen[Any]) -> None:
    if process.poll() is not None:
        return
    try:
        process.terminate()
        process.communicate(timeout=2)
    except (OSError, subprocess.TimeoutExpired):
        try:
            process.kill()
            process.communicate(timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            pass


def _run_process(
    command: list[str],
    *,
    timeout: float,
    text: bool = False,
    cancel_check: Callable[[], bool] | None = None,
) -> tuple[Any, Any]:
    """Run one local media process with task-aware cancellation.

    ``subprocess.run`` cannot observe a durable-task cancel flag while ffmpeg is
    decoding. Poll the child in short intervals so Status Center cancellation
    actually terminates the process instead of only changing task metadata.
    """
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=text,
    )
    started = monotonic()
    while True:
        if cancel_check and cancel_check():
            _stop_process(process)
            raise ResourceCancelled("waveform 生成已取消")
        elapsed = monotonic() - started
        remaining = float(timeout) - elapsed
        if remaining <= 0:
            _stop_process(process)
            raise subprocess.TimeoutExpired(command, timeout)
        try:
            stdout, stderr = process.communicate(timeout=min(0.25, remaining))
            break
        except subprocess.TimeoutExpired:
            continue
    if process.returncode not in {0, None}:
        raise subprocess.CalledProcessError(
            int(process.returncode),
            command,
            output=stdout,
            stderr=stderr,
        )
    return stdout, stderr


def _probe_duration(path: Path, cancel_check: Callable[[], bool] | None = None) -> float:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    try:
        stdout, _stderr = _run_process(command, timeout=20, text=True, cancel_check=cancel_check)
        value = float(str(stdout).strip() or 0)
        return value if math.isfinite(value) and value > 0 else 0.0
    except FileNotFoundError as error:
        raise RuntimeError("本机未安装 ffprobe，无法生成 waveform") from error
    except ResourceCancelled:
        raise
    except (ValueError, subprocess.TimeoutExpired, subprocess.CalledProcessError):
        return 0.0


def _fingerprint(path: Path, samples: int, pcm_rate: int) -> str:
    stat = path.stat()
    raw = f"{path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}|{samples}|{pcm_rate}|adaptive-v3"
    return hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:24]


def _peaks_from_pcm(data: bytes, samples: int) -> list[float]:
    if not data:
        return []
    values = array.array("h")
    usable = len(data) - (len(data) % 2)
    values.frombytes(data[:usable])
    if sys.byteorder != "little":
        values.byteswap()
    if not values:
        return []

    bucket = max(1, math.ceil(len(values) / samples))
    peaks: list[float] = []
    for index in range(0, len(values), bucket):
        chunk = values[index : index + bucket]
        peak = max((abs(int(value)) for value in chunk), default=0)
        peaks.append(round(min(1.0, peak / 32768.0), 5))
        if len(peaks) >= samples:
            break
    return peaks


def _decode_pcm(
    path: Path,
    pcm_rate: int,
    timeout: int,
    cancel_check: Callable[[], bool] | None = None,
) -> bytes:
    command = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-i",
        str(path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(pcm_rate),
        "-f",
        "s16le",
        "pipe:1",
    ]
    try:
        stdout, _stderr = _run_process(command, timeout=timeout, cancel_check=cancel_check)
    except FileNotFoundError as error:
        raise RuntimeError("本机未安装 ffmpeg，无法生成 waveform") from error
    except ResourceCancelled:
        raise
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"waveform 生成超时（{timeout}s）") from error
    except subprocess.CalledProcessError as error:
        raw_detail = error.stderr or b""
        detail = raw_detail.decode("utf-8", errors="replace").strip() if isinstance(raw_detail, bytes) else str(raw_detail).strip()
        raise RuntimeError(f"ffmpeg waveform 失败：{detail[:400] or error.returncode}") from error
    return stdout if isinstance(stdout, bytes) else str(stdout).encode("utf-8", errors="replace")


def _logical_identity(clip_id: str, clip: dict[str, Any], samples: int) -> str:
    """Build a cache address from project facts only; never stat/open media."""
    source_identity = str(
        clip.get("media_id", "")
        or clip.get("source_media_path", "")
        or clip.get("media_path", "")
        or clip.get("name", "")
        or clip_id
    )
    raw = f"{_CACHE_VERSION}|{clip_id}|{source_identity}|{samples}"
    return hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:24]


def _cache_path(output_dir: Path, clip_id: str, clip: dict[str, Any], samples: int) -> Path:
    safe_clip = hashlib.sha256(str(clip_id).encode("utf-8", errors="replace")).hexdigest()[:16]
    logical = _logical_identity(clip_id, clip, samples)
    return Path(output_dir) / ".mirrororder-cache" / "waveforms" / f"{safe_clip}-{logical}.json"


def _cached_payload(project: Any, clip_id: str, samples: int) -> dict[str, Any] | None:
    """Read only the project cache. This function must never touch media bytes."""
    clip = project.clips.get(clip_id)
    if not isinstance(clip, dict):
        raise KeyError(clip_id)
    cache = _cache_path(Path(project.config.output_dir), clip_id, clip, samples)
    if not cache.is_file():
        return None
    try:
        cached = json.loads(cache.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(cached, dict) or cached.get("contract") != _CONTRACT:
        return None
    if str(cached.get("clip_id", "")) != str(clip_id):
        return None
    if int(cached.get("requested_samples", 0) or 0) != samples:
        return None
    return cached


def _index_clip(index: dict[str, Any], clip_id: str) -> dict[str, Any]:
    for clip in index.get("clips", []):
        if isinstance(clip, dict) and str(clip.get("clip_id", "") or "") == clip_id:
            return clip
    for group in index.get("groups", []):
        if not isinstance(group, dict):
            continue
        for member in group.get("members", []):
            if isinstance(member, dict) and str(member.get("clip_id", "") or "") == clip_id:
                return member
    raise KeyError(clip_id)


def _resolve_media_path(workspace_id: str, project_id: str, clip: dict[str, Any]) -> Path:
    source = str(clip.get("source_media_path", "") or clip.get("media_path", "") or "")
    resolved = ""
    if workspace_id:
        try:
            resolved = DeviceMediaStore().resolve(workspace_id, project_id, clip)
        except OSError:
            resolved = ""
    if resolved:
        path = Path(resolved)
        if path.is_file():
            return path
    if source:
        path = Path(source)
        if path.is_file():
            return path
    raise FileNotFoundError(source or clip.get("clip_id", ""))


def _write_cache(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    try:
        temp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.replace(temp, path)
    finally:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass


def _build_payload(
    config: Any,
    workspace_id: str,
    project_id: str,
    clip_id: str,
    samples: int,
    *,
    cancel_check: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    try:
        raw_index = json.loads((Path(config.output_dir) / "material_index.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RuntimeError("项目素材索引不可用，无法生成 waveform") from error
    if not isinstance(raw_index, dict):
        raise RuntimeError("项目素材索引无效，无法生成 waveform")
    clip = _index_clip(raw_index, clip_id)
    path = _resolve_media_path(workspace_id, project_id, clip)
    if cancel_check and cancel_check():
        raise ResourceCancelled("waveform 生成已取消")

    duration = _probe_duration(path, cancel_check=cancel_check)
    pcm_rate = _target_pcm_rate(duration, samples)
    timeout = _decode_timeout(duration)
    fingerprint = _fingerprint(path, samples, pcm_rate)
    peaks = _peaks_from_pcm(
        _decode_pcm(path, pcm_rate, timeout, cancel_check=cancel_check),
        samples,
    )
    payload = {
        "contract": _CONTRACT,
        "clip_id": str(clip_id),
        "samples": len(peaks),
        "requested_samples": samples,
        "sample_rate": pcm_rate,
        "duration": duration,
        "decode_timeout_seconds": timeout,
        "peaks": peaks,
        "derived": True,
        "editorial_authority": False,
        "source_fingerprint": fingerprint,
    }
    _write_cache(_cache_path(Path(config.output_dir), clip_id, clip, samples), payload)
    return payload


def _task_result(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "clip_id": str(payload.get("clip_id", "") or ""),
        "samples": int(payload.get("samples", 0) or 0),
        "requested_samples": int(payload.get("requested_samples", 0) or 0),
        "sample_rate": int(payload.get("sample_rate", 0) or 0),
        "duration": float(payload.get("duration", 0) or 0),
        "cached": True,
        "paths_exposed": False,
    }


def install_waveform_runtime() -> None:
    """Expose cached peaks on GET and generate them only through durable tasks."""
    global _INSTALLED
    if _INSTALLED:
        return

    from . import tasks as task_runtime, web_server

    original_task_run = task_runtime.TaskManager._run
    original_make_handler = web_server.make_handler
    task_runtime.TASK_TYPES.add(_TASK_TYPE)

    def run_with_waveform(manager: Any, project_id: str, task_id: str) -> None:
        config = manager.project_loader(project_id)
        try:
            task = manager._task(manager._load(config), task_id)
        except Exception:
            return original_task_run(manager, project_id, task_id)
        if str(task.get("type", "")) != _TASK_TYPE:
            return original_task_run(manager, project_id, task_id)

        try:
            manager._update(config, task_id, status="running", stage="starting", message="waveform 任务开始")
            if manager._cancel_requested(config, task_id):
                manager._update(config, task_id, status="cancelled", stage="cancelled", message="waveform 生成已取消")
                return
            targets = task.get("targets", {}) if isinstance(task.get("targets"), dict) else {}
            clip_id = str(targets.get("clip_id", "") or "").strip()
            if not clip_id:
                raise ValueError("waveform_build 缺少 clip_id")
            samples = _sample_count(targets.get("samples", 512))
            workspace_id = str(getattr(manager, "workspace_id", "") or "")
            with manager._resource(config, task, "cpu", "waveform", "波形生成"):
                payload = _build_payload(
                    config,
                    workspace_id,
                    project_id,
                    clip_id,
                    samples,
                    cancel_check=lambda: manager._cancel_requested(config, task_id),
                )
            result = _task_result(payload)
            if manager._cancel_requested(config, task_id):
                manager._update(
                    config,
                    task_id,
                    status="cancelled",
                    stage="cancelled",
                    result=result,
                    message="waveform 生成阶段完成后已停止",
                )
                return
            manager._update(
                config,
                task_id,
                status="completed",
                stage="completed",
                result=result,
                message=f"waveform 生成完成 · {result['samples']} peaks",
            )
        except ResourceCancelled:
            manager._update(config, task_id, status="cancelled", stage="cancelled", message="waveform 生成已取消")
        except KeyError:
            manager._update(config, task_id, status="failed", stage="failed", error="unknown clip", message="waveform 生成失败")
        except FileNotFoundError:
            manager._update(config, task_id, status="failed", stage="failed", error="media missing", message="waveform 生成失败")
        except Exception as error:
            manager._update(config, task_id, status="failed", stage="failed", error=str(error), message="waveform 生成失败")
        finally:
            manager._threads.pop(task_id, None)

    task_runtime.TaskManager._run = run_with_waveform

    def make_handler_with_waveform(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 6
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "waveform"
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    query = web_server.urllib.parse.parse_qs(parsed.query)
                    samples = _sample_count((query.get("samples") or [512])[0])
                    clip_id = web_server.urllib.parse.unquote(parts[5])
                    try:
                        cached = _cached_payload(project, clip_id, samples)
                    except KeyError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.NOT_FOUND, "unknown clip") from error
                    if cached is None:
                        raise web_server.ApiError(web_server.HTTPStatus.NOT_FOUND, "waveform 尚未生成")
                    self._send_json(cached)
                    return
                return super()._app_get(parsed)

            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 6
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "waveform"
                ):
                    self._local_only()
                    current = getattr(service, "current", None) or service
                    project = current.project(parts[3])
                    clip_id = web_server.urllib.parse.unquote(parts[5])
                    if not isinstance(project.clips.get(clip_id), dict):
                        raise web_server.ApiError(web_server.HTTPStatus.NOT_FOUND, "unknown clip")
                    body = web_server._body(self)
                    samples = _sample_count(body.get("samples", 512))
                    request_id = uuid4().hex
                    task = current.tasks.submit(
                        project.project_id,
                        _TASK_TYPE,
                        {"clip_id": clip_id, "samples": samples},
                        f"waveform_build:{project.project_id}:{clip_id}:{samples}:{request_id}",
                        "desktop",
                    )
                    self._send_json(
                        {
                            "contract": "waveform_build.v1",
                            "project_id": project.project_id,
                            "clip_id": clip_id,
                            "task": task,
                        },
                        web_server.HTTPStatus.ACCEPTED,
                    )
                    return
                return super()._app_post(parsed)

        return Handler

    web_server.make_handler = make_handler_with_waveform
    _INSTALLED = True


__all__ = [
    "install_waveform_runtime",
    "_build_payload",
    "_cached_payload",
    "_cache_path",
    "_decode_timeout",
    "_peaks_from_pcm",
    "_run_process",
    "_sample_count",
    "_target_pcm_rate",
]
