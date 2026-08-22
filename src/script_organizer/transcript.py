from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path

from .models import Clip, Transcript, TranscriptSegment


def media_fingerprint(path: str | Path) -> str:
    target = Path(path)
    try:
        stat = target.stat()
        raw = f"{target.resolve()}|{stat.st_size}|{stat.st_mtime_ns}".encode("utf-8")
    except OSError:
        raw = f"{target.resolve()}|missing".encode("utf-8")
    return hashlib.sha1(raw).hexdigest()


def _segments(raw: object) -> tuple[TranscriptSegment, ...]:
    result = []
    if not isinstance(raw, list):
        return ()
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            start = float(item.get("start", 0) or 0)
            end = float(item.get("end", start) or start)
        except (TypeError, ValueError):
            continue
        text = str(item.get("text", "") or "").strip()
        if text:
            result.append(TranscriptSegment(start, max(start, end), text))
    return tuple(result)


def slice_transcript(transcript: Transcript, start: float, end: float | None) -> Transcript:
    """Return the transcript inside one effective source range, shifted to zero."""
    lower = max(0.0, float(start or 0.0))
    upper = float(end) if end is not None else float("inf")
    if upper <= lower:
        return Transcript(
            clip_id=transcript.clip_id,
            source_clip=transcript.source_clip,
            fingerprint=transcript.fingerprint,
            text="",
            segments=(),
            backend=transcript.backend,
            error=transcript.error,
        )
    if not transcript.segments:
        if lower <= 0.001 and upper == float("inf"):
            return transcript
        return Transcript(
            clip_id=transcript.clip_id,
            source_clip=transcript.source_clip,
            fingerprint=transcript.fingerprint,
            text="",
            segments=(),
            backend=transcript.backend,
            error=transcript.error,
        )
    selected = []
    for segment in transcript.segments:
        if segment.end <= lower or segment.start >= upper:
            continue
        selected.append(
            TranscriptSegment(
                start=max(0.0, segment.start - lower),
                end=max(0.0, min(segment.end, upper) - lower),
                text=segment.text,
            )
        )
    return Transcript(
        clip_id=transcript.clip_id,
        source_clip=transcript.source_clip,
        fingerprint=transcript.fingerprint,
        text="".join(segment.text for segment in selected),
        segments=tuple(selected),
        backend=transcript.backend,
        error=transcript.error,
    )


class TranscriptStore:
    def __init__(self, directory: str | Path):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)

    def paths_for(self, clip: Clip) -> list[Path]:
        fingerprint = media_fingerprint(clip.media_path)
        return [self.directory / f"{fingerprint}.json", self.directory / f"{clip.name}.json"]

    def load(self, clip: Clip) -> Transcript | None:
        fingerprint = media_fingerprint(clip.media_path)
        for path in self.paths_for(clip):
            if not path.exists():
                continue
            try:
                with path.open(encoding="utf-8") as handle:
                    raw = json.load(handle)
            except (OSError, ValueError):
                continue
            if not isinstance(raw, dict):
                continue
            text = str(raw.get("text", "") or "")
            segments = _segments(raw.get("segments", []))
            if not text:
                text = "".join(segment.text for segment in segments)
            return Transcript(
                clip_id=clip.clip_id,
                source_clip=clip.name,
                fingerprint=str(raw.get("fingerprint", fingerprint)),
                text=text,
                segments=segments,
                backend=str(raw.get("backend", "cache")),
                error=str(raw.get("error", "") or ""),
            )
        return None

    def write(self, clip: Clip, text: str, segments: list[dict], backend: str = "cache", error: str = "") -> Path:
        target = self.directory / f"{media_fingerprint(clip.media_path)}.json"
        payload = {
            "clip_id": clip.clip_id,
            "source_clip": clip.name,
            "fingerprint": media_fingerprint(clip.media_path),
            "text": text,
            "segments": segments,
            "backend": backend,
            "error": error,
        }
        fd, temporary = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=self.directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        return target


def transcribe_with_faster_whisper(clip: Clip, store: TranscriptStore, model: object, language: str = "zh") -> Transcript:
    """Run optional first-stage ASR with word timestamps and VAD."""
    result, _info = model.transcribe(
        clip.media_path,
        language=language,
        word_timestamps=True,
        vad_filter=True,
    )
    segments = []
    texts = []
    for segment in result:
        text = str(getattr(segment, "text", "") or "").strip()
        if not text:
            continue
        texts.append(text)
        row = {"start": float(segment.start), "end": float(segment.end), "text": text}
        words = []
        for word in getattr(segment, "words", []) or []:
            words.append({"start": float(word.start), "end": float(word.end), "word": str(word.word)})
        if words:
            row["words"] = words
        segments.append(row)
    text = "".join(texts)
    error = "" if text.strip() or segments else "no_speech_or_only_production_command"
    store.write(clip, text, segments, backend="faster-whisper", error=error)
    return Transcript(
        clip_id=clip.clip_id,
        source_clip=clip.name,
        fingerprint=media_fingerprint(clip.media_path),
        text=text,
        segments=_segments(segments),
        backend="faster-whisper",
        error=error,
    )
