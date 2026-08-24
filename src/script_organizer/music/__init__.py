"""MirrorOrder Auto Score V0.2.

The music package is intentionally isolated from production review/editorial
authority. It produces derived music planning artifacts only. Optional audio
analysis enriches moment grounding without becoming a core runtime dependency.
"""

from .library import index_music_library
from .runtime import build_music_plan

__all__ = ["build_music_plan", "index_music_library"]
