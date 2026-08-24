"""MirrorOrder Auto Score V0.

The music package is intentionally isolated from production review/editorial
authority. It produces derived music planning artifacts only.
"""

from .library import index_music_library
from .runtime import build_music_plan

__all__ = ["build_music_plan", "index_music_library"]
