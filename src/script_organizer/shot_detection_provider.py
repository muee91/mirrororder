"""Optional PySceneDetect-backed shot boundary provider.

Shot boundaries are evidence only. They are never promoted to Take or
multicam authority without the existing audio/timecode and human review flow.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any


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

    def __init__(self, *, threshold: float = 27.0) -> None:
        self.threshold = float(threshold)

    def available(self) -> bool:
        try:
            import scenedetect  # noqa: F401
        except ImportError:
            return False
        return True

    def detect(self, media_path: str | Path) -> list[ShotBoundary]:
        try:
            from scenedetect import ContentDetector, open_video, scene_manager
        except ImportError as error:
            raise RuntimeError("PySceneDetect 未安装") from error
        manager = scene_manager.SceneManager()
        manager.add_detector(ContentDetector(threshold=self.threshold))
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
