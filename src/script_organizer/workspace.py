from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import tomllib
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from .config import ProjectConfig
from .fcpxml_reader import read_fcpxml
from .project_package import (
    PROJECT_PACKAGE_FORMAT,
    PROJECT_PACKAGE_SCHEMA_VERSION,
    load_project_package_manifest,
)
from .runtime_diagnostics import environment_payload
from .script_parser import parse_script
from .source_descriptor import shared_source_descriptor


def _write_json(path: Path, payload: object) -> None:
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


def _read_json(path: Path, fallback: object) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def project_id_for(value: str) -> str:
    """Create a safe, deterministic project directory/route identifier.

    Project names are user-facing and commonly contain CJK characters. The
    previous ASCII-only normalizer erased those names, making every such
    project fall back to the same ``project`` directory. Keep IDs ASCII so
    they remain compatible with the current Host route parser, and add a
    deterministic digest when the name contains non-ASCII characters.
    """
    normalized = unicodedata.normalize("NFKC", str(value or "")).casefold()
    ascii_name = unicodedata.normalize("NFKD", normalized).encode("ascii", "ignore").decode("ascii")
    candidate = re.sub(r"[^a-z0-9]+", "-", ascii_name).strip("-")
    if any(ord(character) > 127 for character in normalized) or (normalized.strip() and not candidate):
        digest = hashlib.sha1(normalized.encode("utf-8")).hexdigest()[:10]
        prefix = candidate[: 48 - len(digest) - 1].rstrip("-")
        candidate = f"{prefix}-{digest}" if prefix else f"project-{digest}"
    return candidate[:48] or "project"


def _has_media_file(root: Path, limit: int = 512) -> bool:
    """Bounded preflight probe; full media enumeration belongs to a task."""
    try:
        for count, item in enumerate(root.rglob("*"), start=1):
            if item.is_file():
                return True
            if count >= limit:
                return True
    except OSError:
        return False
    return False


@dataclass(frozen=True)
class WorkspaceConfig:
    config_path: Path
    workspace_id: str
    name: str
    registry_path: Path
    web_dir: Path

    @classmethod
    def from_file(cls, path: str | Path) -> "WorkspaceConfig":
        config_path = Path(path).expanduser().resolve()
        with config_path.open("rb") as handle:
            raw = tomllib.load(handle)
        workspace = raw.get("workspace", {})
        base = config_path.parent
        workspace_id = str(workspace.get("id", workspace.get("workspace_id", "")) or "").strip()
        registry_value = str(workspace.get("registry", "./projects/registry.json"))
        web_value = str(workspace.get("web_directory", "./web"))
        registry_path = (base / registry_value).resolve() if not Path(registry_value).is_absolute() else Path(registry_value)
        web_dir = (base / web_value).resolve() if not Path(web_value).is_absolute() else Path(web_value)
        return cls(
            config_path=config_path,
            workspace_id=workspace_id,
            name=str(workspace.get("name", "视频素材工作台")),
            registry_path=registry_path,
            web_dir=web_dir,
        )

    @property
    def has_stable_id(self) -> bool:
        return bool(self.workspace_id)

    def with_workspace_id(self, workspace_id: str) -> "WorkspaceConfig":
        return WorkspaceConfig(
            config_path=self.config_path,
            workspace_id=workspace_id,
            name=self.name,
            registry_path=self.registry_path,
            web_dir=self.web_dir,
        )


def new_workspace_id() -> str:
    return "ws_" + uuid4().hex


