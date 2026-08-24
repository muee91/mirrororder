"""MirrorOrder Auto Score.

This package is intentionally isolated from production review/editorial
authority. It produces derived music planning artifacts only. Audio analysis,
semantic retrieval, and generated-music providers are optional enhancement
layers and never become decision authority outside the music plan.
"""

from .library import index_music_library
from .runtime import build_music_plan

__all__ = ["build_music_plan", "index_music_library"]
