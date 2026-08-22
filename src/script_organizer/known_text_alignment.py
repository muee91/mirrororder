from __future__ import annotations

import hashlib
import json
import os
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Any


@lru_cache(maxsize=2)
def _load_model(model_name: str):
    import stable_whisper  # type: ignore

    return stable_whisper.load_model(model_name)


def _cache_dir() -> Path:
    configured = os.environ.get("MIRRORORDER_ALIGNMENT_CACHE_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".cache" / "mirrororder" / "alignment"


def _alignment_cache_key(audio_path: str | Path, text: str, model_name: str) -> str:
    path = Path(audio_path).expanduser()
    try:
        stat = path.stat()
        fingerprint = f"{path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}"
    except OSError:
        fingerprint = f"{path.resolve()}|missing"
    payload = f"{fingerprint}|{model_name}|{text}".encode("utf-8")
    return hashlib.sha1(payload).hexdigest()


def _load_cached_alignment(cache_path: Path) -> dict[str, Any] | None:
    try:
        raw = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict) or raw.get("status") != "success":
        return None
    return {**raw, "cached": True}


def _write_cached_alignment(cache_path: Path, payload: dict[str, Any]) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=cache_path.name + ".", suffix=".tmp", dir=cache_path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, cache_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def align_known_text(audio_path: str | Path, text: str, model_name: str = "base") -> dict[str, Any]:
    """Optional second-stage stable-ts alignment with persistent result caching.

    The stable-ts model is process-cached. Successful alignment results are
    cached across runs by media fingerprint + known text + model. Import/model
    failures are returned as data and never erase the first-stage match.
    """
    normalized_text = str(text or "").strip()
    if not normalized_text:
        return {"method": "stable-ts", "status": "not_run", "error": "known text 为空"}

    cache_path = _cache_dir() / f"{_alignment_cache_key(audio_path, normalized_text, model_name)}.json"
    cached = _load_cached_alignment(cache_path)
    if cached is not None:
        return cached

    try:
        model = _load_model(model_name)
    except ImportError:
        return {"method": "stable-ts", "status": "unavailable", "error": "stable-ts 未安装"}
    except Exception as error:
        return {"method": "stable-ts", "status": "failed", "error": str(error)}

    try:
        result = model.align(str(audio_path), normalized_text, language="zh")
        segments = []
        for segment in getattr(result, "segments", []) or []:
            segments.append(
                {
                    "start": float(getattr(segment, "start", 0.0) or 0.0),
                    "end": float(getattr(segment, "end", 0.0) or 0.0),
                    "text": str(getattr(segment, "text", "") or ""),
                }
            )
        payload = {
            "method": "stable-ts",
            "status": "success",
            "segments": segments,
            "cached": False,
        }
        try:
            _write_cached_alignment(cache_path, payload)
        except OSError:
            pass
        return payload
    except Exception as error:  # one failed align must not stop the project
        return {"method": "stable-ts", "status": "failed", "error": str(error)}
