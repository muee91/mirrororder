"""Optional PySceneDetect-backed shot boundary provider.

Shot boundaries are evidence only. They are never promoted to Take or
multicam authority without the existing audio/timecode and human review flow.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path
import threading
from typing import Any, Callable

from .evidence_contract import EvidenceProvenance, EvidenceSidecar, EvidenceSpan, EvidenceItem
from .media_identity import full_file_sha256
from .resource_scheduler import ResourceCancelled

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

    def detect(
        self,
        media_path: str | Path,
        *,
        duration_seconds: float | None = None,
        cancelled: Callable[[], bool] | None = None,
    ) -> list[ShotBoundary]:
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

    def detect(
        self,
        media_path: str | Path,
        *,
        duration_seconds: float | None = None,
        cancelled: Callable[[], bool] | None = None,
    ) -> list[ShotBoundary]:
        try:
            from scenedetect import AdaptiveDetector, open_video, scene_manager
        except ImportError as error:
            raise RuntimeError("PySceneDetect 未安装") from error
        if cancelled and cancelled():
            raise ResourceCancelled("镜头检测已取消")
        duration = _positive_finite(duration_seconds)
        manager = scene_manager.SceneManager()
        manager.add_detector(AdaptiveDetector(adaptive_threshold=self.adaptive_threshold))
        video = open_video(str(media_path))
        error: list[BaseException] = []

        def run() -> None:
            try:
                # The duration comes from the index clip, rather than trusting
                # detector output to stay inside the clip's source range.
                manager.detect_scenes(video, duration=duration, callback=_on_event)
            except BaseException as caught:  # re-raised on the calling thread
                error.append(caught)

        def _on_event(*_args: Any) -> None:
            # PySceneDetect invokes callbacks only for detected events.  The
            # polling loop below handles long clips with no cuts as well.
            if cancelled and cancelled():
                manager.stop()

        worker = threading.Thread(target=run, name="mirrororder-shot-detection", daemon=True)
        worker.start()
        was_cancelled = False
        while worker.is_alive():
            worker.join(0.05)
            if cancelled and cancelled():
                was_cancelled = True
                manager.stop()
        if cancelled and cancelled():
            was_cancelled = True
        close = getattr(video, "close", None)
        if callable(close):
            close()
        if was_cancelled:
            raise ResourceCancelled("镜头检测已取消")
        if error:
            raise error[0]
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


def _positive_finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def _clip_duration(clip: dict[str, Any]) -> float | None:
    duration = _positive_finite(clip.get("duration"))
    if duration is not None:
        return duration
    try:
        start = float(clip.get("source_start", 0) or 0)
        end = float(clip.get("source_end", 0) or 0)
    except (TypeError, ValueError):
        return None
    candidate = end - start
    return candidate if math.isfinite(candidate) and candidate > 0 else None


def _bounded_boundaries(boundaries: list[ShotBoundary], duration: float | None) -> list[ShotBoundary]:
    result: list[ShotBoundary] = []
    for boundary in boundaries:
        try:
            start = float(boundary.start_seconds)
            end = float(boundary.end_seconds)
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(start) and math.isfinite(end)):
            continue
        start = max(0.0, start)
        if duration is not None:
            start = min(start, duration)
            end = min(end, duration)
        if end <= start:
            continue
        result.append(
            ShotBoundary(
                start_seconds=start,
                end_seconds=end,
                detector=boundary.detector,
                confidence=boundary.confidence,
            )
        )
    return result


def detect_index_shots(
    index: dict[str, Any],
    provider: ShotDetectionProvider,
    *,
    cancelled: Callable[[], bool] | None = None,
) -> tuple[list[EvidenceSidecar], list[dict[str, Any]]]:
    """Create path-free shot evidence for index clips when explicitly enabled."""
    sidecars: list[EvidenceSidecar] = []
    diagnostics: list[dict[str, Any]] = []
    for clip in index.get("clips", []):
        if not isinstance(clip, dict):
            continue
        if cancelled and cancelled():
            raise ResourceCancelled("镜头检测已取消")
        media_path = str(clip.get("source_media_path", "") or clip.get("media_path", ""))
        asset_id = str(clip.get("media_id", "") or clip.get("source_asset_id", "") or clip.get("clip_id", ""))
        if not media_path or not asset_id:
            continue
        duration = _clip_duration(clip)
        try:
            boundaries = provider.detect(
                media_path,
                duration_seconds=duration,
                cancelled=cancelled,
            )
            boundaries = _bounded_boundaries(boundaries, duration)
        except ResourceCancelled:
            raise
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
                full_file_sha256=full_file_sha256(media_path) or None,
                duration_seconds=duration,
                items=items,
            )
        )
    return sidecars, diagnostics
