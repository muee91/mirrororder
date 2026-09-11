from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import urllib.parse
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
from ..source_descriptor import redact_device_media_paths

MIRROR_PACKAGE_ARCHIVE_EXTENSION = ".mirrorpkg"
MIRROR_PACKAGE_ARCHIVE_FORMAT = "mirrororder-project-archive"
MIRROR_PACKAGE_ARCHIVE_SCHEMA_VERSION = 1
_COPY_CHUNK_BYTES = 1024 * 1024
_PROJECT_KEY_LINE = re.compile(r"^\s*(format|schema_version|id|name)\s*=")
_NON_PORTABLE_PROJECT_FILES = {"output/tasks.json"}
_MEDIA_ID = re.compile(r"^(?:M|MP)_[A-Za-z0-9._-]{1,160}$")
# Shared packages must not carry device bindings (INVARIANTS): /Volumes/...,
# /Users/..., /home/... and Windows drive paths are device-local.
_DEVICE_PATH_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])/(?:Users|Volumes|home)/[^\s\"'<>\\]+"
    r"|(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s\"'<>]+"
)
# A JSON string value that *starts* with a device path is machine provenance
# (media_path, legacy_source, source_fcpxml, ...) and is safe to blank; human
# notes that merely mention a path are left untouched.
_DEVICE_PATH_VALUE_PREFIX = re.compile(
    r"^(?:file://(?:localhost)?/+)?(?:/Users/|/Volumes/|/home/|[A-Za-z]:[\\/])"
)
_MEDIA_INDEX_RELATIVE = "output/material_index.json"
_DOCUMENT_SUFFIXES = {".fcpxml", ".xml"}
_SWEEP_SUFFIXES = {".json", ".jsonl"}
_BINARY_ARTIFACT_SUFFIXES = {
    ".mov", ".mp4", ".m4v", ".mxf", ".avi", ".wmv", ".braw", ".r3d", ".arw",
    ".dng", ".cr2", ".cr3", ".nef", ".wav", ".aif", ".aiff", ".mp3", ".m4a",
    ".aac", ".flac", ".png", ".jpg", ".jpeg", ".heic", ".gif", ".webp", ".ico",
    ".tif", ".tiff", ".pdf", ".docx", ".xlsx", ".pptx", ".doc", ".zip", ".gz",
    ".onnx", ".bin", ".dat", ".sqlite", ".sqlite3", ".db", ".ttf", ".otf",
    ".woff", ".woff2", ".npy", ".npz", ".pt", ".pth",
}
_FILE_URL_ATTRIBUTE = re.compile(r'(src=")(file://[^"]+)(")')
_FILE_URL_PATHURL = re.compile(r"(<pathurl>)(file://[^<]+)(</pathurl>)")


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


def _decoded_file_url_path(url: str) -> str:
    value = str(url or "").strip()
    lowered = value.lower()
    if lowered.startswith("file://"):
        value = value[len("file://"):]
        if value.lower().startswith("localhost/"):
            value = value[len("localhost/"):]
    return urllib.parse.unquote(value)


def _is_absolute_file_locator(url: str) -> bool:
    """绝对 file locator 是设备绑定（跨设备必然失效），无论盘符/挂载点形式。"""
    path = _decoded_file_url_path(url)
    if not path:
        return False
    if path.startswith("/"):
        return True
    return bool(re.match(r"^[A-Za-z]:[\\/]", path))


def _strip_document_device_locators(text: str) -> tuple[str, int]:
    """Remove absolute file locators from NLE documents, keeping element structure.

    不发明新的伪 relative locator：fcpxml_reader 对空 src 有显式守护
    （``_asset_media_path`` 返回 ""；``media_ids[asset_id] = media_identity(p)
    if p else ""``），空 src 是 importer 认可的"无 locator"状态。跨设备
    media truth 只保留在 material_index 的 media_id 与 mirrorpkg media
    manifest；重分析身份经 material_index 的 previous-index reconciliation
    恢复（见 ``_reconcile_previous_clip_identity``），DeviceMediaStore 绑定
    仍是设备侧唯一 authority。剥除规则是"一切绝对 file locator"——任何
    挂载点形式的绝对路径跨设备都失效，不以是否命中枚举模式为条件；
    document-relative src 原样保留。
    """
    stripped = 0

    def replace(match: re.Match[str]) -> str:
        nonlocal stripped
        prefix, url, suffix = match.group(1), match.group(2), match.group(3)
        if not _is_absolute_file_locator(url):
            return match.group(0)
        stripped += 1
        return f"{prefix}{suffix}"

    rewritten = _FILE_URL_PATHURL.sub(replace, text)
    rewritten = _FILE_URL_ATTRIBUTE.sub(replace, rewritten)
    return rewritten, stripped


