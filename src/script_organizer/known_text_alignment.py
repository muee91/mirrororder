from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any


@lru_cache(maxsize=2)
def _load_model(model_name: str):
    import stable_whisper  # type: ignore

    return stable_whisper.load_model(model_name)


def align_known_text(audio_path: str | Path, text: str, model_name: str = "base") -> dict[str, Any]:
    """Optional second-stage stable-ts alignment; first-stage results survive failure.

    The stable-ts model is process-cached because one analysis can align many
    candidates.  Import/model failures are reported as data and never erase the
    first-stage ASR/script match.
    """
    try:
        model = _load_model(model_name)
    except ImportError:
        return {"method": "stable-ts", "status": "unavailable", "error": "stable-ts 未安装"}
    except Exception as error:
        return {"method": "stable-ts", "status": "failed", "error": str(error)}
    try:
        result = model.align(str(audio_path), text, language="zh")
        segments = []
        for segment in getattr(result, "segments", []) or []:
            segments.append(
                {
                    "start": float(getattr(segment, "start", 0.0) or 0.0),
                    "end": float(getattr(segment, "end", 0.0) or 0.0),
                    "text": str(getattr(segment, "text", "") or ""),
                }
            )
        return {"method": "stable-ts", "status": "success", "segments": segments}
    except Exception as error:  # one failed align must not stop the project
        return {"method": "stable-ts", "status": "failed", "error": str(error)}
