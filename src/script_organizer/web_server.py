from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import secrets
import socket
import subprocess
import tempfile
import threading
import time
import unicodedata
import urllib.parse
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from .agent_store import (
    AgentAuthorizationError,
    AgentForbiddenError,
    AgentRateLimitError,
    AgentTokenStore,
    ProposalStore,
)
from .collaboration_access import CollaborationAccessStore
from .config import ProjectConfig
from .media_identity import DeviceMediaStore
from .review_store import ReviewStore
from .tasks import TaskManager
from .transcript import TranscriptStore, slice_transcript
from .workspace import WorkspaceConfig, WorkspaceRegistry
from .workspace_db import WorkspaceDatabase


class MirrorOrderHTTPServer(ThreadingHTTPServer):
    """Keep the local workbench stable during the browser asset fan-out.

    Team Web intentionally uses small, independently cacheable CSS/JS modules.
    A browser opens many of them concurrently during boot; the stdlib server's
    default listen backlog of five can reset requests before handler threads
    accept them, which presents as a frozen shell.
    """

    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 128


class ApiError(RuntimeError):
    def __init__(self, status: HTTPStatus, message: str):
        super().__init__(message)
        self.status = status


def _read_json(path: Path, fallback: object) -> object:
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return fallback


def _json_bytes(payload: object) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


DEFAULT_FRONTEND_SETTINGS: dict[str, Any] = {
    "version": 1,
    "theme": "system",
    "density": "comfortable",
    "default_mode": "script",
    "default_episode": "first",
    "poll_interval_ms": 2500,
    "update_sound": True,
    "show_unknown_count": True,
}


def _write_json_atomic(path: Path, payload: object) -> None:
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


def _frontend_settings_path(workspace: WorkspaceConfig) -> Path:
    return workspace.config_path.parent / ".workspace" / "frontend_settings.json"


def _load_frontend_settings(workspace: WorkspaceConfig) -> dict[str, Any]:
    payload = dict(DEFAULT_FRONTEND_SETTINGS)
    raw = _read_json(_frontend_settings_path(workspace), {})
    if isinstance(raw, dict):
        payload.update({key: raw[key] for key in DEFAULT_FRONTEND_SETTINGS if key in raw})
    return payload


