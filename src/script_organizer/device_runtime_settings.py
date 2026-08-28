from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

from .local_intelligence_profiles import IDENTITY_PROFILES, SAMPLING_PROFILES
from .local_vision_runtime import DEFAULT_LOCAL_VISION_MODEL
from .semantic_profiles import PROFILES as SEMANTIC_PROFILES


def application_support_root() -> Path:
    override = os.environ.get("MIRRORORDER_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "MirrorOrder"
    if os.name == "nt":
        return Path(os.environ.get("APPDATA", Path.home())) / "MirrorOrder"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "mirrororder"


def settings_path() -> Path:
    return application_support_root() / "runtime-settings.json"


def _default() -> dict[str, Any]:
    return {
        "version": 5,
        "local_vision_enabled": False,
        "local_vision_model": DEFAULT_LOCAL_VISION_MODEL,
        "face_identity_enabled": False,
        "speaker_identity_enabled": False,
        # Standard is the product default, but the large local model is opt-in:
        # enabling it may download several GB and must never happen from search.
        "semantic_embedding_enabled": False,
        "semantic_embedding_profile": "standard",
        "semantic_embedding_dimensions": 1024,
        "default_perception_sampling_profile": "standard",
        "default_identity_matching_profile": "balanced",
        "project_intelligence": {},
    }


def _read_raw() -> dict[str, Any]:
    try:
        raw = json.loads(settings_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return raw if isinstance(raw, dict) else {}


def _write(payload: dict[str, Any]) -> None:
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _profile(raw: dict[str, Any], key: str, legacy_key: str, allowed: dict[str, Any], fallback: str) -> str:
    value = str(raw.get(key, raw.get(legacy_key, "")) or "").strip()
    return value if value in allowed else fallback


def _semantic_dimensions(profile_key: str, value: object) -> int:
    profile = SEMANTIC_PROFILES.get(profile_key, SEMANTIC_PROFILES["standard"])
    try:
        dimensions = int(value)
    except (TypeError, ValueError):
        dimensions = profile.default_dimensions
    if dimensions < 64 or dimensions > profile.max_dimensions:
        return profile.default_dimensions
    return dimensions


def load_runtime_settings() -> dict[str, Any]:
    payload = _default()
    raw = _read_raw()
    payload["local_vision_enabled"] = bool(raw.get("local_vision_enabled", payload["local_vision_enabled"]))
    payload["face_identity_enabled"] = bool(raw.get("face_identity_enabled", payload["face_identity_enabled"]))
    payload["speaker_identity_enabled"] = bool(raw.get("speaker_identity_enabled", payload["speaker_identity_enabled"]))
    payload["semantic_embedding_enabled"] = bool(raw.get("semantic_embedding_enabled", payload["semantic_embedding_enabled"]))
    model = str(raw.get("local_vision_model", "") or "").strip()
    if model:
        payload["local_vision_model"] = model[:300]
    semantic_profile = str(raw.get("semantic_embedding_profile", payload["semantic_embedding_profile"]) or "").strip().lower()
    if semantic_profile not in SEMANTIC_PROFILES:
        semantic_profile = "standard"
    payload["semantic_embedding_profile"] = semantic_profile
    payload["semantic_embedding_dimensions"] = _semantic_dimensions(
        semantic_profile,
        raw.get("semantic_embedding_dimensions", payload["semantic_embedding_dimensions"]),
    )
    payload["default_perception_sampling_profile"] = _profile(
        raw,
        "default_perception_sampling_profile",
        "perception_sampling_profile",
        SAMPLING_PROFILES,
        "standard",
    )
    payload["default_identity_matching_profile"] = _profile(
        raw,
        "default_identity_matching_profile",
        "identity_matching_profile",
        IDENTITY_PROFILES,
        "balanced",
    )
    return payload


def save_runtime_settings(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("本机运行时设置必须是对象")
    payload = load_runtime_settings()
    if "local_vision_enabled" in raw:
        payload["local_vision_enabled"] = bool(raw["local_vision_enabled"])
    if "face_identity_enabled" in raw:
        payload["face_identity_enabled"] = bool(raw["face_identity_enabled"])
    if "speaker_identity_enabled" in raw:
        payload["speaker_identity_enabled"] = bool(raw["speaker_identity_enabled"])
    if "semantic_embedding_enabled" in raw:
        payload["semantic_embedding_enabled"] = bool(raw["semantic_embedding_enabled"])
    if "local_vision_model" in raw:
        model = str(raw.get("local_vision_model", "") or "").strip()
        if not model:
            raise ValueError("本地视觉模型不能为空")
        payload["local_vision_model"] = model[:300]
    if "semantic_embedding_profile" in raw:
        profile = str(raw.get("semantic_embedding_profile", "") or "").strip().lower()
        if profile not in SEMANTIC_PROFILES:
            raise ValueError("语义索引预设必须是 standard 或 lightweight")
        payload["semantic_embedding_profile"] = profile
        # A profile switch resets incompatible custom dimensions unless the same
        # request explicitly supplies a valid dimension for the new profile.
        if "semantic_embedding_dimensions" not in raw:
            payload["semantic_embedding_dimensions"] = SEMANTIC_PROFILES[profile].default_dimensions
    if "semantic_embedding_dimensions" in raw:
        profile_key = str(payload.get("semantic_embedding_profile", "standard") or "standard")
        dimensions = _semantic_dimensions(profile_key, raw.get("semantic_embedding_dimensions"))
        requested = int(raw.get("semantic_embedding_dimensions", dimensions) or dimensions)
        if requested != dimensions:
            profile = SEMANTIC_PROFILES[profile_key]
            raise ValueError(f"语义向量维度必须在 64–{profile.max_dimensions} 之间")
        payload["semantic_embedding_dimensions"] = dimensions
    payload["version"] = 5
    existing = _read_raw()
    if isinstance(existing.get("project_intelligence"), dict):
        payload["project_intelligence"] = existing["project_intelligence"]
    _write(payload)
    return payload


def load_project_intelligence_settings(workspace_id: str, project_id: str) -> dict[str, Any]:
    """Read project-local analysis preferences from this device only.

    These controls tune rebuildable local evidence. They intentionally do not
    belong in project.toml or any shared project artifact.
    """

    workspace = str(workspace_id or "").strip()
    project = str(project_id or "").strip()
    if not workspace or not project:
        raise ValueError("workspace_id 和 project_id 不能为空")
    runtime = load_runtime_settings()
    raw = _read_raw()
    projects = raw.get("project_intelligence", {})
    scoped: object = {}
    if isinstance(projects, dict):
        workspace_entries = projects.get(workspace, {})
        if isinstance(workspace_entries, dict):
            scoped = workspace_entries.get(project, {})
    values = scoped if isinstance(scoped, dict) else {}
    sampling = str(values.get("perception_sampling_profile", "") or "").strip()
    identity = str(values.get("identity_matching_profile", "") or "").strip()
    inherited = {
        "perception_sampling_profile": sampling not in SAMPLING_PROFILES,
        "identity_matching_profile": identity not in IDENTITY_PROFILES,
    }
    return {
        "perception_sampling_profile": (
            sampling if sampling in SAMPLING_PROFILES
            else runtime["default_perception_sampling_profile"]
        ),
        "identity_matching_profile": (
            identity if identity in IDENTITY_PROFILES
            else runtime["default_identity_matching_profile"]
        ),
        "inherited": inherited,
    }


def save_project_intelligence_settings(
    workspace_id: str,
    project_id: str,
    raw: object,
) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("项目智能设置必须是对象")
    workspace = str(workspace_id or "").strip()
    project = str(project_id or "").strip()
    if not workspace or not project:
        raise ValueError("workspace_id 和 project_id 不能为空")
    current = load_project_intelligence_settings(workspace, project)
    sampling = str(raw.get("perception_sampling_profile", current["perception_sampling_profile"]) or "").strip()
    identity = str(raw.get("identity_matching_profile", current["identity_matching_profile"]) or "").strip()
    if sampling not in SAMPLING_PROFILES:
        raise ValueError("取帧策略必须是 quick、standard、detailed 或 adaptive")
    if identity not in IDENTITY_PROFILES:
        raise ValueError("身份识别预设必须是 conservative、balanced 或 permissive")

    payload = load_runtime_settings()
    existing = _read_raw()
    projects = existing.get("project_intelligence", {})
    if not isinstance(projects, dict):
        projects = {}
    workspace_entries = projects.get(workspace, {})
    if not isinstance(workspace_entries, dict):
        workspace_entries = {}
    workspace_entries[project] = {
        "perception_sampling_profile": sampling,
        "identity_matching_profile": identity,
    }
    projects[workspace] = workspace_entries
    payload["project_intelligence"] = projects
    _write(payload)
    return load_project_intelligence_settings(workspace, project)