def _sweep_device_path_values(node: object) -> tuple[object, int]:
    if isinstance(node, dict):
        swept: dict[str, object] = {}
        count = 0
        for key, value in node.items():
            new_value, replaced = _sweep_device_path_values(value)
            swept[key] = new_value
            count += replaced
        return swept, count
    if isinstance(node, list):
        items: list[object] = []
        count = 0
        for value in node:
            new_value, replaced = _sweep_device_path_values(value)
            items.append(new_value)
            count += replaced
        return items, count
    if isinstance(node, str) and _DEVICE_PATH_VALUE_PREFIX.match(node.strip()):
        return "", 1
    return node, 0


def _sweep_json_artifact(source: Path) -> bytes | None:
    try:
        raw = source.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    if source.suffix.lower() == ".jsonl":
        lines: list[str] = []
        changed = 0
        for line in raw.splitlines():
            stripped = line.strip()
            if not stripped:
                lines.append(line)
                continue
            try:
                value = json.loads(stripped)
            except ValueError:
                lines.append(line)
                continue
            swept, replaced = _sweep_device_path_values(value)
            changed += replaced
            lines.append(json.dumps(swept, ensure_ascii=False))
        if not changed:
            return None
        return ("\n".join(lines) + "\n").encode("utf-8")
    try:
        value = json.loads(raw)
    except ValueError:
        return None
    swept, replaced = _sweep_device_path_values(value)
    if not replaced:
        return None
    return (json.dumps(swept, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _build_export_projection(
    files: Sequence[TransferFile],
) -> dict[str, bytes]:
    """Projection boundary for shared export artifacts.

    INVARIANTS：设备绝对路径不得进入共享 artifact。导出不是字节复制：

    - ``output/material_index.json`` 走结构化 media-path redaction：media_id
      保留为跨设备身份，本地存在性标记按不可用处理；
    - ``output/`` 与 ``cache/`` 下其余生成 JSON/JSONL 清洗"值本身就是设备
      路径"的字段（media_path / legacy_source / source_fcpxml 等），人工
      文本不受影响；
    - FCPXML/XML 文档中的设备 file locator 直接剥除（空 src 是
      fcpxml_reader 认可的状态），不发明新的伪 relative locator；
    - 清洗后仍携带设备路径的内容会在发布前的可移植性扫描中失败导出。
    """
    rewrites: dict[str, bytes] = {}
    by_relative = {item.relative.as_posix(): item for item in files}
    index_item = by_relative.get(_MEDIA_INDEX_RELATIVE)
    if index_item is not None:
        try:
            index = json.loads(index_item.source.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise ProjectTransferError(f"无法读取素材索引：{error}") from error
        if isinstance(index, dict):
            redact_device_media_paths(index)
            rewrites[_MEDIA_INDEX_RELATIVE] = (
                json.dumps(index, ensure_ascii=False, indent=2) + "\n"
            ).encode("utf-8")
    document_digests: dict[str, str] = {}
    for item in files:
        relative = item.relative.as_posix()
        if item.source.suffix.lower() not in _DOCUMENT_SUFFIXES:
            continue
        try:
            text = item.source.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            raise ProjectTransferError(f"无法读取项目文档 {relative}：{error}") from error
        rewritten, _stripped = _strip_document_device_locators(text)
        if rewritten != text:
            data = rewritten.encode("utf-8")
            rewrites[relative] = data
            document_digests[relative] = hashlib.sha256(data).hexdigest()
    if index_item is not None and document_digests:
        index = json.loads(rewrites[_MEDIA_INDEX_RELATIVE].decode("utf-8"))
        source = index.get("source")
        if isinstance(source, dict):
            declared = str(source.get("fcpxml", "") or "").lstrip("./")
            digest = document_digests.get(declared)
            if digest:
                source["fcpxml_sha256"] = digest
        rewrites[_MEDIA_INDEX_RELATIVE] = (
            json.dumps(index, ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")
    for item in files:
        relative = item.relative.as_posix()
        if relative in rewrites:
            continue
        suffix = item.source.suffix.lower()
        if suffix not in _SWEEP_SUFFIXES:
            continue
        if not (relative.startswith("output/") or relative.startswith("cache/")):
            continue
        swept = _sweep_json_artifact(item.source)
        if swept is not None:
            rewrites[relative] = swept
    return rewrites


def _write_projected(destination: Path, data: bytes) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("xb") as writer:
        writer.write(data)
        writer.flush()
        os.fsync(writer.fileno())


def _is_portable_text_candidate(relative: str) -> bool:
    """设备路径扫描只针对 portable 的文本/结构化工件。

    ``media/`` 打包媒体与已知二进制后缀直接跳过——不把打包进包的视频/
    音频 payload 读进内存做字符串扫描，避免 O(media bytes) 与 binary
    误报（UTF-8 严格解码兜底其余未知二进制）。
    """
    if relative.startswith("media/"):
        return False
    return Path(relative).suffix.lower() not in _BINARY_ARTIFACT_SUFFIXES


def _assert_package_text_portable(relative: str, data: bytes) -> None:
    if not _is_portable_text_candidate(relative):
        return
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return
    match = _DEVICE_PATH_PATTERN.search(text)
    if match:
        hint = "；请关闭“包含缓存”后重试" if relative.startswith("cache/") else ""
        raise ProjectTransferError(
            f"导出包包含设备本地路径：{relative}（{match.group(0)[:80]}）{hint}"
        )


def _assert_staged_portability(staging: Path) -> None:
    for current, _directories, names in os.walk(staging):
        for name in names:
            path = Path(current) / name
            relative = path.relative_to(staging).as_posix()
            if not _is_portable_text_candidate(relative):
                continue
            try:
                data = path.read_bytes()
            except OSError as error:
                raise ProjectTransferError(f"无法校验导出文件 {relative}：{error}") from error
            _assert_package_text_portable(relative, data)


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
    projection = _build_export_projection(files)
    target = _check_destination(inspection.root, destination, extension=destination_extension)
    _disk_preflight(target.parent, total)
    staging = target.parent / f".mirrororder-transfer-{uuid4().hex}"
    staging.mkdir()
    copied = 0
    try:
        for item in files:
            _cancelled(cancelled)
            data = projection.get(item.relative.as_posix())
            if data is None:
                _copy_one(item.source, staging / item.relative, cancelled=cancelled)
            else:
                _write_projected(staging / item.relative, data)
            copied += item.size
        _verify_inventory(files)
        _assert_staged_portability(staging)
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
            "projected_artifacts": len(projection),
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
        # is_symlink() must run on the unresolved path: resolve() follows
        # links, so checking afterwards can never reject a symlinked source.
        candidate = Path(raw_path).expanduser()
        if candidate.is_symlink() or not candidate.is_file():
            raise ProjectTransferError(f"收集媒体不可读取：{identity}")
        path = candidate.resolve()
        seen_media.add(identity)
        stat = path.stat()
        size = stat.st_size
        safe_name = path.name.replace("/", "_").replace("\\", "_") or identity
        normalized_media.append((identity, path, size, stat.st_mtime_ns, safe_name))
        media_bytes += size

    required = project_bytes + media_bytes
    _disk_preflight(target.parent, required)
    projection = _build_export_projection(files)
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
                relative = item.relative.as_posix()
                arcname = f"project/{relative}"
                data = projection.get(relative)
                if data is None:
                    _zip_copy(
                        archive,
                        item.source,
                        arcname,
                        compress_type=zipfile.ZIP_DEFLATED,
                        cancelled=cancelled,
                    )
                else:
                    info = zipfile.ZipInfo.from_file(item.source, arcname)
                    info.compress_type = zipfile.ZIP_DEFLATED
                    archive.writestr(info, data)
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
        with zipfile.ZipFile(temp_path) as verify:
            for name in verify.namelist():
                if name != "mirrorpkg.json" and not name.startswith("project/"):
                    continue
                if name != "mirrorpkg.json" and not _is_portable_text_candidate(name):
                    continue
                _assert_package_text_portable(name, verify.read(name))
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
            "projected_artifacts": len(projection),
        }
    except Exception:
        try:
            temp_path.unlink()
        except OSError:
            pass
        raise
