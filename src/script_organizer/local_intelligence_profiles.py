from __future__ import annotations

from typing import Any


SAMPLING_PROFILES: dict[str, dict[str, Any]] = {
    "quick": {
        "title": "快速",
        "tier0_frames": 1,
        "semantic_frames": 2,
        "ambiguous_semantic_frames": 2,
    },
    "standard": {
        "title": "标准",
        "tier0_frames": 1,
        "semantic_frames": 3,
        "ambiguous_semantic_frames": 3,
    },
    "detailed": {
        "title": "精细",
        "tier0_frames": 3,
        "semantic_frames": 5,
        "ambiguous_semantic_frames": 5,
    },
    "adaptive": {
        "title": "自适应",
        "tier0_frames": 1,
        "semantic_frames": 3,
        "ambiguous_semantic_frames": 5,
    },
}


IDENTITY_PROFILES: dict[str, dict[str, Any]] = {
    "conservative": {
        "title": "保守",
        "face_cluster_threshold": 0.62,
        "speaker_cluster_threshold": 0.76,
        "face_track_threshold": 0.62,
        "face_detection_threshold": 0.86,
        "diarization_threshold": 0.58,
        "face_frames_per_camera": 1,
    },
    "balanced": {
        "title": "平衡",
        "face_cluster_threshold": 0.45,
        "speaker_cluster_threshold": 0.65,
        "face_track_threshold": 0.50,
        "face_detection_threshold": 0.80,
        "diarization_threshold": 0.50,
        "face_frames_per_camera": 3,
    },
    "permissive": {
        "title": "宽松",
        "face_cluster_threshold": 0.35,
        "speaker_cluster_threshold": 0.55,
        "face_track_threshold": 0.42,
        "face_detection_threshold": 0.75,
        "diarization_threshold": 0.44,
        "face_frames_per_camera": 5,
    },
}


def sampling_profile(value: object) -> tuple[str, dict[str, Any]]:
    key = str(value or "").strip()
    if key not in SAMPLING_PROFILES:
        key = "standard"
    return key, dict(SAMPLING_PROFILES[key])


def identity_profile(value: object) -> tuple[str, dict[str, Any]]:
    key = str(value or "").strip()
    if key not in IDENTITY_PROFILES:
        key = "balanced"
    return key, dict(IDENTITY_PROFILES[key])
