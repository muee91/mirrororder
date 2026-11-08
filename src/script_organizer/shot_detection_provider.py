"""Optional PySceneDetect-backed shot boundary provider.

Shot boundaries are evidence only. They are never promoted to Take or
multicam authority without the existing audio/timecode and human review flow.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .evidence_contract import EvidenceProvenance, EvidenceSidecar, EvidenceSpan, EvidenceItem

@dataclass(frozen=True)
class ShotBoundary:
    start_seconds: float
    end_seconds: float
    detector: str
    confidence: float | None = None


class ShotDetectionProvider:
    name = "none"

    def available(self) -> bool:
        return False

    def detect(self, media_path: str | Path) -> list[ShotBoundary]:
        raise RuntimeError("未安装可用的镜头切分 provider")


class PySceneDetectProvider(ShotDetectionProvider):
    name = "pyscenedetect"

    def __init__(self, *, adaptive_threshold: float = 3.0) -> None:
        self.adaptive_threshold = float(adaptive_threshold)

    def available(self) -> bool:
        try:
            import scenedetect  # noqa: F401
        except ImportError:
            return False
        return True

    def detect(self, media_path: str | Path) -> list[ShotBoundary]:
        try:
            from scenedetect import AdaptiveDetector, open_video, scene_manager
        except ImportError as error:
            raise RuntimeError("PySceneDetect 未安装") from error
        manager = scene_manager.SceneManager()
        manager.add_detector(AdaptiveDetector(adaptive_threshold=self.adaptive_threshold))
        manager.detect_scenes(open_video(str(media_path)))
        result: list[ShotBoundary] = []
        for start, end in manager.get_scene_list():
            result.append(
                ShotBoundary(
                    start_seconds=float(start.get_seconds()),
                    end_seconds=float(end.get_seconds()),
                    detector=self.name,
                )
            )
        return result


def provider_status(provider: ShotDetectionProvider) -> dict[str, Any]:
    return {"provider": provider.name, "available": provider.available()}


def detect_index_shots(index: dict[str, Any], provider: ShotDetectionProvider) -> tuple[list[EvidenceSidecar], list[dict[str, Any]]]:
    """Create path-free shot evidence for index clips when explicitly enabled."""
    sidecars: list[EvidenceSidecar] = []
    diagnostics: list[dict[str, Any]] = []
    for clip in index.get("clips", []):
        if not isinstance(clip, dict):
            continue
        media_path = str(clip.get("source_media_path", "") or clip.get("media_path", ""))
        asset_id = str(clip.get("media_id", "") or clip.get("source_asset_id", "") or clip.get("clip_id", ""))
        if not media_path or not asset_id:
            continue
        try:
            boundaries = provider.detect(media_path)
        except Exception as error:
            diagnostics.append({"asset_id": asset_id, "status": "failed", "provider": provider.name, "message": str(error)[:300]})
            continue
        items = tuple(
            EvidenceItem(
                kind="shot_boundary",
                value=f"shot-{index}",
                span=EvidenceSpan(boundary.start_seconds, boundary.end_seconds),
                provenance=EvidenceProvenance(provider.name),
            )
            for index, boundary in enumerate(boundaries)
        )
        sidecars.append(
            EvidenceSidecar(
                asset_id=asset_id,
                content_hash=str(clip.get("media_id", "") or "legacy_unknown"),
                display_name=Path(str(clip.get("name", "") or media_path)).name or asset_id,
                items=items,
            )
        )
    return sidecars, diagnostics
