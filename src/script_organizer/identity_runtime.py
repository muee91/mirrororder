from __future__ import annotations

# Compatibility module. Keep the public import surface stable while the active
# implementation evolves independently. Importing this module must not mutate
# global Host runtime state; role-inference installation belongs to the explicit
# identity API installer in the Production runtime stack.
from .identity_runtime_v3 import (
    FACE_DETECTOR,
    FACE_RECOGNIZER,
    SPEAKER_EMBEDDER,
    SPEAKER_SEGMENTER,
    IdentityPreparationCancelled,
    IdentityRuntime,
    ModelArtifact,
    identity_model_root,
    identity_python_root,
)

__all__ = [
    "ModelArtifact",
    "FACE_DETECTOR",
    "FACE_RECOGNIZER",
    "SPEAKER_SEGMENTER",
    "SPEAKER_EMBEDDER",
    "IdentityPreparationCancelled",
    "IdentityRuntime",
    "identity_model_root",
    "identity_python_root",
]
