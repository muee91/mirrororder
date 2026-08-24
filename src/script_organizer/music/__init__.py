"""MirrorOrder Auto Score.

This package is intentionally isolated from production review/editorial
authority. It produces derived music planning artifacts only. Audio analysis,
semantic retrieval, generated-music providers, and the V1 edit model are
optional/derived layers and never become decision authority outside music.
"""

from .edit_model import build_music_edit_plan
from .library import index_music_library
from .runtime import build_music_plan

__all__ = ["build_music_edit_plan", "build_music_plan", "index_music_library"]
