from __future__ import annotations

# Compatibility module. Keep the public import surface stable while the active
# implementation evolves independently.
from .identity_runtime_v3 import (
    FACE_DETECTOR,
    FACE_RECOGNIZER,
    SPEAKER_EMBEDDER,
    SPEAKER_SEGMENTER,
    IdentityRuntime,
    ModelArtifact,
    identity_model_root,
    identity_python_root,
)
from .identity_role_inference import install_identity_role_inference

# Role candidates are a derived, read-only convenience layer over the device-
# local identity library. They never write role_name or human_confirmed.
install_identity_role_inference()

__all__ = [
    "ModelArtifact",
    "FACE_DETECTOR",
    "FACE_RECOGNIZER",
    "SPEAKER_SEGMENTER",
    "SPEAKER_EMBEDDER",
    "IdentityRuntime",
    "identity_model_root",
    "identity_python_root",
]