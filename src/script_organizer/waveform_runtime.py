from __future__ import annotations

import array
import hashlib
import json
import math
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

_INSTALLED = False
_CONTRACT = "waveform.v1"
_MIN_SAMPLES = 64
_MAX_SAMPLES = 4096
_PCM_RATE = 1000


def _sample_count(value: object) -> int:
    try:
        parsed = int(value or 512)
    except (TypeError, ValueError):
        parsed = 512
    return max(_MIN_SAMPLES, min(_MAX_SAMPLES, parsed))


def _fingerprint(path: Path, samples: int) -> str:
    stat = path.stat()
    raw = f"{path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}|{samples}|{_PCM_RATE}"
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


def _decode_pcm(path: Path) -> bytes:
    command = [
        "ffmpeg",
        "-v",
        "error",
        "-i",
        str(path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(_PCM_RATE),
        "-f",
        "s16le",
        "pipe:1",
    ]
    try:
        result = subprocess.run(command, capture_output=True, timeout=60, check=True)
    except FileNotFoundError as error:
        raise RuntimeError("本机未安装 ffmpeg，无法生成 waveform") from error
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("waveform 生成超时") from error
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or b"").decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"ffmpeg waveform 失败：{detail[:400] or error.returncode}") from error
    return result.stdout


def _cache_path(project: Any, clip_id: str, fingerprint: str) -> Path:
    safe_clip = hashlib.sha256(str(clip_id).encode("utf-8", errors="replace")).hexdigest()[:16]
    return Path(project.config.output_dir) / ".mirrororder-cache" / "waveforms" / f"{safe_clip}-{fingerprint}.json"


def _payload(project: Any, clip_id: str, samples: int) -> dict[str, Any]:
    clip = project.clips.get(clip_id)
    if not isinstance(clip, dict):
        raise KeyError(clip_id)
    path = Path(str(clip.get("media_path", "") or ""))
    if not path.is_file():
        raise FileNotFoundError(path)

    fingerprint = _fingerprint(path, samples)
    cache = _cache_path(project, clip_id, fingerprint)
    if cache.is_file():
        try:
            cached = json.loads(cache.read_text(encoding="utf-8"))
            if isinstance(cached, dict) and cached.get("contract") == _CONTRACT:
                return cached
        except (OSError, ValueError):
            pass

    peaks = _peaks_from_pcm(_decode_pcm(path), samples)
    payload = {
        "contract": _CONTRACT,
        "clip_id": str(clip_id),
        "samples": len(peaks),
        "requested_samples": samples,
        "sample_rate": _PCM_RATE,
        "peaks": peaks,
        "derived": True,
        "editorial_authority": False,
        "source_fingerprint": fingerprint,
    }
    cache.parent.mkdir(parents=True, exist_ok=True)
    temp = cache.with_suffix(".tmp")
    try:
        temp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.replace(temp, cache)
    except OSError:
        try:
            temp.unlink(missing_ok=True)
        except OSError:
            pass
    return payload


def install_waveform_runtime() -> None:
    """Expose rebuildable audio peaks for Desktop editing without gaining authority."""
    global _INSTALLED
    if _INSTALLED:
        return
    from . import web_server

    original_make_handler = web_server.make_handler

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
                        self._send_json(_payload(project, clip_id, samples))
                    except KeyError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.NOT_FOUND, "unknown clip") from error
                    except FileNotFoundError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.NOT_FOUND, "media missing") from error
                    except RuntimeError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.SERVICE_UNAVAILABLE, str(error)) from error
                    return
                return super()._app_get(parsed)

        return Handler

    web_server.make_handler = make_handler_with_waveform
    _INSTALLED = True


__all__ = ["install_waveform_runtime", "_peaks_from_pcm", "_sample_count"]
