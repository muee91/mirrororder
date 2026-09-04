from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence
from uuid import uuid4

from ..project_package import (
    PROJECT_PACKAGE_EXTENSION,
    PROJECT_PACKAGE_FORMAT,
    PROJECT_PACKAGE_SCHEMA_VERSION,
    ProjectPackageError,
    ProjectPackageManifest,
    load_project_package_manifest,
)

MIRROR_PACKAGE_ARCHIVE_EXTENSION = ".mirrorpkg"
MIRROR_PACKAGE_ARCHIVE_FORMAT = "mirrororder-project-archive"
MIRROR_PACKAGE_ARCHIVE_SCHEMA_VERSION = 1
_COPY_CHUNK_BYTES = 1024 * 1024
_PROJECT_KEY_LINE = re.compile(r"^\s*(format|schema_version|id|name)\s*=")
_NON_PORTABLE_PROJECT_FILES = {"output/tasks.json"}
_MEDIA_ID = re.compile(r"^(?:M|MP)_[A-Za-z0-9._-]{1,160}$")


class ProjectTransferError(ValueError):
    """Raised when a package import/export operation is unsafe or invalid."""


class ProjectTransferCancelled(ProjectTransferError):
    """Raised when a cancellable transfer is stopped by the user."""


@dataclass(frozen=True)
class TransferFile:
    source: Path
    relative: Path
    size: int
    mtime_ns: int


@dataclass(frozen=True)
class ProjectPackageInspection:
    root: Path
    manifest: ProjectPackageManifest

    def public(self) -> dict[str, object]:
        return {
            "format": self.manifest.format,
            "schema_version": self.manifest.schema_version,
            "legacy": self.manifest.legacy,
            "project_id": self.manifest.project_id,
            "name": self.manifest.name,
            "package_path": str(self.root),
            "device_path_exposed": True,
            "scope": "device_local_response",
        }


def _cancelled(cancelled: Callable[[], bool] | None) -> None:
    if cancelled and cancelled():
        raise ProjectTransferCancelled("项目传输已取消")


def _project_root(path: str | Path) -> Path:
    candidate = Path(path).expanduser().resolve()
    if candidate.is_file():
        if candidate.name != "project.toml":
            raise ProjectTransferError("项目包文件必须是 project.toml")
        candidate = candidate.parent
    if not candidate.is_dir():
        raise ProjectTransferError("项目包目录不存在")
    return candidate


def inspect_project_package(
    path: str | Path,
    *,
    require_external_suffix: bool = False,
) -> ProjectPackageInspection:
    root = _project_root(path)
    if require_external_suffix and root.suffix.lower() != PROJECT_PACKAGE_EXTENSION:
        raise ProjectTransferError(f"外部项目目录必须使用 {PROJECT_PACKAGE_EXTENSION} 后缀")
    try:
        manifest = load_project_package_manifest(root)
    except (OSError, ValueError) as error:
        if isinstance(error, ProjectPackageError):
            raise
        raise ProjectTransferError(f"无法读取项目包：{error}") from error
    return ProjectPackageInspection(root=root, manifest=manifest)


def _inventory(
    root: Path,
    *,
    include_cache: bool,
    cancelled: Callable[[], bool] | None = None,
) -> tuple[list[TransferFile], int]:
    files: list[TransferFile] = []
    total = 0
    for current, directories, names in os.walk(root, topdown=True, followlinks=False):
        _cancelled(cancelled)
        current_path = Path(current)
        safe_directories: list[str] = []
        for name in directories:
            child = current_path / name
            relative = child.relative_to(root)
            if relative.parts and relative.parts[0] == "cache" and not include_cache:
                continue
            if child.is_symlink():
                raise ProjectTransferError(f"项目包不能包含符号链接目录：{relative.as_posix()}")
            safe_directories.append(name)
        directories[:] = safe_directories
        for name in names:
            source = current_path / name
            relative = source.relative_to(root)
            if relative.parts and relative.parts[0] == "cache" and not include_cache:
                continue
            if relative.as_posix() in _NON_PORTABLE_PROJECT_FILES:
                continue
            if source.is_symlink():
                raise ProjectTransferError(f"项目包不能包含符号链接文件：{relative.as_posix()}")
            if not source.is_file():
                raise ProjectTransferError(f"项目包包含不支持的特殊文件：{relative.as_posix()}")
            stat = source.stat()
            size = stat.st_size
            files.append(
                TransferFile(
                    source=source,
                    relative=relative,
                    size=size,
                    mtime_ns=stat.st_mtime_ns,
                )
            )
            total += size
    files.sort(key=lambda item: item.relative.as_posix())
    if not any(item.relative.as_posix() == "project.toml" for item in files):
        raise ProjectTransferError("项目包缺少 project.toml")
    return files, total


