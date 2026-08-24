from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass(frozen=True)
class LicenseRecord:
    source: str = "unknown"
    license_id: str = "unverified"
    source_url: str = ""
    creator: str = ""
    commercial_use: bool = False
    sync_right: bool = False
    attribution_required: bool = False
    attribution_text: str = ""

    @property
    def eligible(self) -> bool:
        return self.commercial_use and self.sync_right

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["eligible"] = self.eligible
        return payload


@dataclass(frozen=True)
class MusicSection:
    start: float
    end: float
    kind: str = "section"
    tags: tuple[str, ...] = ()
    energy: float | None = None
    boundary_source: str = "metadata"

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    def to_dict(self) -> dict[str, Any]:
        return {
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "duration": round(self.duration, 3),
            "kind": self.kind,
            "tags": list(self.tags),
            "energy": round(self.energy, 6) if self.energy is not None else None,
            "boundary_source": self.boundary_source,
        }


@dataclass(frozen=True)
class MusicAsset:
    asset_id: str
    path: str
    title: str
    duration: float
    tags: tuple[str, ...] = ()
    moods: tuple[str, ...] = ()
    styles: tuple[str, ...] = ()
    bpm: float | None = None
    musical_key: str = ""
    vocal_probability: float = 0.0
    energy: float = 0.5
    sections: tuple[MusicSection, ...] = ()
    license: LicenseRecord = field(default_factory=LicenseRecord)
    beats: tuple[float, ...] = ()
    downbeats: tuple[float, ...] = ()
    energy_curve: tuple[tuple[float, float], ...] = ()
    analysis_source: str = "none"
    analysis_version: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "asset_id": self.asset_id,
            "path": self.path,
            "title": self.title,
            "duration": round(self.duration, 3),
            "tags": list(self.tags),
            "moods": list(self.moods),
            "styles": list(self.styles),
            "bpm": self.bpm,
            "musical_key": self.musical_key,
            "vocal_probability": round(self.vocal_probability, 4),
            "energy": round(self.energy, 4),
            "sections": [item.to_dict() for item in self.sections],
            "license": self.license.to_dict(),
            "beats": [round(value, 6) for value in self.beats],
            "downbeats": [round(value, 6) for value in self.downbeats],
            "energy_curve": [
                {"time": round(time_value, 3), "value": round(value, 6)}
                for time_value, value in self.energy_curve
            ],
            "analysis_source": self.analysis_source,
            "analysis_version": self.analysis_version,
        }


@dataclass(frozen=True)
class MusicBrief:
    cue_id: str
    episode: int
    scene_id: str
    text: str
    start: float
    end: float
    purpose: str
    tags: tuple[str, ...]
    target_energy: float
    dialogue_density: float

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    def to_dict(self) -> dict[str, Any]:
        return {
            "cue_id": self.cue_id,
            "episode": self.episode,
            "scene_id": self.scene_id,
            "text": self.text,
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "duration": round(self.duration, 3),
            "purpose": self.purpose,
            "tags": list(self.tags),
            "target_energy": round(self.target_energy, 4),
            "dialogue_density": round(self.dialogue_density, 4),
        }


@dataclass(frozen=True)
class MusicCandidate:
    cue_id: str
    asset_id: str
    source_start: float
    source_end: float
    score: float
    scores: dict[str, float]
    eligible: bool
    rejection_reason: str = ""
    boundary_source: str = "section"
    beat_aligned: bool = False
    alignment_error: float | None = None

    @property
    def source_duration(self) -> float:
        return max(0.0, self.source_end - self.source_start)

    def to_dict(self) -> dict[str, Any]:
        return {
            "cue_id": self.cue_id,
            "asset_id": self.asset_id,
            "source_start": round(self.source_start, 3),
            "source_end": round(self.source_end, 3),
            "source_duration": round(self.source_duration, 3),
            "score": round(self.score, 6),
            "scores": {key: round(value, 6) for key, value in self.scores.items()},
            "eligible": self.eligible,
            "rejection_reason": self.rejection_reason,
            "boundary_source": self.boundary_source,
            "beat_aligned": self.beat_aligned,
            "alignment_error": round(self.alignment_error, 6) if self.alignment_error is not None else None,
        }
