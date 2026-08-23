from __future__ import annotations

# Stable import surface for Host/tasks/tests. V3 keeps the sparse multicamera
# person tracks and offline diarization from V2 while preserving each evidence
# observation's real source clip for playback/inspection.
from .identity_index_v3 import FaceEmbeddingProvider, IdentityIndexer, SpeakerEmbeddingProvider

__all__ = ["FaceEmbeddingProvider", "SpeakerEmbeddingProvider", "IdentityIndexer"]
