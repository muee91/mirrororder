from __future__ import annotations

from pathlib import Path
from typing import Any


def align_known_text(audio_path: str | Path, text: str, model_name: str = "base") -> dict[str, Any]:
    """Optional second-stage stable-ts alignment; first-stage results survive failure."""
    try:
        import stable_whisper  # type: ignore
    except ImportError:
        return {"method": "stable-ts", "status": "unavailable", "error": "stable-ts 未安装"}
    try:
        model = stable_whisper.load_model(model_name)
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
