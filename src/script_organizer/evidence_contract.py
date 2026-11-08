"""Stable, provider-neutral evidence sidecar contract for pre-edit decisions.

The sidecar is deliberately separate from Review placement and Editorial
Decision. Providers may add evidence, but only a human action can promote it
into an authoritative mapping or edit decision.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

CONTRACT = "mirrororder.evidence.v1"


@dataclass(frozen=True)
class EvidenceSpan:
    start_seconds: float
    end_seconds: float
    start_frame: int | None = None
    end_frame: int | None = None
    source_timecode: str | None = None


@dataclass(frozen=True)
class EvidenceProvenance:
    provider: str
    model: str = ""
    model_version: str = ""
    confidence: float | None = None
    generated_at: str = ""


@dataclass(frozen=True)
class EvidenceItem:
    kind: str
    value: str
    span: EvidenceSpan | None = None
    speaker: str | None = None
    provenance: EvidenceProvenance = field(default_factory=lambda: EvidenceProvenance("manual"))


@dataclass(frozen=True)
class EvidenceSidecar:
    asset_id: str
    content_hash: str
    display_name: str
    duration_seconds: float | None = None
    source_timecode: str | None = None
    take_id: str | None = None
    multicam_group_id: str | None = None
    items: tuple[EvidenceItem, ...] = ()
    schema: str = CONTRACT
    version: int = 1

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "EvidenceSidecar":
        if str(payload.get("schema", CONTRACT)) != CONTRACT:
            raise ValueError("不支持的 evidence sidecar contract")
        items: list[EvidenceItem] = []
        for raw in payload.get("items", []):
            span = raw.get("span")
            provenance = raw.get("provenance") or {}
            items.append(
                EvidenceItem(
                    kind=str(raw.get("kind", "")),
                    value=str(raw.get("value", "")),
                    span=EvidenceSpan(**span) if isinstance(span, dict) else None,
                    speaker=raw.get("speaker"),
                    provenance=EvidenceProvenance(**provenance),
                )
            )
        return cls(
            asset_id=str(payload.get("asset_id", "")),
            content_hash=str(payload.get("content_hash", "")),
            display_name=str(payload.get("display_name", "")),
            duration_seconds=payload.get("duration_seconds"),
            source_timecode=payload.get("source_timecode"),
            take_id=payload.get("take_id"),
            multicam_group_id=payload.get("multicam_group_id"),
            items=tuple(items),
            schema=CONTRACT,
            version=int(payload.get("version", 1) or 1),
        )