def _validate_frontend_settings(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("前端设置必须是对象")
    payload = dict(DEFAULT_FRONTEND_SETTINGS)
    payload.update({key: raw[key] for key in payload if key in raw})
    if payload["theme"] not in {"system", "light", "dark"}:
        raise ValueError("主题设置无效")
    if payload["density"] not in {"comfortable", "compact"}:
        raise ValueError("界面密度设置无效")
    if payload["default_mode"] not in {"script", "unassigned"}:
        raise ValueError("默认工作台模式无效")
    if payload["default_episode"] != "first" and payload["default_episode"] != "all":
        try:
            payload["default_episode"] = int(payload["default_episode"])
        except (TypeError, ValueError) as error:
            raise ValueError("默认集数设置无效") from error
        if payload["default_episode"] < 1 or payload["default_episode"] > 9999:
            raise ValueError("默认集数设置无效")
    try:
        payload["poll_interval_ms"] = int(payload["poll_interval_ms"])
    except (TypeError, ValueError) as error:
        raise ValueError("刷新间隔设置无效") from error
    if payload["poll_interval_ms"] not in {1000, 2500, 5000, 10000}:
        raise ValueError("刷新间隔设置无效")
    payload["update_sound"] = bool(payload["update_sound"])
    payload["show_unknown_count"] = bool(payload["show_unknown_count"])
    return payload


class ProjectService:
    def __init__(self, project_id: str, config: ProjectConfig):
        self.project_id = project_id
        self.config = config
        self.index: dict[str, Any] = {}
        self.script: dict[str, Any] = {}
        self.matches: dict[str, Any] = {}
        self.review = ReviewStore(config.output_dir / "review.json")
        self.proposals = ProposalStore(config.output_dir)
        self.clips: dict[str, dict[str, Any]] = {}
        self.groups: dict[str, dict[str, Any]] = {}
        self.segments: dict[str, dict[str, Any]] = {}
        self.analysis_revision = ""
        self._data_signature: tuple[tuple[str, int, int], ...] = ()
        self.reload()

    def _signature(self) -> tuple[tuple[str, int, int], ...]:
        result = []
        for name in ("material_index.json", "script.json", "matches.json"):
            path = self.config.output_dir / name
            try:
                stat = path.stat()
                result.append((name, stat.st_size, stat.st_mtime_ns))
            except OSError:
                result.append((name, -1, -1))
        return tuple(result)

    def reload(self) -> None:
        self.index = _read_json(self.config.output_dir / "material_index.json", {})
        self.script = _read_json(self.config.output_dir / "script.json", {})
        self.matches = _read_json(self.config.output_dir / "matches.json", {})
        self.clips = {item.get("clip_id"): item for item in self.index.get("clips", []) if isinstance(item, dict)}
        self.groups = {item.get("group_id"): item for item in self.index.get("groups", []) if isinstance(item, dict)}
        self.segments = {item.get("segment_id"): item for item in self.script.get("segments", []) if isinstance(item, dict)}
        self._data_signature = self._signature()
        self.analysis_revision = hashlib.sha1(repr(self._data_signature).encode("utf-8")).hexdigest()[:16]

    def reload_if_changed(self) -> bool:
        if self._signature() == self._data_signature:
            return False
        self.reload()
        return True

    @staticmethod
    def _search_text(value: object) -> str:
        text = unicodedata.normalize("NFKC", str(value or "")).casefold()
        return re.sub(r"[\\/\s_.\-]+", "", text)

    def project_payload(self) -> dict[str, Any]:
        self.reload_if_changed()
        review = self.review.load()
        return {
            "project_id": self.project_id,
            "project": self.config.name,
            "input_kind": self.config.input_kind,
            "analysis_revision": self.analysis_revision,
            "stats": {
                **self.index.get("stats", {}),
                "reviewed_groups": len(review.get("groups", {})),
                "reviewed_clips": len(review.get("clips", {})),
                "manual_assignments": sum(len(value) for value in review.get("assignments", {}).values()),
                "manual_placements": len(review.get("placements", {})),
            },
            "errors": self.index.get("errors", {}),
            "source": self.index.get("source", {}),
        }

    def state(self) -> dict[str, Any]:
        self.reload_if_changed()
        review = self.review.load()
        return {
            "project_id": self.project_id,
            "analysis_revision": self.analysis_revision,
            "review_revision": review.get("revision", 0),
            "updated_at": review.get("updated_at", ""),
        }

    def agent_context(self) -> dict[str, Any]:
        state = self.state()
        return {
            "contract_version": "agent.v1",
            "project": self.project_payload(),
            "revisions": {"analysis": state["analysis_revision"], "review": state["review_revision"]},
            "data_authority": [
                "FCPXML 或已登记媒体目录",
                "DOCX、TXT 或 Markdown 剧本",
                "项目ASR缓存",
                "review.json 人工审核",
            ],
            "allowed_actions": [
                "读取项目、素材、剧本、候选和已有审核",
                "提交已选素材或Take的增量分析、转写和证据提取任务",
                "提交带素材时间范围与证据的归集提案",
            ],
            "forbidden_actions": [
                "直接写入 review.json 或应用审核结论",
                "自动 Reject 素材",
                "修改原始FCPXML、原始媒体或全局匹配阈值",
                "读取CSV、旧素材清单或旧HTML结果参与判断",
                "没有可靠对白时伪造剧本行",
            ],
            "instructions_markdown": (
                f"# {self.config.name} 智能体工作约束\n\n"
                "先读取项目上下文与当前revision。只能使用项目登记的输入、ASR缓存和人工审核。"
                "需要写入时仅提交提案；提案必须带同Take素材、有效片内时间范围和可复核说明。"
                "人工审核优先，revision变化后必须重新读取。\n\n"
                "验证命令：`python3 -m py_compile src/script_organizer/*.py` 和 `python3 -m pytest -q`。"
            ),
        }

    def _group_scope(self, group_id: str, review: dict[str, Any]) -> tuple[list[int], list[str]]:
        group = self.groups.get(group_id, {})
        parent_group_id = str(group.get("parent_group_id", "") or "")
        placement = review.get("placements", {}).get(group_id, {})
        if not placement and parent_group_id:
            placement = review.get("placements", {}).get(parent_group_id, {})
        segment_ids = list(placement.get("script_segment_ids", [])) if isinstance(placement, dict) else []
        episode_ids = list(placement.get("episode_ids", [])) if isinstance(placement, dict) else []
        row = self.matches.get("groups", {}).get(group_id, {})
        if not segment_ids:
            for candidate in row.get("candidates", []):
                segment_ids.extend(candidate.get("script_segment_ids") or ([candidate["script_segment_id"]] if candidate.get("script_segment_id") else []))
        if not episode_ids:
            episode_ids.extend(int(value) for value in row.get("context_episodes", []) if str(value).isdigit())
            episode_ids.extend(
                int(self.segments[segment_id].get("episode"))
                for segment_id in segment_ids
                if segment_id in self.segments and str(self.segments[segment_id].get("episode", "")).isdigit()
            )
        return sorted(set(episode_ids)), list(dict.fromkeys(segment_ids))

    def search(self, raw_query: str) -> list[dict[str, Any]]:
        self.reload_if_changed()
        query = self._search_text(raw_query)
        if not query:
            return []
        review = self.review.load()
        hits: list[tuple[int, dict[str, Any]]] = []
        for group in self.groups.values():
            group_id = str(group.get("group_id", ""))
            episode_ids, segment_ids = self._group_scope(group_id, review)
            row = self.matches.get("groups", {}).get(group_id, {})
            candidate_text = " ".join(
                str(candidate.get("transcript_text", ""))
                for candidate in row.get("candidates", [])
                if isinstance(candidate, dict)
            )
            for member in group.get("members", []):
                file_name = Path(str(member.get("media_path", ""))).name or str(member.get("name", ""))
                haystack = self._search_text(
                    " ".join([file_name, str(member.get("name", "")), str(member.get("media_path", "")), group_id, candidate_text])
                )
                if query not in haystack:
                    continue
                normalized_name = self._search_text(file_name)
                priority = 0 if query == normalized_name else 1 if normalized_name.startswith(query) else 2
                hits.append(
                    (
                        priority,
                        {
                            "kind": "clip",
                            "label": file_name,
                            "camera": member.get("camera", ""),
                            "clip_id": member.get("clip_id", ""),
                            "group_id": group_id,
                            "episode_ids": episode_ids,
                            "script_segment_ids": segment_ids,
                            "parent_group_id": group.get("parent_group_id", ""),
                        },
                    )
                )
        for segment in self.segments.values():
            haystack = self._search_text(
                " ".join(
                    [
                        str(segment.get("raw_text", "")),
                        str(segment.get("text", "")),
                        str(segment.get("segment_id", "")),
                        str(segment.get("scene_id", "")),
                    ]
                )
            )
            if query in haystack:
                hits.append(
                    (
                        3,
                        {
                            "kind": "script",
                            "label": segment.get("raw_text", ""),
                            "episode_ids": [segment.get("episode")],
                            "script_segment_ids": [segment.get("segment_id")],
                            "scene_id": segment.get("scene_id", ""),
                            "order": segment.get("order", 0),
                        },
                    )
                )
        hits.sort(key=lambda item: (item[0], str(item[1].get("label", ""))))
        return [item for _priority, item in hits[:60]]

    def evidence(self, group_id: str) -> dict[str, Any]:
        self.reload_if_changed()
        group = self.groups.get(group_id)
        if not group:
            raise KeyError(group_id)
        store = TranscriptStore(self.config.transcript_dir)
        transcripts = []
        for member in group.get("members", []):
            if not isinstance(member, dict):
                continue
            clip = self.clips.get(str(member.get("clip_id", "")))
            if not clip:
                continue
            from .models import Clip

            source = Clip(
                clip_id=str(clip.get("clip_id", "")),
                name=str(clip.get("name", "")),
                camera=str(clip.get("camera", "")),
                media_path=str(clip.get("media_path", "")),
                timeline_start=0,
                timeline_end=0,
                duration=0,
                exists=bool(clip.get("exists", False)),
                media_id=str(clip.get("media_id", "") or ""),
            )
            transcript = store.load(source)
            if transcript:
                sliced = slice_transcript(
                    transcript,
                    float(member.get("source_start", 0) or 0),
                    float(member["source_end"]) if member.get("source_end") is not None else None,
                )
                transcripts.append(
                    {
                        "clip_id": member.get("clip_id", ""),
                        "camera": member.get("camera", ""),
                        "source_start": member.get("source_start", 0),
                        "source_end": member.get("source_end"),
                        "text": sliced.text,
                        "segments": [segment.to_dict() for segment in sliced.segments],
                        "backend": sliced.backend,
                        "error": sliced.error,
                    }
                )
        review = self.review.load()
        return {
            "group": group,
            "candidates": self.matches.get("groups", {}).get(group_id, {}).get("candidates", []),
            "asr": transcripts,
            "review": {
                "placement": review.get("placements", {}).get(group_id, {}),
                "group": review.get("groups", {}).get(group_id, {}),
                "assignments": {
                    segment_id: rows[group_id]
                    for segment_id, rows in review.get("assignments", {}).items()
                    if isinstance(rows, dict) and group_id in rows
                },
            },
        }


class WorkspaceService:
    def __init__(self, workspace: WorkspaceConfig):
        self.workspace = workspace
        self.registry = WorkspaceRegistry(workspace)
        self.tokens = AgentTokenStore(workspace)
        self.tasks = TaskManager(self.project_config, workspace.workspace_id)
        # Legacy single-workspace `serve` callers may not yet have a stable
        # workspace_id. Gateway routes require one; this fallback only keeps
        # their host-local runtime state isolated without changing workspace
        # artifacts.
        collaboration_scope = workspace.workspace_id or (
            "legacy-" + hashlib.sha1(str(workspace.config_path.resolve()).encode("utf-8")).hexdigest()[:16]
        )
        self.collaborators = CollaborationAccessStore(collaboration_scope)
        self._projects: dict[str, ProjectService] = {}

    def project_config(self, project_id: str) -> ProjectConfig:
        return self.registry.project_config(project_id)

    def project(self, project_id: str) -> ProjectService:
        entry = self.registry.get(project_id)
        config_path = self.registry.project_config(project_id).config_path
        current = self._projects.get(project_id)
        if current and current.config.config_path == config_path:
            return current
        project = ProjectService(project_id, ProjectConfig.from_file(config_path))
        project.workspace_id = self.workspace.workspace_id
        self._projects[project_id] = project
        return project

    @staticmethod
    def _lightweight_project_summary(entry: dict[str, Any]) -> dict[str, Any]:
        """Return the registry-only project row used by workspace discovery.

        Opening a workspace should not synchronously construct every
        ProjectService. Its constructor reloads material_index, script and
        matches, which can be a large cold-start operation. Detailed project
        routes still call ``project()`` and materialize their own payload on
        demand.
        """
        project_id = str(entry.get("project_id", "") or "").strip()
        stats = entry.get("stats", {})
        return {
            "project_id": project_id,
            "name": str(entry.get("name", "") or project_id),
            "input_kind": str(entry.get("input_kind", "") or ""),
            "analysis_revision": str(entry.get("analysis_revision", "") or ""),
            "stats": dict(stats) if isinstance(stats, dict) else {},
            "source": dict(entry.get("source", {})) if isinstance(entry.get("source"), dict) else {},
            "local_media": dict(entry.get("local_media", {})) if isinstance(entry.get("local_media"), dict) else {},
        }

    def workspace_payload(self) -> dict[str, Any]:
        # Keep workspace discovery bounded by the small registry. A project
        # is materialized only after the user opens its project route.
        projects = [self._lightweight_project_summary(entry) for entry in self.registry.list()]
        return {
            "workspace_id": self.workspace.workspace_id,
            "workspace": self.workspace.name,
            "api_version": "v1",
            "projects": projects,
        }

    def frontend_settings(self) -> dict[str, Any]:
        return _load_frontend_settings(self.workspace)

    def save_frontend_settings(self, payload: object) -> dict[str, Any]:
        settings = _validate_frontend_settings(payload)
        _write_json_atomic(_frontend_settings_path(self.workspace), settings)
        return settings

    def capabilities(self, agent: dict[str, Any]) -> dict[str, Any]:
        return {
            "contract_version": "agent.v1",
            "agent": self.tokens.public(agent),
            "input_adapters": ["fcpxml", "media-directory"],
            "script_formats": ["docx", "txt", "markdown"],
            "task_types": ["incremental_analyze", "transcribe", "evidence_extract"],
            "proposal_types": ["placement"],
            "allowed_actions": ["read", "analyze", "propose"],
            "forbidden_actions": [
                "apply_review",
                "reject_material",
                "delete_source",
                "rewrite_fcpxml",
                "change_global_matching_threshold",
            ],
            "projects": [item for item in self.workspace_payload()["projects"] if item.get("project_id") in agent.get("project_ids", [])],
        }


class GatewaySecurity:
    """Small in-memory LAN pairing boundary for the local gateway."""

    def __init__(
        self,
        require_pairing: bool = True,
        pairing_code: str | None = None,
        session_ttl_seconds: int = 12 * 60 * 60,
    ):
        self.require_pairing = require_pairing
        self.pairing_code = pairing_code or secrets.token_urlsafe(6)
        self.session_ttl_seconds = max(60, session_ttl_seconds)
        self._sessions: dict[str, float] = {}
        self._lock = threading.RLock()

    def _purge_expired(self) -> None:
        now = time.monotonic()
        self._sessions = {
            token: expires_at
            for token, expires_at in self._sessions.items()
            if expires_at > now
        }

    def public(self, local: bool = False) -> dict[str, Any]:
        with self._lock:
            self._purge_expired()
        return {
            "required": self.require_pairing,
            "paired": bool(self._sessions),
            "session_ttl_seconds": self.session_ttl_seconds,
            "pairing_code": self.pairing_code if local else "",
        }

    def exchange(self, code: str) -> str:
        if not self.require_pairing:
            return ""
        if not secrets.compare_digest(str(code or ""), self.pairing_code):
            raise ApiError(HTTPStatus.UNAUTHORIZED, "局域网配对码无效")
        token = "mos_" + secrets.token_urlsafe(24)
        with self._lock:
            self._purge_expired()
            self._sessions[token] = time.monotonic() + self.session_ttl_seconds
        return token

    def allow(self, client_host: str, session: str) -> bool:
        if client_host in {"127.0.0.1", "::1"} or not self.require_pairing:
            return True
        with self._lock:
            self._purge_expired()
            return session in self._sessions


class WorkspaceGateway:
    """Routes one LAN listener to several independently configured workspaces."""

    def __init__(
        self,
        workspaces: list[WorkspaceConfig],
        *,
        require_pairing: bool = True,
        pairing_code: str | None = None,
    ):
        if not workspaces:
            raise ValueError("网关至少需要一个工作区")
        self.services = {item.workspace_id: WorkspaceService(item) for item in workspaces if item.workspace_id}
        if len(self.services) != len(workspaces):
            raise ValueError("所有工作区必须先拥有稳定 workspace_id")
        self.security = GatewaySecurity(require_pairing, pairing_code)
        self._local = threading.local()

    def select(self, workspace_id: str) -> WorkspaceService:
        try:
            service = self.services[workspace_id]
        except KeyError as error:
            raise ApiError(HTTPStatus.NOT_FOUND, "工作区不存在") from error
        self._local.service = service
        return service

    @property
    def current(self) -> WorkspaceService:
        service = getattr(self._local, "service", None)
        if service is None:
            raise ApiError(HTTPStatus.BAD_REQUEST, "请求缺少 workspace_id")
        return service

    @property
    def registry(self) -> WorkspaceRegistry:
        return self.current.registry

    @property
    def tasks(self) -> TaskManager:
        return self.current.tasks

    @property
    def tokens(self) -> AgentTokenStore:
        return self.current.tokens

    def project(self, project_id: str) -> ProjectService:
        return self.current.project(project_id)

    def project_config(self, project_id: str) -> ProjectConfig:
        return self.current.project_config(project_id)

    def frontend_settings(self) -> dict[str, Any]:
        return self.current.frontend_settings()

    def save_frontend_settings(self, payload: object) -> dict[str, Any]:
        return self.current.save_frontend_settings(payload)

    def capabilities(self, agent: dict[str, Any]) -> dict[str, Any]:
        return self.current.capabilities(agent)

    def workspace_payload(self) -> dict[str, Any]:
        return self.current.workspace_payload()

    def all_payload(self) -> dict[str, Any]:
        workspaces = []
        for service in self.services.values():
            payload = service.workspace_payload()
            workspaces.append(
                {
                    "workspace_id": service.workspace.workspace_id,
                    "workspace": service.workspace.name,
                    "projects": payload["projects"],
                }
            )
        return {
            "api_version": "v1",
            "workspaces": workspaces,
        }

    def workspace_payload_for(self, workspace_id: str) -> dict[str, Any]:
        return self.select(workspace_id).workspace_payload()


def _parts(path: str) -> list[str]:
    return [part for part in path.split("/") if part]


def _body(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    try:
        length = int(handler.headers.get("Content-Length", "0"))
    except ValueError as error:
        raise ApiError(HTTPStatus.BAD_REQUEST, "无效请求长度") from error
    if length > 1024 * 1024:
        raise ApiError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "请求过大")
    try:
        payload = json.loads(handler.rfile.read(length).decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        raise ApiError(HTTPStatus.BAD_REQUEST, "JSON请求无效") from error
    if not isinstance(payload, dict):
        raise ApiError(HTTPStatus.BAD_REQUEST, "请求必须是对象")
    return payload


def make_handler(service: WorkspaceService, web_root: Path):
    class Handler(BaseHTTPRequestHandler):
        server_version = "VideoMaterialPlatform/1.0"

        def log_message(self, format: str, *args: Any) -> None:
            return

        def _send_json(
            self,
            payload: object,
            status: HTTPStatus = HTTPStatus.OK,
            headers: dict[str, str] | None = None,
        ) -> None:
            body = _json_bytes(payload)
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                return

        def _local_only(self) -> None:
            if self.client_address[0] not in {"127.0.0.1", "::1"}:
                raise ApiError(HTTPStatus.FORBIDDEN, "此操作只能在本机执行")

        def _review_actor(self, requested: object) -> str:
            return str(requested or "").strip()[:80]

        def _require_review_access(self) -> None:
            return

        def _agent(self, scope: str, project_id: str | None = None) -> dict[str, Any]:
            authorization = self.headers.get("Authorization", "")
            if not authorization.startswith("Bearer "):
                raise ApiError(HTTPStatus.UNAUTHORIZED, "缺少智能体Bearer令牌")
            try:
                return service.tokens.authorize(authorization.removeprefix("Bearer ").strip(), scope, project_id)
            except AgentAuthorizationError as error:
                raise ApiError(HTTPStatus.UNAUTHORIZED, str(error)) from error
            except AgentRateLimitError as error:
                raise ApiError(HTTPStatus.TOO_MANY_REQUESTS, str(error)) from error
            except AgentForbiddenError as error:
                raise ApiError(HTTPStatus.FORBIDDEN, str(error)) from error

        def do_GET(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            try:
                if parsed.path.startswith("/api/agent/v1/"):
                    self._agent_get(parsed)
                elif parsed.path.startswith("/api/v1/"):
                    self._app_get(parsed)
                else:
                    self._static(parsed.path)
            except ApiError as error:
                self._send_json({"error": str(error)}, error.status)
            except KeyError:
                self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception as error:
                self._send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)

        def do_HEAD(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            try:
                parts = _parts(parsed.path)
                if len(parts) == 6 and parts[:3] == ["api", "v1", "projects"] and parts[4] == "media":
                    project = service.project(parts[3])
                    self._media(project, urllib.parse.unquote(parts[5]), head_only=True)
                else:
                    self._static(parsed.path, head_only=True)
            except ApiError as error:
                self._send_json({"error": str(error)}, error.status)

        def do_POST(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            try:
                if parsed.path.startswith("/api/agent/v1/"):
                    self._agent_post(parsed)
                elif parsed.path.startswith("/api/v1/"):
                    self._app_post(parsed)
                else:
                    raise ApiError(HTTPStatus.NOT_FOUND, "not found")
            except ApiError as error:
                self._send_json({"error": str(error)}, error.status)
            except KeyError:
                self._send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
            except ValueError as error:
                self._send_json({"error": str(error)}, HTTPStatus.BAD_REQUEST)
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception as error:
                self._send_json({"error": str(error)}, HTTPStatus.INTERNAL_SERVER_ERROR)

        def _app_get(self, parsed: urllib.parse.ParseResult) -> None:
            parts = _parts(parsed.path)
            query = urllib.parse.parse_qs(parsed.query)
            if parts == ["api", "v1", "ping"]:
                self._send_json({"status": "ok", "service": "mirrororder-host"})
                return
            if parts == ["api", "v1", "workspace"]:
                self._send_json(service.workspace_payload())
                return
            if parts == ["api", "v1", "settings"]:
                self._send_json(service.frontend_settings())
                return
            if len(parts) < 4 or parts[:3] != ["api", "v1", "projects"]:
                raise ApiError(HTTPStatus.NOT_FOUND, "not found")
            project_id, rest = parts[3], parts[4:]
            project = service.project(project_id)
            if not rest:
                self._send_json(project.project_payload())
            elif rest == ["script"]:
                self._send_json(project.script)
            elif rest == ["groups"]:
                self._send_json(project.index.get("groups", []))
            elif rest == ["matches"]:
                self._send_json(project.matches)
            elif rest == ["review"]:
                self._send_json(project.review.load())
            elif rest == ["state"]:
                self._send_json(project.state())
            elif rest == ["tasks"]:
                self._send_json({"tasks": service.tasks.list(project_id)})
            elif rest == ["proposals"]:
                self._send_json({"proposals": project.proposals.list()})
            elif rest == ["search"]:
                self._send_json({"query": (query.get("q") or [""])[0], "results": project.search((query.get("q") or [""])[0])})
            elif len(rest) == 2 and rest[0] == "candidates":
                self._send_json(project.matches.get("by_segment", {}).get(urllib.parse.unquote(rest[1]), []))
            elif len(rest) == 2 and rest[0] == "media":
                self._media(project, urllib.parse.unquote(rest[1]))
            else:
                raise ApiError(HTTPStatus.NOT_FOUND, "not found")

        def _app_post(self, parsed: urllib.parse.ParseResult) -> None:
            parts = _parts(parsed.path)
            if parts == ["api", "v1", "settings"]:
                self._local_only()
                self._send_json(service.save_frontend_settings(_body(self)))
                return
            if parts == ["api", "v1", "projects"]:
                self._local_only()
                self._send_json(service.registry.create(_body(self)), HTTPStatus.CREATED)
                return
            if parts == ["api", "v1", "path-picker"]:
                self._local_only()
                self._send_json({"path": self._path_picker(str(_body(self).get("kind", "file")))})
                return
            if parts == ["api", "v1", "agent-tokens"]:
                self._local_only()
                payload = _body(self)
                project_ids = [str(value) for value in payload.get("project_ids", [])]
                for project_id in project_ids:
                    service.registry.get(project_id)
                record, token = service.tokens.create(
                    str(payload.get("name", "local-agent")),
                    project_ids,
                    [str(value) for value in payload.get("scopes", ["read", "analyze", "propose"])],
                    int(payload.get("expires_days", 30) or 30),
                )
                self._send_json({"token": token, "record": record}, HTTPStatus.CREATED)
                return
            if len(parts) < 4 or parts[:3] != ["api", "v1", "projects"]:
                raise ApiError(HTTPStatus.NOT_FOUND, "not found")
            project_id, rest = parts[3], parts[4:]
            if rest == ["delete"]:
                self._local_only()
                payload = _body(self)
                if str(payload.get("confirm_project_id", "")) != project_id:
                    raise ApiError(HTTPStatus.BAD_REQUEST, "删除项目需要确认 project_id")
                active = [
                    task for task in service.tasks.list(project_id)
                    if task.get("status") in {"queued", "running"}
                ]
                if active:
                    raise ApiError(HTTPStatus.CONFLICT, "当前项目仍有后台任务运行，请等待完成或取消后再删除")
                result = service.registry.delete(project_id, str(payload.get("confirm_project_id", "")))
                current_service = getattr(service, "current", service)
                current_service._projects.pop(project_id, None)
                DeviceMediaStore().remove_project(current_service.workspace.workspace_id, project_id)
                WorkspaceDatabase(current_service.workspace.workspace_id).remove_project(project_id)
                self._send_json(result)
                return
            project = service.project(project_id)
            payload = _body(self)
            if rest == ["review"]:
                self._require_review_access()
                payload["actor"] = self._review_actor(payload.get("actor"))
                if not payload.get("action"):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "审核写入必须使用原子 action")
                if not str(payload.get("actor", "")).strip():
                    raise ApiError(HTTPStatus.BAD_REQUEST, "审核写入需要审核昵称")
                saved = project.review.apply_action(payload)
                self._send_json(saved)
            elif rest == ["tasks"]:
                task = service.tasks.submit(
                    project_id,
                    str(payload.get("type", "")),
                    payload.get("targets", {}),
                    str(payload.get("idempotency_key", "")),
                    str(payload.get("actor", "human")),
                )
                self._send_json(task, HTTPStatus.ACCEPTED)
            elif len(rest) == 2 and rest[0] == "tasks":
                self._send_json(service.tasks.cancel(project_id, rest[1]))
            elif rest == ["proposals", "apply"]:
                self._require_review_access()
                actor = self._review_actor(payload.get("actor"))
                proposal_ids = payload.get("proposal_ids", [])
                if not actor or not isinstance(proposal_ids, list):
                    raise ApiError(HTTPStatus.BAD_REQUEST, "应用提案需要审核昵称和提案列表")
                applied = project.proposals.apply(
                    [str(value) for value in proposal_ids],
                    actor,
                    project.groups,
                    project.segments,
                    project.analysis_revision,
                    project.review,
                )
                self._send_json({"applied": applied, "review": project.review.load()})
            else:
                raise ApiError(HTTPStatus.NOT_FOUND, "not found")

        def _agent_get(self, parsed: urllib.parse.ParseResult) -> None:
            parts = _parts(parsed.path)
            if parts == ["api", "agent", "v1", "capabilities"]:
                self._send_json(service.capabilities(self._agent("read")))
                return
            if parts == ["api", "agent", "v1", "projects"]:
                agent = self._agent("read")
                payload = service.workspace_payload()
                payload["projects"] = [item for item in payload["projects"] if item.get("project_id") in agent.get("project_ids", [])]
                self._send_json(payload)
                return
            if len(parts) < 5 or parts[:4] != ["api", "agent", "v1", "projects"]:
                raise ApiError(HTTPStatus.NOT_FOUND, "not found")
            project_id, rest = parts[4], parts[5:]
            agent = self._agent("read", project_id)
            project = service.project(project_id)
            if rest == ["context"]:
                response = project.agent_context()
            elif rest == ["tasks"]:
                response = {"tasks": service.tasks.list(project_id)}
            elif len(rest) == 2 and rest[0] == "evidence":
                response = project.evidence(rest[1])
            elif rest == ["search"]:
                query = urllib.parse.parse_qs(parsed.query)
                response = {"results": project.search((query.get("q") or [""])[0])}
            else:
                raise ApiError(HTTPStatus.NOT_FOUND, "not found")
            service.tokens.audit(agent, "read:" + "/".join(rest or ["project"]), project_id)
            self._send_json(response)

        def _agent_post(self, parsed: urllib.parse.ParseResult) -> None:
            parts = _parts(parsed.path)
            if len(parts) < 5 or parts[:4] != ["api", "agent", "v1", "projects"]:
                raise ApiError(HTTPStatus.NOT_FOUND, "not found")
            project_id, rest = parts[4], parts[5:]
            project = service.project(project_id)
            payload = _body(self)
            if rest == ["tasks"]:
                agent = self._agent("analyze", project_id)
                task = service.tasks.submit(
                    project_id,
                    str(payload.get("type", "")),
                    payload.get("targets", {}),
                    str(payload.get("idempotency_key", "")),
                    "agent:" + str(agent.get("name", "")),
                )
                service.tokens.audit(agent, "task:" + str(task.get("type", "")), project_id, {"task_id": task.get("task_id")})
                self._send_json(task, HTTPStatus.ACCEPTED)
            elif rest == ["proposals"]:
                agent = self._agent("propose", project_id)
                state = project.state()
                proposal = project.proposals.create(
                    payload,
                    agent,
                    project.groups,
                    project.segments,
                    state["analysis_revision"],
                    int(state["review_revision"]),
                )
                service.tokens.audit(agent, "proposal:create", project_id, {"proposal_id": proposal["proposal_id"]})
                self._send_json(proposal, HTTPStatus.CREATED)
            else:
                raise ApiError(HTTPStatus.NOT_FOUND, "not found")

        def _static(self, request_path: str, head_only: bool = False) -> None:
            relative = request_path.removeprefix("/") or "index.html"
            candidate = (web_root / relative).resolve()
            if web_root.resolve() not in candidate.parents and candidate != web_root.resolve():
                raise ApiError(HTTPStatus.FORBIDDEN, "forbidden")
            if not candidate.exists() or not candidate.is_file():
                raise ApiError(HTTPStatus.NOT_FOUND, "not found")
            body = candidate.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", mimetypes.guess_type(candidate.name)[0] or "application/octet-stream")
            # Frontend JS/CSS/HTML is served from the local App bundle.  Do not
            # let a previously loaded bundle keep stale workbench behavior
            # (for example the removed compact episode menu) after a rebuild.
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head_only:
                self.wfile.write(body)

        def _media(self, project: ProjectService, clip_id: str, head_only: bool = False) -> None:
            clip = project.clips.get(clip_id)
            if not clip:
                raise ApiError(HTTPStatus.NOT_FOUND, "unknown clip")
            path = Path(clip.get("media_path", ""))
            if not path.exists() or not path.is_file():
                raise ApiError(HTTPStatus.NOT_FOUND, "media missing")
            size = path.stat().st_size
            start, end = 0, size - 1
            range_header = self.headers.get("Range", "")
            if range_header.startswith("bytes="):
                value = range_header.removeprefix("bytes=").split(",", 1)[0]
                left, _, right = value.partition("-")
                if left:
                    start = int(left)
                if right:
                    end = int(right)
                else:
                    end = min(size - 1, start + 4 * 1024 * 1024 - 1)
                start, end = max(0, start), min(size - 1, end)
                if start > end:
                    raise ApiError(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "range invalid")
                status = HTTPStatus.PARTIAL_CONTENT
            else:
                status = HTTPStatus.OK
            length = end - start + 1
            self.send_response(status)
            self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "video/mp4")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            if status == HTTPStatus.PARTIAL_CONTENT:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            if head_only:
                return
            with path.open("rb") as handle:
                handle.seek(start)
                remaining = length
                while remaining:
                    chunk = handle.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        return
                    remaining -= len(chunk)

        @staticmethod
        def _path_picker(kind: str) -> str:
            if kind not in {"file", "folder"}:
                raise ApiError(HTTPStatus.BAD_REQUEST, "路径选择类型无效")
            script = 'POSIX path of (choose folder with prompt "选择媒体目录")' if kind == "folder" else 'POSIX path of (choose file with prompt "选择项目输入文件")'
            try:
                result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=90, check=True)
                return result.stdout.strip()
            except subprocess.CalledProcessError as error:
                if "-128" in (error.stderr or ""):
                    return ""
                raise ApiError(HTTPStatus.BAD_REQUEST, "没有选择路径") from error
            except (OSError, subprocess.SubprocessError) as error:
                raise ApiError(HTTPStatus.BAD_REQUEST, "本机路径选择不可用") from error

    return Handler


def make_gateway_handler(gateway: WorkspaceGateway, web_root: Path):
    """Expose workspace-scoped routes while reusing the project handlers."""
    BaseHandler = make_handler(gateway, web_root)

    class Handler(BaseHandler):
        def _session(self) -> str:
            header = self.headers.get("X-MirrorOrder-Session", "").strip()
            if header:
                return header
            try:
                cookies = SimpleCookie()
                cookies.load(self.headers.get("Cookie", ""))
                item = cookies.get("MirrorOrderSession")
                return item.value if item else ""
            except (KeyError, ValueError):
                return ""

        @staticmethod
        def _session_cookie(token: str, max_age: int) -> str:
            cookie = SimpleCookie()
            cookie["MirrorOrderSession"] = token
            cookie["MirrorOrderSession"]["path"] = "/"
            cookie["MirrorOrderSession"]["max-age"] = str(max_age)
            cookie["MirrorOrderSession"]["httponly"] = True
            cookie["MirrorOrderSession"]["samesite"] = "Lax"
            return cookie.output(header="").strip()

        def _authorize_app(self) -> None:
            if not gateway.security.allow(self.client_address[0], self._session()):
                raise ApiError(HTTPStatus.UNAUTHORIZED, "需要先完成局域网配对")

        def _is_local_client(self) -> bool:
            return self.client_address[0] in {"127.0.0.1", "::1"}

        def _browser_user(self) -> dict[str, Any]:
            service = gateway.current
            device_id = self.headers.get("X-MirrorOrder-Device", "").strip()
            if not device_id and self._is_local_client():
                # Native Host calls do not have browser localStorage. Keep a
                # stable local manager record without granting the same
                # fallback to LAN callers.
                device_id = "host-api-local"
            try:
                return service.collaborators.observe(
                    device_id,
                    ip=self.client_address[0],
                    user_agent=self.headers.get("User-Agent", ""),
                    local=self._is_local_client(),
                    paired=gateway.security.require_pairing,
                )
            except ValueError as error:
                raise ApiError(HTTPStatus.BAD_REQUEST, str(error)) from error
            except PermissionError as error:
                raise ApiError(HTTPStatus.FORBIDDEN, str(error)) from error

        def _review_actor(self, requested: object) -> str:
            if not self.headers.get("X-MirrorOrder-Device", "").strip() and self._is_local_client():
                # The native Host and local maintenance scripts are not
                # browsers, so they do not have a browser identity header.
                return str(requested or "").strip()[:80]
            user = self._browser_user()
            nickname = str(user.get("nickname", "") or "").strip()
            if not nickname:
                raise ApiError(HTTPStatus.BAD_REQUEST, "请先填写审核昵称")
            return nickname

        def _require_review_access(self) -> None:
            user = self._browser_user()
            try:
                CollaborationAccessStore.require_role(user, "reviewer")
            except PermissionError as error:
                raise ApiError(HTTPStatus.FORBIDDEN, str(error)) from error

        def _rewrite(self, parsed: urllib.parse.ParseResult, path: str) -> None:
            self.path = urllib.parse.urlunparse(("", "", path, "", parsed.query, ""))

        def _select_workspace(self, workspace_id: str) -> None:
            gateway.select(urllib.parse.unquote(workspace_id))

        def _prepare_app(self, parsed: urllib.parse.ParseResult) -> tuple[str, str]:
            parts = _parts(parsed.path)
            self._authorize_app()
            if parts == ["api", "v1", "workspaces"]:
                return "", "workspace-list"
            if len(parts) < 4 or parts[:3] != ["api", "v1", "workspaces"]:
                raise ApiError(HTTPStatus.NOT_FOUND, "not found")
            workspace_id = parts[3]
            self._select_workspace(workspace_id)
            rest = parts[4:]
            if not rest:
                return workspace_id, "workspace"
            if rest == ["projects"]:
                self._rewrite(parsed, "/api/v1/workspace")
                return workspace_id, ""
            if rest[0] == "projects":
                self._rewrite(parsed, "/api/v1/projects/" + "/".join(rest[1:]))
                return workspace_id, ""
            self._rewrite(parsed, "/api/v1/" + "/".join(rest))
            return workspace_id, ""

        def _prepare_agent(self, parsed: urllib.parse.ParseResult) -> tuple[str, bool]:
            parts = _parts(parsed.path)
            if len(parts) < 5 or parts[:4] != ["api", "agent", "v1", "workspaces"]:
                raise ApiError(HTTPStatus.NOT_FOUND, "not found")
            workspace_id = parts[4]
            self._select_workspace(workspace_id)
            rest = parts[5:]
            if rest == ["capabilities"]:
                self._rewrite(parsed, "/api/agent/v1/capabilities")
            elif rest == ["projects"]:
                self._rewrite(parsed, "/api/agent/v1/projects")
            elif rest and rest[0] == "projects":
                self._rewrite(parsed, "/api/agent/v1/projects/" + "/".join(rest[1:]))
            else:
                raise ApiError(HTTPStatus.NOT_FOUND, "not found")
            return workspace_id, False

        def _user_route(self, parsed: urllib.parse.ParseResult) -> tuple[str, list[str]] | None:
            parts = _parts(parsed.path)
            if len(parts) < 5 or parts[:3] != ["api", "v1", "workspaces"] or parts[4] != "users":
                return None
            self._authorize_app()
            workspace_id = urllib.parse.unquote(parts[3])
            self._select_workspace(workspace_id)
            return workspace_id, parts[5:]

        def _user_get(self, parsed: urllib.parse.ParseResult) -> bool:
            route = self._user_route(parsed)
            if route is None:
                return False
            _workspace_id, rest = route
            store = gateway.current.collaborators
            if rest == ["me"]:
                self._send_json({"user": self._browser_user()})
                return True
            if not self._is_local_client():
                raise ApiError(HTTPStatus.FORBIDDEN, "用户管理只能在制作主机执行")
            if not rest:
                self._send_json({"users": store.list_users()})
                return True
            if rest == ["audit"]:
                self._send_json({"audit": store.audit()})
                return True
            raise ApiError(HTTPStatus.NOT_FOUND, "not found")

        def _user_post(self, parsed: urllib.parse.ParseResult) -> bool:
            route = self._user_route(parsed)
            if route is None:
                return False
            _workspace_id, rest = route
            store = gateway.current.collaborators
            try:
                if rest == ["me"]:
                    user = self._browser_user()
                    CollaborationAccessStore.require_role(user, "viewer")
                    self._send_json({"user": store.rename(
                        self.headers.get("X-MirrorOrder-Device", "").strip(),
                        _body(self).get("nickname"),
                    )})
                    return True
                if len(rest) == 1 and rest[0]:
                    if not self._is_local_client():
                        raise ApiError(HTTPStatus.FORBIDDEN, "用户管理只能在制作主机执行")
                    self._send_json({"user": store.update_user(rest[0], _body(self))})
                    return True
            except ValueError as error:
                raise ApiError(HTTPStatus.BAD_REQUEST, str(error)) from error
            except PermissionError as error:
                raise ApiError(HTTPStatus.FORBIDDEN, str(error)) from error
            raise ApiError(HTTPStatus.NOT_FOUND, "not found")

        def do_GET(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            try:
                if parsed.path == "/api/v1/pairing":
                    local = self.client_address[0] in {"127.0.0.1", "::1"}
                    self._send_json(gateway.security.public(local))
                    return
                if parsed.path == "/api/v1/ping":
                    self._send_json({"status": "ok", "service": "mirrororder-gateway"})
                    return
                if parsed.path.startswith("/api/v1/"):
                    if self._user_get(parsed):
                        return
                    workspace_id, special = self._prepare_app(parsed)
                    if special == "workspace-list":
                        self._send_json(gateway.all_payload())
                        return
                    if special == "workspace":
                        if workspace_id:
                            self._send_json(gateway.workspace_payload_for(workspace_id))
                        else:
                            raise ApiError(HTTPStatus.NOT_FOUND, "not found")
                        return
                elif parsed.path.startswith("/api/agent/v1/"):
                    self._prepare_agent(parsed)
                super().do_GET()
            except ApiError as error:
                self._send_json({"error": str(error)}, error.status)

        def do_HEAD(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            try:
                if parsed.path.startswith("/api/v1/"):
                    self._prepare_app(parsed)
                elif parsed.path.startswith("/api/agent/v1/"):
                    self._prepare_agent(parsed)
                super().do_HEAD()
            except ApiError as error:
                self._send_json({"error": str(error)}, error.status)

        def do_POST(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            try:
                if parsed.path == "/api/v1/pairing":
                    payload = _body(self)
                    token = gateway.security.exchange(str(payload.get("code", "")))
                    headers = (
                        {"Set-Cookie": self._session_cookie(token, gateway.security.session_ttl_seconds)}
                        if token
                        else {}
                    )
                    self._send_json({"paired": True}, headers=headers)
                    return
                if parsed.path.startswith("/api/v1/"):
                    if self._user_post(parsed):
                        return
                    parts = _parts(parsed.path)
                    if len(parts) == 5 and parts[:3] == ["api", "v1", "workspaces"] and parts[4] == "projects":
                        self._authorize_app()
                        self._select_workspace(parts[3])
                        self._rewrite(parsed, "/api/v1/projects")
                    else:
                        self._prepare_app(parsed)
                elif parsed.path.startswith("/api/agent/v1/"):
                    self._prepare_agent(parsed)
                else:
                    raise ApiError(HTTPStatus.NOT_FOUND, "not found")
                super().do_POST()
            except ApiError as error:
                self._send_json({"error": str(error)}, error.status)

    return Handler


def serve(workspace: WorkspaceConfig, host: str = "0.0.0.0", port: int = 8765) -> None:
    service = WorkspaceService(workspace)
    server = MirrorOrderHTTPServer((host, port), make_handler(service, workspace.web_dir))
    print(f"Video Material Platform: http://{host}:{port}/")
    if host in {"0.0.0.0", "::"}:
        addresses = set()
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                address = info[4][0]
                if not address.startswith("127."):
                    addresses.add(address)
        except OSError:
            pass
        for address in sorted(addresses):
            print(f"LAN: http://{address}:{port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def serve_gateway(
    workspaces: list[WorkspaceConfig],
    host: str = "0.0.0.0",
    port: int = 8766,
    *,
    require_pairing: bool = True,
    pairing_code: str | None = None,
) -> None:
    gateway = WorkspaceGateway(
        workspaces,
        require_pairing=require_pairing,
        pairing_code=pairing_code,
    )
    web_root = workspaces[0].web_dir
    server = MirrorOrderHTTPServer((host, port), make_gateway_handler(gateway, web_root))
    print(f"MirrorOrder Workspace Gateway: http://{host}:{port}/")
    if require_pairing:
        print(f"PAIRING_CODE={gateway.security.pairing_code}")
    if host in {"0.0.0.0", "::"}:
        addresses = set()
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                address = info[4][0]
                if not address.startswith("127."):
                    addresses.add(address)
        except OSError:
            pass
        for address in sorted(addresses):
            print(f"LAN: http://{address}:{port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
