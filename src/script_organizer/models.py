from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field
from fractions import Fraction
from typing import Any


@dataclass(frozen=True)
class Clip:
    clip_id: str
    name: str
    camera: str
    media_path: str
    timeline_start: Fraction
    timeline_end: Fraction
    duration: Fraction
    exists: bool
    source_asset_id: str = ""
    source_start: Fraction = Fraction(0)
    source_end: Fraction | None = None
    media_id: str = ""

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        for key in ("timeline_start", "timeline_end", "duration"):
            result[key] = float(result[key])
        result["source_start"] = float(result["source_start"])
        result["source_end"] = float(result["source_end"]) if result["source_end"] is not None else None
        return result


@dataclass(frozen=True)
class GroupMember:
    clip_id: str
    camera: str
    name: str
    media_path: str
    timeline_start: Fraction
    timeline_end: Fraction
    duration: Fraction
    exists: bool
    source_start: Fraction = Fraction(0)
    source_end: Fraction | None = None
    media_id: str = ""

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        for key in ("timeline_start", "timeline_end", "duration"):
            result[key] = float(result[key])
        result["source_start"] = float(result["source_start"])
        result["source_end"] = float(result["source_end"]) if result["source_end"] is not None else None
        return result


@dataclass(frozen=True)
class MulticamGroup:
    group_id: str
    start: float
    end: float
    members: tuple[GroupMember, ...]
    cameras: tuple[str, ...]
    kind: str = "multicam"
    parent_group_id: str = ""
    take_index: int = 1
    split_reason: str = ""

    @property
    def duration(self) -> Fraction:
        return max(Fraction(0), self.end - self.start)

    def to_dict(self) -> dict[str, Any]:
        return {
            "group_id": self.group_id,
            "start": float(self.start),
            "end": float(self.end),
            "duration": float(self.duration),
            "members": [member.to_dict() for member in self.members],
            "cameras": list(self.cameras),
            "kind": self.kind,
            "parent_group_id": self.parent_group_id,
            "take_index": self.take_index,
            "split_reason": self.split_reason,
        }


@dataclass(frozen=True)
class ScriptSegment:
    segment_id: str
    episode: int
    scene_id: str
    order: int
    type: str
    speaker: str
    text: str
    raw_text: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class TranscriptSegment:
    start: float
    end: float
    text: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Transcript:
    clip_id: str
    source_clip: str
    fingerprint: str
    text: str
    segments: tuple[TranscriptSegment, ...] = field(default_factory=tuple)
    backend: str = "cache"
    error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "clip_id": self.clip_id,
            "source_clip": self.source_clip,
            "fingerprint": self.fingerprint,
            "text": self.text,
            "segments": [segment.to_dict() for segment in self.segments],
            "backend": self.backend,
            "error": self.error,
        }


@dataclass(frozen=True)
class Candidate:
    group_id: str
    script_segment_id: str | None
    total_score: float
    dialogue_score: float
    sequence_score: float
    context_score: float
    margin: float
    method: str
    confidence: str
    evidence: tuple[str, ...] = field(default_factory=tuple)
    script_segment_ids: tuple[str, ...] = field(default_factory=tuple)
    transcript_clip_id: str | None = None
    transcript_text: str = ""
    relative_start: float | None = None
    relative_end: float | None = None
    alignment: dict[str, Any] = field(default_factory=dict)
    context_episodes: tuple[int, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["evidence"] = list(self.evidence)
        result["script_segment_ids"] = list(self.script_segment_ids or ((self.script_segment_id,) if self.script_segment_id else ()))
        result["context_episodes"] = list(self.context_episodes)
        seed = "|".join([self.group_id, *result["script_segment_ids"], str(self.relative_start or 0)])
        result["candidate_id"] = "K_" + hashlib.sha1(seed.encode("utf-8")).hexdigest()[:16]
        return result
