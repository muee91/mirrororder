from __future__ import annotations

# Stable import surface for Host/tasks/tests. The active implementation adds
# sparse multicamera person tracks and offline speaker diarization while the
# preserved baseline remains available for compatibility.
from .identity_index_v2 import FaceEmbeddingProvider, IdentityIndexer, SpeakerEmbeddingProvider

__all__ = ["FaceEmbeddingProvider", "SpeakerEmbeddingProvider", "IdentityIndexer"]