def _verify_inventory(files: Sequence[TransferFile]) -> None:
    for item in files:
        try:
            stat = item.source.stat()
        except OSError as error:
            raise ProjectTransferError(
                f"项目在传输过程中发生变化：{item.relative.as_posix()}"
            ) from error
        if stat.st_size != item.size or stat.st_mtime_ns != item.mtime_ns:
            raise ProjectTransferError(
                f"项目在传输过程中发生变化：{item.relative.as_posix()}"
            )


def _check_destination(
    source_root: Path,
    destination: str | Path,
    *,
    extension: str | None,
) -> Path:
    target = Path(destination).expanduser()
    if extension and target.suffix.lower() != extension:
        target = target.with_name(target.name + extension)
    target = target.resolve()
    if target.exists():
        raise ProjectTransferError(f"目标已存在：{target}")
    if not target.parent.is_dir():
        raise ProjectTransferError(f"目标目录不存在：{target.parent}")
    try:
        target.relative_to(source_root)
    except ValueError:
        pass
    else:
        raise ProjectTransferError("目标不能位于源项目内部")
    return target


def _disk_preflight(parent: Path, required_bytes: int) -> None:
    try:
        free = shutil.disk_usage(parent).free
    except OSError:
        return
    reserve = min(256 * 1024 * 1024, max(16 * 1024 * 1024, required_bytes // 20))
    if free < required_bytes + reserve:
        raise ProjectTransferError("目标磁盘可用空间不足")


def _copy_one(
    source: Path,
    destination: Path,
    *,
    cancelled: Callable[[], bool] | None = None,
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as reader, destination.open("xb") as writer:
        while True:
            _cancelled(cancelled)
            chunk = reader.read(_COPY_CHUNK_BYTES)
            if not chunk:
                break
            writer.write(chunk)
        writer.flush()
        os.fsync(writer.fileno())
    try:
        shutil.copystat(source, destination, follow_symlinks=False)
    except OSError:
        pass


def _toml_string(value: str) -> str:
    return json.dumps(str(value), ensure_ascii=False)


def rewrite_project_identity(
    manifest_path: str | Path,
    *,
    project_id: str,
    name: str,
) -> None:
    project_id = str(project_id or "").strip()
    name = str(name or "").strip()
    if not project_id:
        raise ProjectTransferError("另存项目需要新的 project_id")
    if not name:
        raise ProjectTransferError("另存项目需要项目名称")
    path = Path(manifest_path)
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    section_start = None
    section_end = len(lines)
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped == "[project]":
            section_start = index
            continue
        if section_start is not None and index > section_start and stripped.startswith("[") and stripped.endswith("]"):
            section_end = index
            break
    if section_start is None:
        raise ProjectTransferError("project.toml 缺少 [project] table")
    body = [
        line
        for line in lines[section_start + 1 : section_end]
        if not _PROJECT_KEY_LINE.match(line)
    ]
    canonical = [
        f"format = {_toml_string(PROJECT_PACKAGE_FORMAT)}",
        f"schema_version = {PROJECT_PACKAGE_SCHEMA_VERSION}",
        f"id = {_toml_string(project_id)}",
        f"name = {_toml_string(name)}",
    ]
    rewritten = [
        *lines[: section_start + 1],
        *canonical,
        *body,
        *lines[section_end:],
    ]
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write("\n".join(rewritten).rstrip() + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    load_project_package_manifest(path)


def copy_project_package(
    source: str | Path,
    destination: str | Path,
    *,
    include_cache: bool = True,
    new_project_id: str = "",
    new_name: str = "",
    require_external_source: bool = False,
    cancelled: Callable[[], bool] | None = None,
    destination_extension: str | None = PROJECT_PACKAGE_EXTENSION,
) -> dict[str, object]:
    inspection = inspect_project_package(source, require_external_suffix=require_external_source)
    files, total = _inventory(inspection.root, include_cache=include_cache, cancelled=cancelled)
    target = _check_destination(inspection.root, destination, extension=destination_extension)
    _disk_preflight(target.parent, total)
    staging = target.parent / f".mirrororder-transfer-{uuid4().hex}"
    staging.mkdir()
    copied = 0
    try:
        for item in files:
            _cancelled(cancelled)
            _copy_one(item.source, staging / item.relative, cancelled=cancelled)
            copied += item.size
        _verify_inventory(files)
        if new_project_id or new_name:
            rewrite_project_identity(
                staging / "project.toml",
                project_id=new_project_id or inspection.manifest.project_id,
                name=new_name or inspection.manifest.name,
            )
        copied_manifest = load_project_package_manifest(staging)
        _cancelled(cancelled)
        os.replace(staging, target)
        return {
            "package_path": str(target),
            "project_id": copied_manifest.project_id,
            "name": copied_manifest.name,
            "schema_version": copied_manifest.schema_version,
            "legacy": copied_manifest.legacy,
            "bytes": copied,
            "files": len(files),
            "cache_included": bool(include_cache),
        }
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def _zip_copy(
    archive: zipfile.ZipFile,
    source: Path,
    arcname: str,
    *,
    compress_type: int,
    cancelled: Callable[[], bool] | None = None,
) -> None:
    info = zipfile.ZipInfo.from_file(source, arcname)
    info.compress_type = compress_type
    with source.open("rb") as reader, archive.open(info, "w", force_zip64=True) as writer:
        while True:
            _cancelled(cancelled)
            chunk = reader.read(_COPY_CHUNK_BYTES)
            if not chunk:
                break
            writer.write(chunk)


def collect_project_archive(
    source: str | Path,
    destination: str | Path,
    *,
    include_cache: bool = False,
    media_files: Sequence[tuple[str, str | Path]] = (),
    cancelled: Callable[[], bool] | None = None,
) -> dict[str, object]:
    inspection = inspect_project_package(source)
    files, project_bytes = _inventory(
        inspection.root,
        include_cache=include_cache,
        cancelled=cancelled,
    )
    target = _check_destination(
        inspection.root,
        destination,
        extension=MIRROR_PACKAGE_ARCHIVE_EXTENSION,
    )

    normalized_media: list[tuple[str, Path, int, int, str]] = []
    seen_media: set[str] = set()
    media_bytes = 0
    for media_id, raw_path in media_files:
        _cancelled(cancelled)
        identity = str(media_id or "").strip()
        if not identity:
            continue
        if not _MEDIA_ID.fullmatch(identity):
            raise ProjectTransferError(f"收集媒体身份无效：{identity[:80]}")
        if identity in seen_media:
            continue
        path = Path(raw_path).expanduser().resolve()
        if path.is_symlink() or not path.is_file():
            raise ProjectTransferError(f"收集媒体不可读取：{identity}")
        seen_media.add(identity)
        stat = path.stat()
        size = stat.st_size
        safe_name = path.name.replace("/", "_").replace("\\", "_") or identity
        normalized_media.append((identity, path, size, stat.st_mtime_ns, safe_name))
        media_bytes += size

    required = project_bytes + media_bytes
    _disk_preflight(target.parent, required)
    fd, temporary = tempfile.mkstemp(
        prefix=target.name + ".",
        suffix=".tmp",
        dir=target.parent,
    )
    os.close(fd)
    temp_path = Path(temporary)
    try:
        media_manifest = [
            {
                "media_id": media_id,
                "archive_path": f"media/{media_id}/{safe_name}",
                "name": safe_name,
                "bytes": size,
            }
            for media_id, _path, size, _mtime_ns, safe_name in normalized_media
        ]
        package_meta = {
            "format": MIRROR_PACKAGE_ARCHIVE_FORMAT,
            "schema_version": MIRROR_PACKAGE_ARCHIVE_SCHEMA_VERSION,
            "project": {
                "format": inspection.manifest.format,
                "schema_version": inspection.manifest.schema_version,
                "project_id": inspection.manifest.project_id,
                "name": inspection.manifest.name,
                "root": "project/",
            },
            "includes": {
                "cache": bool(include_cache),
                "media": bool(normalized_media),
            },
            "media": media_manifest,
            "device_binding_paths_included": False,
        }
        with zipfile.ZipFile(temp_path, "w", allowZip64=True) as archive:
            archive.writestr(
                "mirrorpkg.json",
                json.dumps(package_meta, ensure_ascii=False, indent=2).encode("utf-8"),
                compress_type=zipfile.ZIP_DEFLATED,
            )
            for item in files:
                _cancelled(cancelled)
                _zip_copy(
                    archive,
                    item.source,
                    f"project/{item.relative.as_posix()}",
                    compress_type=zipfile.ZIP_DEFLATED,
                    cancelled=cancelled,
                )
            for media_id, path, _size, _mtime_ns, safe_name in normalized_media:
                _cancelled(cancelled)
                _zip_copy(
                    archive,
                    path,
                    f"media/{media_id}/{safe_name}",
                    compress_type=zipfile.ZIP_STORED,
                    cancelled=cancelled,
                )
        _verify_inventory(files)
        for media_id, path, size, mtime_ns, _safe_name in normalized_media:
            try:
                stat = path.stat()
            except OSError as error:
                raise ProjectTransferError(f"收集媒体在传输过程中发生变化：{media_id}") from error
            if stat.st_size != size or stat.st_mtime_ns != mtime_ns:
                raise ProjectTransferError(f"收集媒体在传输过程中发生变化：{media_id}")
        _cancelled(cancelled)
        os.replace(temp_path, target)
        return {
            "archive_path": str(target),
            "project_id": inspection.manifest.project_id,
            "name": inspection.manifest.name,
            "project_files": len(files),
            "project_bytes": project_bytes,
            "media_files": len(normalized_media),
            "media_bytes": media_bytes,
            "cache_included": bool(include_cache),
            "device_binding_paths_included": False,
        }
    except Exception:
        try:
            temp_path.unlink()
        except OSError:
            pass
        raise
