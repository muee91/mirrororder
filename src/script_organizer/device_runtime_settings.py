from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .local_intelligence_profiles import IDENTITY_PROFILES, SAMPLING_PROFILES
from .local_vision_runtime import DEFAULT_LOCAL_VISION_MODEL


def application_support_root() -> Path:
    override = os.environ.get("MIRRORORDER_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return Path.home() / "Library" / "Application Support" / "MirrorOrder"


def settings_path() -> Path:
    return application_support_root() / "runtime-settings.json"


def _default() -> dict[str, Any]:
    return {
        "version": 4,
        "local_vision_enabled": False,
        "local_vision_model": DEFAULT_LOCAL_VISION_MODEL,
        "face_identity_enabled": False,
        "speaker_identity_enabled": False,
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


def load_runtime_settings() -> dict[str, Any]:
    payload = _default()
    raw = _read_raw()
    payload["local_vision_enabled"] = bool(raw.get("local_vision_enabled", payload["local_vision_enabled"]))
    payload["face_identity_enabled"] = bool(raw.get("face_identity_enabled", payload["face_identity_enabled"]))
    payload["speaker_identity_enabled"] = bool(raw.get("speaker_identity_enabled", payload["speaker_identity_enabled"]))
    model = str(raw.get("local_vision_model", "") or "").strip()
    if model:
        payload["local_vision_model"] = model[:300]
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
    if "local_vision_model" in raw:
        model = str(raw.get("local_vision_model", "") or "").strip()
        if not model:
            raise ValueError("本地视觉模型不能为空")
        payload["local_vision_model"] = model[:300]
    payload["version"] = 4
    existing = _read_raw()
    if isinstance(existing.get("project_intelligence"), dict):
        payload["project_intelligence"] = existing["project_intelligence"]
    _write(payload)
    return payload


def load_project_intelligence_settings(workspace_id: str, project_id: str) -> dict[str, Any]:
    """Read project-local analysis preferences from this Mac only.

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
    payload["version"] = 4
    _write(payload)
    return load_project_intelligence_settings(workspace, project)