def ensure_workspace_id(path: str | Path) -> WorkspaceConfig:
    """Materialize a stable ID in workspace.toml without touching project data."""
    config_path = Path(path).expanduser().resolve()
    config = WorkspaceConfig.from_file(config_path)
    if config.workspace_id:
        return config
    workspace_id = new_workspace_id()
    text = config_path.read_text(encoding="utf-8")
    lines = text.splitlines()
    inserted = False
    for index, line in enumerate(lines):
        if line.strip() == "[workspace]":
            lines.insert(index + 1, f'id = "{workspace_id}"')
            inserted = True
            break
    if not inserted:
        lines = [f'id = "{workspace_id}"', *lines]
    fd, temporary = tempfile.mkstemp(prefix=config_path.name + ".", suffix=".tmp", dir=config_path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, config_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return WorkspaceConfig.from_file(config_path)


class WorkspaceRegistry:
    def __init__(self, config: WorkspaceConfig):
        self.config = config

    def load(self) -> dict[str, Any]:
        raw = _read_json(self.config.registry_path, {"version": 1, "projects": []})
        if not isinstance(raw, dict):
            return {"version": 1, "projects": []}
        projects = raw.get("projects", [])
        normalized = []
        changed = False
        root = self.config.config_path.parent.resolve()
        for item in projects if isinstance(projects, list) else []:
            if not isinstance(item, dict):
                continue
            current = dict(item)
            config_value = str(current.get("config_path", "") or "")
            if config_value:
                config_path = Path(config_value).expanduser()
                if config_path.is_absolute():
                    try:
                        current["config_path"] = os.path.relpath(config_path.resolve(), root)
                        changed = True
                    except ValueError:
                        pass
            normalized.append(current)
        payload = {"version": 1, "projects": normalized}
        if changed:
            _write_json(self.config.registry_path, payload)
        return payload

    def list(self) -> list[dict[str, Any]]:
        return sorted(
            [item for item in self.load()["projects"] if isinstance(item, dict)],
            key=lambda item: (str(item.get("name", "")).casefold(), str(item.get("project_id", ""))),
        )

    def get(self, project_id: str) -> dict[str, Any]:
        for item in self.list():
            if item.get("project_id") == project_id:
                return item
        raise KeyError(project_id)

    def project_config(self, project_id: str) -> ProjectConfig:
        entry = self.get(project_id)
        config_path = Path(str(entry["config_path"]))
        if not config_path.is_absolute():
            config_path = self.config.config_path.parent / config_path
        manifest = load_project_package_manifest(config_path)
        if not manifest.legacy and manifest.project_id != project_id:
            raise ValueError("项目 manifest id 与 workspace registry 不一致")
        config = ProjectConfig.from_file(config_path)
        if config.is_media_directory:
            from .media_identity import DeviceMediaStore

            snapshot = DeviceMediaStore().project_snapshot(self.config.workspace_id, project_id)
            roots = [Path(value) for value in snapshot.get("roots", []) if Path(value).is_dir()]
            if roots:
                from dataclasses import replace

                # Device-local bindings are authoritative for the current
                # machine. A shared project may retain an old source reference
                # that still exists, but it must never override the roots the
                # user selected for this device.
                config = replace(config, media_root=roots[0], media_roots=tuple(roots))
        return config

    def register_existing(self, project_id: str, config_path: str | Path) -> dict[str, Any]:
        manifest = load_project_package_manifest(config_path)
        if not manifest.legacy and manifest.project_id != project_id:
            raise ValueError("项目 manifest id 与注册 project_id 不一致")
        config = ProjectConfig.from_file(config_path)
        payload = self.load()
        projects = [item for item in payload["projects"] if item.get("project_id") != project_id]
        entry = {
            "project_id": project_id,
            "name": config.name,
            "config_path": os.path.relpath(
                Path(config_path).expanduser().resolve(),
                self.config.config_path.parent,
            ),
            "input_kind": config.input_kind,
            "created_at": _now(),
            "updated_at": _now(),
            "source": shared_source_descriptor(config),
        }
        # Project discovery must stay cheap, but an explicit registration can
        # retain the existing index's small summary so legacy projects do not
        # appear as empty/unprepared in the Desktop library.
        index = _read_json(config.output_dir / "material_index.json", {})
        if isinstance(index, dict) and isinstance(index.get("stats"), dict):
            entry["stats"] = dict(index["stats"])
        projects.append(entry)
        payload["projects"] = projects
        _write_json(self.config.registry_path, payload)
        return entry

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        preflight = self.preflight_create(payload)
        if not preflight["ready"]:
            raise ValueError("项目预检失败：" + "；".join(preflight["errors"]))
        name = str(payload.get("name", "")).strip()
        project_id = project_id_for(str(payload.get("project_id") or name))
        if not name:
            raise ValueError("项目名称不能为空")
        if any(item.get("project_id") == project_id for item in self.list()):
            raise ValueError("项目ID已存在")
        input_kind = str(payload.get("input_kind", "fcpxml"))
        if input_kind not in {"fcpxml", "media-directory"}:
            raise ValueError("不支持的项目类型")
        script = Path(str(payload.get("script", ""))).expanduser().resolve()
        fcpxml = Path(str(payload.get("fcpxml", ""))).expanduser().resolve() if payload.get("fcpxml") else None
        raw_media_roots = payload.get("media_roots", [])
        if not isinstance(raw_media_roots, list):
            raw_media_roots = []
        media_roots = [
            Path(str(value)).expanduser().resolve()
            for value in raw_media_roots
            if str(value).strip()
        ]
        if not media_roots and payload.get("media_root"):
            media_roots = [Path(str(payload.get("media_root"))).expanduser().resolve()]
        media_root = media_roots[0] if media_roots else None
        if not script.is_file() or script.suffix.lower() not in {".docx", ".txt", ".md", ".markdown"}:
            raise ValueError("剧本必须是可读取的 DOCX、TXT 或 Markdown 文件")
        if input_kind == "fcpxml" and (
            fcpxml is None
            or not fcpxml.is_file()
            or fcpxml.suffix.lower() not in {".fcpxml", ".fcpxmld"}
        ):
            raise ValueError("FCPXML 项目需要可读取的 FCPXML 文件")
        if input_kind == "media-directory" and (
            not media_roots or any(not root.is_dir() for root in media_roots)
        ):
            raise ValueError("媒体目录项目需要可读取的媒体目录")
        project_dir = self.config.registry_path.parent / project_id
        if project_dir.exists():
            raise ValueError("项目目录已存在")
        output_dir = project_dir / "output"
        transcript_dir = project_dir / "cache" / "transcripts"
        try:
            for directory in (project_dir, output_dir, transcript_dir):
                directory.mkdir(parents=True, exist_ok=True)
            inputs_dir = project_dir / "inputs"
            inputs_dir.mkdir(parents=True, exist_ok=True)
            script_copy = inputs_dir / f"script{script.suffix.lower()}"
            shutil.copy2(script, script_copy)
            fcpxml_copy = None
            if fcpxml:
                fcpxml_copy = inputs_dir / "source.fcpxml"
                shutil.copy2(fcpxml, fcpxml_copy)
        except Exception:
            shutil.rmtree(project_dir, ignore_errors=True)
            raise
        patterns = payload.get("camera_patterns", {})
        if not isinstance(patterns, dict):
            patterns = {}
        config_path = project_dir / "project.toml"
        lines = [
            "[project]",
            f"format = {json.dumps(PROJECT_PACKAGE_FORMAT)}",
            f"schema_version = {PROJECT_PACKAGE_SCHEMA_VERSION}",
            f"id = {json.dumps(project_id)}",
            f"name = {json.dumps(name, ensure_ascii=False)}",
            "",
            "[input]",
            f"kind = {json.dumps(input_kind)}",
            'script = "./inputs/' + script_copy.name + '"',
        ]
        if fcpxml_copy:
            lines.append('fcpxml = "./inputs/source.fcpxml"')
        lines.extend([
            "",
            "[output]",
            'directory = "./output"',
            "",
            "[asr]",
            'backend = "auto"',
            'model = "small"',
            'language = "zh"',
            'device = "auto"',
            'transcript_dir = "./cache/transcripts"',
            'camera_priority = ["B", "C", "A"]',
            "ensure_preferred_camera = true",
            "escalate_ambiguous = true",
            "max_extra_cameras = 1",
            "max_escalated_groups = 24",
            "",
            "[media]",
            "timeline_mode = " + json.dumps(str(payload.get("timeline_mode", "sequential")), ensure_ascii=False),
        ])
        for camera, pattern in sorted(patterns.items()):
            camera_key = json.dumps(str(camera).upper(), ensure_ascii=False)
            lines.append(
                f"camera_patterns.{camera_key} = "
                + json.dumps(str(pattern), ensure_ascii=False)
            )
        config_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        entry = self.register_existing(project_id, config_path)
        if media_roots:
            from .media_identity import DeviceMediaStore

            DeviceMediaStore().add_roots(self.config.workspace_id, project_id, [str(value) for value in media_roots])
        return entry

    def delete(self, project_id: str, confirmation: str = "") -> dict[str, Any]:
        """Delete one generated project directory and registry entry atomically.

        Only project directories owned by this workspace may be removed. The
        caller must echo the project ID so a UI confirmation cannot target a
        different project after selection changes.
        """
        project_id = str(project_id or "").strip()
        if not project_id or confirmation != project_id:
            raise ValueError("删除项目需要确认 project_id")
        entry = self.get(project_id)
        config_path = Path(str(entry.get("config_path", "")))
        if not config_path.is_absolute():
            config_path = self.config.config_path.parent / config_path
        project_dir = config_path.expanduser().resolve().parent
        projects_root = self.config.registry_path.parent.resolve()
        if project_dir.parent != projects_root:
            raise ValueError("只能删除当前工作区 projects 目录内的项目")
        if not project_dir.is_dir():
            raise ValueError("项目目录不存在，无法删除")

        payload = self.load()
        remaining = [
            item for item in payload["projects"]
            if str(item.get("project_id", "")) != project_id
        ]
        quarantine = projects_root / f".mirrororder-delete-{project_id}-{uuid4().hex}"
        os.replace(project_dir, quarantine)
        try:
            payload["projects"] = remaining
            _write_json(self.config.registry_path, payload)
        except Exception:
            os.replace(quarantine, project_dir)
            raise
        shutil.rmtree(quarantine)
        return {
            "project_id": project_id,
            "deleted": True,
            "config_path": str(entry.get("config_path", "")),
        }

    def preflight_create(self, payload: dict[str, Any]) -> dict[str, Any]:
        errors: list[str] = []
        warnings: list[str] = []
        detected = {
            "script_segments": 0,
            "logical_clips": 0,
            "available_media": 0,
            "missing_media": 0,
        }
        name = str(payload.get("name", "")).strip()
        project_id = project_id_for(str(payload.get("project_id") or name))
        input_kind = str(payload.get("input_kind", "fcpxml"))
        script = Path(str(payload.get("script", ""))).expanduser()
        fcpxml = Path(str(payload.get("fcpxml", ""))).expanduser() if payload.get("fcpxml") else None
        raw_media_roots = payload.get("media_roots", [])
        if not isinstance(raw_media_roots, list):
            raw_media_roots = []
        media_roots = [Path(str(value)).expanduser() for value in raw_media_roots if str(value).strip()]
        if not media_roots and payload.get("media_root"):
            media_roots = [Path(str(payload.get("media_root"))).expanduser()]
        if not name:
            errors.append("项目名称不能为空")
        if input_kind not in {"fcpxml", "media-directory"}:
            errors.append("不支持的项目类型")
        if not script.is_file() or script.suffix.lower() not in {".docx", ".txt", ".md", ".markdown"}:
            errors.append("剧本必须是可读取的 DOCX、TXT 或 Markdown 文件")
        elif not os.access(script, os.R_OK):
            errors.append("剧本没有读取权限")
        if input_kind == "fcpxml":
            if fcpxml is None or not fcpxml.is_file() or fcpxml.suffix.lower() not in {".fcpxml", ".fcpxmld"}:
                errors.append("FCPXML 项目需要可读取的 FCPXML 文件")
            elif not os.access(fcpxml, os.R_OK):
                errors.append("FCPXML 没有读取权限")
        if input_kind == "media-directory":
            if not media_roots:
                errors.append("媒体目录项目需要可读取的媒体目录")
            else:
                invalid = [root for root in media_roots if not root.is_dir() or not os.access(root, os.R_OK)]
                if invalid:
                    errors.append("存在不可读取的媒体目录：" + "、".join(str(root) for root in invalid))
            if media_roots and not errors and not any(_has_media_file(root) for root in media_roots):
                warnings.append("媒体目录为空，创建后无法开始分析")
        project_dir = self.config.registry_path.parent / project_id
        if project_dir.exists():
            errors.append("项目目录已存在")
        if not self.config.registry_path.parent.is_dir() or not os.access(self.config.registry_path.parent, os.W_OK):
            errors.append("工作区 projects 目录不可写")
        if input_kind == "fcpxml" and fcpxml and fcpxml.is_file():
            try:
                clips = read_fcpxml(fcpxml)
                detected["logical_clips"] = len(clips)
                detected["available_media"] = sum(clip.exists for clip in clips)
                detected["missing_media"] = sum(not clip.exists for clip in clips)
                if not clips:
                    warnings.append("FCPXML 未发现可分析时间线素材，创建后需要检查主项目 sequence")
                else:
                    missing = sum(not clip.exists for clip in clips)
                    if missing:
                        warnings.append(f"FCPXML 有 {missing} 个源媒体当前不可达，将依赖本机 media_id 绑定")
            except Exception as error:
                errors.append(f"FCPXML 无法解析：{error}")
        if script.is_file() and script.suffix.lower() in {".docx", ".txt", ".md", ".markdown"}:
            try:
                segments = parse_script(script).segments
                detected["script_segments"] = len(segments)
                if not segments:
                    errors.append("剧本没有解析出可用段落，请检查集数、场次和文本格式")
            except Exception as error:
                errors.append(f"剧本无法解析：{error}")
        if input_kind == "media-directory" and not environment_payload()["media_directory_sync_ready"]:
            warnings.append("媒体目录同步环境未就绪；可先创建项目，但 prepare_project 会等待 FFmpeg 和第一方 Python 依赖就绪")
        return {
            "ready": not errors,
            "project_id": project_id,
            "input_kind": input_kind,
            "errors": errors,
            "warnings": warnings,
            "detected": detected,
            "will_copy_inputs": True,
            "will_write_shared_absolute_paths": False,
        }
