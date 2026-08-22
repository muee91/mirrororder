from __future__ import annotations

import json
import os
import re
import tempfile
import tomllib
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import ProjectConfig


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
    candidate = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return candidate[:48] or "project"


@dataclass(frozen=True)
class WorkspaceConfig:
    config_path: Path
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
        registry_value = str(workspace.get("registry", "./projects/registry.json"))
        web_value = str(workspace.get("web_directory", "./web"))
        registry_path = (base / registry_value).resolve() if not Path(registry_value).is_absolute() else Path(registry_value)
        web_dir = (base / web_value).resolve() if not Path(web_value).is_absolute() else Path(web_value)
        return cls(
            config_path=config_path,
            name=str(workspace.get("name", "视频素材工作台")),
            registry_path=registry_path,
            web_dir=web_dir,
        )


class WorkspaceRegistry:
    def __init__(self, config: WorkspaceConfig):
        self.config = config

    def load(self) -> dict[str, Any]:
        raw = _read_json(self.config.registry_path, {"version": 1, "projects": []})
        if not isinstance(raw, dict):
            return {"version": 1, "projects": []}
        projects = raw.get("projects", [])
        return {"version": 1, "projects": projects if isinstance(projects, list) else []}

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
        return ProjectConfig.from_file(str(entry["config_path"]))

    def register_existing(self, project_id: str, config_path: str | Path) -> dict[str, Any]:
        config = ProjectConfig.from_file(config_path)
        payload = self.load()
        projects = [item for item in payload["projects"] if item.get("project_id") != project_id]
        entry = {
            "project_id": project_id,
            "name": config.name,
            "config_path": str(Path(config_path).resolve()),
            "input_kind": config.input_kind,
            "created_at": _now(),
            "updated_at": _now(),
        }
        projects.append(entry)
        payload["projects"] = projects
        _write_json(self.config.registry_path, payload)
        return entry

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        name = str(payload.get("name", "")).strip()
        project_id = project_id_for(str(payload.get("project_id") or name))
        if not name:
            raise ValueError("项目名称不能为空")
        if any(item.get("project_id") == project_id for item in self.list()):
            raise ValueError("项目ID已存在")
        input_kind = str(payload.get("input_kind", "fcpxml"))
        if input_kind not in {"fcpxml", "media-directory"}:
            raise ValueError("不支持的项目类型")
        script = Path(str(payload.get("script", ""))).expanduser()
        fcpxml = Path(str(payload.get("fcpxml", ""))).expanduser() if payload.get("fcpxml") else None
        media_root = Path(str(payload.get("media_root", ""))).expanduser() if payload.get("media_root") else None
        if not script.is_file() or script.suffix.lower() not in {".docx", ".txt", ".md", ".markdown"}:
            raise ValueError("剧本必须是可读取的 DOCX、TXT 或 Markdown 文件")
        if input_kind == "fcpxml" and (
            fcpxml is None
            or not fcpxml.is_file()
            or fcpxml.suffix.lower() not in {".fcpxml", ".fcpxmld"}
        ):
            raise ValueError("FCPXML 项目需要可读取的 FCPXML 文件")
        if input_kind == "media-directory" and (media_root is None or not media_root.is_dir()):
            raise ValueError("媒体目录项目需要可读取的媒体目录")
        project_dir = self.config.registry_path.parent / project_id
        if project_dir.exists():
            raise ValueError("项目目录已存在")
        output_dir = Path(str(payload.get("output_dir") or project_dir / "output")).expanduser()
        transcript_dir = Path(str(payload.get("transcript_dir") or project_dir / "cache" / "transcripts")).expanduser()
        for directory in (project_dir, output_dir, transcript_dir):
            directory.mkdir(parents=True, exist_ok=True)
        patterns = payload.get("camera_patterns", {})
        if not isinstance(patterns, dict):
            patterns = {}
        config_path = project_dir / "project.toml"
        lines = [
            "[project]",
            f'id = "{project_id}"',
            f'name = "{name}"',
            "",
            "[input]",
            f'kind = "{input_kind}"',
            f'script = "{script}"',
        ]
        if fcpxml:
            lines.append(f'fcpxml = "{fcpxml}"')
        if media_root:
            lines.append(f'media_root = "{media_root}"')
        lines.extend([
            "",
            "[output]",
            f'directory = "{output_dir}"',
            "",
            "[asr]",
            'backend = "faster-whisper"',
            'model = "small"',
            'language = "zh"',
            'device = "auto"',
            f'transcript_dir = "{transcript_dir}"',
            'camera_priority = ["B", "C", "A"]',
            "ensure_preferred_camera = true",
            "",
            "[media]",
            f'timeline_mode = "{str(payload.get("timeline_mode", "sequential"))}"',
        ])
        for camera, pattern in sorted(patterns.items()):
            lines.append(f'camera_patterns.{str(camera).upper()} = "{str(pattern)}"')
        config_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return self.register_existing(project_id, config_path)
