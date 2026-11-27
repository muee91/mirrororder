"""Entry point for the packaged, offline Whisper worker."""

import json
from pathlib import Path
import subprocess
import sys


def main() -> int:
    packages, model, ffmpeg, media, language, output, max_seconds, max_bytes = sys.argv[1:]
    limit = int(max_seconds)
    sample_rate = 16_000
    decoded = subprocess.run(
        [ffmpeg, "-nostdin", "-v", "error", "-i", media, "-map", "0:a:0", "-t", str(limit + 1),
         "-ac", "1", "-ar", str(sample_rate), "-f", "s16le", "-"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    duration = len(decoded.stdout) / (2 * sample_rate)
    error = ""
    if decoded.returncode:
        error = "audio_decode_failed"
    elif duration > limit:
        error = "source_too_long"
    if error:
        Path(output).write_text(json.dumps({"protocol": 1, "error": error}), encoding="utf-8")
        return 1

    sys.path.insert(0, packages)
    import mlx_whisper
    import numpy as np

    audio = np.frombuffer(decoded.stdout, dtype="<i2").astype(np.float32) / 32768.0
    segments = []
    if audio.size:
        result = mlx_whisper.transcribe(
            audio, path_or_hf_repo=model, language=language or None, word_timestamps=True, verbose=None,
        )
        for segment in result.get("segments", []):
            text = segment["text"].strip()
            if not text:
                continue
            segments.append({
                "start": min(float(segment["start"]), duration),
                "end": min(float(segment["end"]), duration),
                "text": text,
                "words": [
                    {"start": min(float(word["start"]), duration),
                     "end": min(float(word["end"]), duration), "word": str(word["word"])}
                    for word in segment.get("words", [])
                ],
            })
    payload = json.dumps({"protocol": 1, "duration": duration, "segments": segments}, ensure_ascii=False).encode()
    if len(payload) > int(max_bytes):
        return 1
    Path(output).write_bytes(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
