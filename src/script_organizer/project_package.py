from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Mapping


PROJECT_PACKAGE_FORMAT = "mirrororder-project"
PROJECT_PACKAGE_SCHEMA_VERSION = 1
PROJECT_PACKAGE_EXTENSION = ".mirrorproj"
LEGACY_PROJECT_SCHEMA_VERSION = 0


class ProjectPackageError(ValueError):
    """Raised when a project manifest violates the MirrorOrder package contract."""


class UnsupportedProjectPackage(ProjectPackageError):
    """Raised when a manifest belongs to an unsupported format or schema version."""


@dataclass(frozen=True)
class ProjectPackageManifest:
    manifest_path: Path
    format: str
    schema_version: int
    project_id: str
    name: str
    legacy: bool
    data: Mapping[str, Any]

    @property
    def needs_migration(self) -> bool:
        return self.legacy


_PORTABLE_PATH_FIELDS: tuple[tuple[str, str], ...] = (
    ("input", "script"),
    ("input", "fcpxml"),
    ("output", "directory"),
    ("asr", "transcript_dir"),
    ("compat", "overrides"),
    ("web", "directory"),
)

_DEVICE_LOCAL_MEDIA_FIELDS: tuple[tuple[str, str], ...] = (
    ("input", "media_root"),
    ("media", "root"),
    ("media", "roots"),
)

_WINDOWS_DRIVE_PATH = re.compile(r"^[A-Za-z]:[\\/]")


def _section(raw: Mapping[str, Any], name: str) -> Mapping[str, Any]:
    value = raw.get(name, {})
    return value if isinstance(value, Mapping) else {}


def _field(raw: Mapping[str, Any], section: str, key: str) -> Any:
    return _section(raw, section).get(key)


def validate_project_relative_path(value: object, *, field: str) -> str:
    """Validate one path that must remain portable inside the project root."""
    if not isinstance(value, str) or not value.strip():
        raise ProjectPackageError(f"{field} 必须是非空项目相对路径")
    candidate = value.strip()
    normalized = candidate.replace("\\", "/")
    if (
        normalized.startswith("/")
        or normalized.startswith("//")
        or _WINDOWS_DRIVE_PATH.match(candidate)
        or candidate.startswith("~")
        or candidate.startswith("$")
    ):
        raise ProjectPackageError(f"{field} 不能包含设备绝对路径：{candidate}")
    parts = PurePosixPath(normalized).parts
    if ".." in parts:
        raise ProjectPackageError(f"{field} 不能逃逸项目目录：{candidate}")
    return candidate


def _validate_v1(raw: Mapping[str, Any]) -> None:
    project = _section(raw, "project")
    project_id = str(project.get("id", "") or "").strip()
    name = str(project.get("name", "") or "").strip()
    if not project_id:
        raise ProjectPackageError("project.id 是 MirrorOrder Project v1 必填字段")
    if not name:
        raise ProjectPackageError("project.name 是 MirrorOrder Project v1 必填字段")

    inputs = _section(raw, "input")
    input_kind = str(inputs.get("kind", "") or "").strip()
    if input_kind not in {"fcpxml", "media-directory"}:
        raise ProjectPackageError("input.kind 必须是 fcpxml 或 media-directory")
    if "script" not in inputs:
        raise ProjectPackageError("input.script 是 MirrorOrder Project v1 必填字段")
    if input_kind == "fcpxml" and "fcpxml" not in inputs:
        raise ProjectPackageError("fcpxml 项目必须声明 input.fcpxml")

    for section, key in _DEVICE_LOCAL_MEDIA_FIELDS:
        if key in _section(raw, section):
            raise ProjectPackageError(
                f"{section}.{key} 属于 device-local media binding，不能写入 Project v1 manifest"
            )

    for section, key in _PORTABLE_PATH_FIELDS:
        value = _field(raw, section, key)
        if value is not None:
            validate_project_relative_path(value, field=f"{section}.{key}")


def load_project_package_manifest(path: str | Path) -> ProjectPackageManifest:
    """Read and validate a MirrorOrder project manifest without mutating it.

    Legacy manifests that predate explicit format/schema markers remain readable
    as schema 0. Explicitly marked manifests are strict: an unknown format,
    future schema, malformed marker pair, or non-portable v1 path fails fast.
    """
    candidate = Path(path).expanduser()
    manifest_path = candidate / "project.toml" if candidate.is_dir() else candidate
    manifest_path = manifest_path.resolve()
    with manifest_path.open("rb") as handle:
        raw = tomllib.load(handle)
    if not isinstance(raw, dict):
        raise ProjectPackageError("project.toml 顶层必须是 TOML table")

    project = _section(raw, "project")
    format_value = project.get("format")
    schema_value = project.get("schema_version")
    project_id = str(project.get("id", "") or "").strip()
    name = str(project.get("name", manifest_path.parent.name) or manifest_path.parent.name)

    if format_value is None and schema_value is None:
        return ProjectPackageManifest(
            manifest_path=manifest_path,
            format=PROJECT_PACKAGE_FORMAT,
            schema_version=LEGACY_PROJECT_SCHEMA_VERSION,
            project_id=project_id,
            name=name,
            legacy=True,
            data=raw,
        )
    if format_value is None or schema_value is None:
        raise ProjectPackageError("project.format 与 project.schema_version 必须同时声明")
    if str(format_value) != PROJECT_PACKAGE_FORMAT:
        raise UnsupportedProjectPackage(f"不支持的项目格式：{format_value}")
    if isinstance(schema_value, bool) or not isinstance(schema_value, int):
        raise ProjectPackageError("project.schema_version 必须是整数")
    if schema_value != PROJECT_PACKAGE_SCHEMA_VERSION:
        raise UnsupportedProjectPackage(
            f"不支持的 MirrorOrder Project schema：{schema_value}；当前支持 {PROJECT_PACKAGE_SCHEMA_VERSION}"
        )

    _validate_v1(raw)
    return ProjectPackageManifest(
        manifest_path=manifest_path,
        format=PROJECT_PACKAGE_FORMAT,
        schema_version=schema_value,
        project_id=project_id,
        name=name,
        legacy=False,
        data=raw,
    )
