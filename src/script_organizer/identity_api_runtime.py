from __future__ import annotations

import json
import mimetypes
import urllib.parse
from pathlib import Path
from typing import Any

from .identity_library import IdentityLibrary
from .identity_role_inference import install_identity_role_inference
from .workspace_db import WorkspaceDatabase

_INSTALLED = False
_IDENTITY_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}


def _library(project: Any) -> IdentityLibrary:
    workspace_id = str(getattr(project, "workspace_id", "") or "").strip()
    if not workspace_id:
        raise ValueError("identity library 需要稳定 workspace_id")
    return IdentityLibrary(WorkspaceDatabase(workspace_id), str(project.project_id))


def _decorate_rows(project: Any, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Attach portable visual metadata while keeping filesystem paths server-side."""
    clips = getattr(project, "clips", {})
    if not isinstance(clips, dict):
        clips = {}
    for row in rows:
        example = row.get("example") if isinstance(row.get("example"), dict) else None
        if example is not None:
            portable_example = dict(example)
            face_crop_path = str(portable_example.pop("face_crop_path", "") or "").strip()
            portable_example.pop("source_frame_path", None)
            portable_example["portrait_available"] = (
                str(row.get("kind", "") or "") == "face" and bool(face_crop_path)
            )
            row["example"] = portable_example

        occurrences = row.get("occurrences", [])
        if not isinstance(occurrences, list):
            continue
        for occurrence in occurrences:
            if not isinstance(occurrence, dict):
                continue
            clip_id = str(occurrence.get("clip_id", "") or "")
            clip = clips.get(clip_id)
            if not isinstance(clip, dict):
                continue
            occurrence["media_id"] = str(clip.get("media_id", "") or "")
            occurrence["name"] = str(clip.get("name", "") or clip.get("display_name", "") or clip_id)
            occurrence["shot_type"] = str(clip.get("shot_type", "") or "unknown")
            try:
                duration = float(clip.get("duration", 0) or 0)
            except (TypeError, ValueError):
                duration = 0.0
            if duration > 0:
                occurrence["duration"] = duration
    return rows


def _portrait_asset(project: Any, identity_id: str) -> tuple[Path, str]:
    """Resolve one stored face crop with a single DB lookup and no client-supplied path."""
    library = _library(project)
    with library.database.connection() as connection:
        row = connection.execute(
            """
            SELECT i.kind, o.metadata_json
            FROM identities AS i
            LEFT JOIN identity_observations AS o
              ON o.project_id=i.project_id AND o.identity_id=i.identity_id
            WHERE i.project_id=? AND i.identity_id=?
            ORDER BY o.confidence DESC, (o.end-o.start) DESC, o.observation_id
            LIMIT 1
            """,
            (library.project_id, str(identity_id or "")),
        ).fetchone()
    if row is None:
        raise LookupError("identity 不存在")
    if str(row["kind"] or "") != "face":
        raise LookupError("这个身份没有人脸图")
    try:
        metadata = json.loads(str(row["metadata_json"] or "{}"))
    except (TypeError, ValueError):
        metadata = {}
    raw_path = str(metadata.get("face_crop_path", "") or "").strip() if isinstance(metadata, dict) else ""
    if not raw_path:
        raise LookupError("这个身份还没有人脸裁切图")
    path = Path(raw_path).expanduser()
    try:
        if path.is_symlink() or not path.is_file():
            raise LookupError("人脸裁切图不存在")
    except OSError as error:
        raise LookupError("人脸裁切图不可读") from error
    content_type = mimetypes.guess_type(path.name)[0] or ""
    if content_type not in _IDENTITY_IMAGE_TYPES:
        raise LookupError("人脸裁切图格式不受支持")
    return path, content_type


def install_identity_api_runtime() -> None:
    """Expose device-local identity labels and visual evidence to the native Desktop App.

    The adapter never exposes embeddings and never promotes inferred role
    candidates to human-confirmed labels without an explicit POST from the App.
    Portrait requests are identity-addressed: the client cannot provide a local
    filesystem path, and the surface only serves the stored face crop, never the
    complete source camera frame.
    """

    global _INSTALLED
    if _INSTALLED:
        return

    install_identity_role_inference()

    from . import web_server

    original_capabilities = web_server.WorkspaceService.capabilities
    original_make_handler = web_server.make_handler

    def capabilities_with_identity(service: Any, agent: dict[str, Any]) -> dict[str, Any]:
        payload = original_capabilities(service, agent)
        payload["identity_library"] = {
            "read": True,
            "app_write": True,
            "agent_write": False,
            "device_local": True,
            "embeddings_exposed": False,
            "portrait_read": True,
            "portrait_uses_face_crop": True,
            "role_candidates_require_confirmation": True,
        }
        return payload

    def make_handler_with_identity(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _identity_portrait(self, project: Any, identity_id: str) -> None:
                try:
                    path, content_type = _portrait_asset(project, identity_id)
                except LookupError as error:
                    raise web_server.ApiError(web_server.HTTPStatus.NOT_FOUND, str(error)) from error
                try:
                    size = path.stat().st_size
                except OSError as error:
                    raise web_server.ApiError(web_server.HTTPStatus.NOT_FOUND, "人脸裁切图不可读") from error
                self.send_response(web_server.HTTPStatus.OK)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(size))
                self.send_header("Cache-Control", "private, max-age=60")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                try:
                    with path.open("rb") as handle:
                        while True:
                            chunk = handle.read(256 * 1024)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return

            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 7
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "identities"
                    and parts[6] == "portrait"
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    self._identity_portrait(project, parts[5])
                    return
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "identities"
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    query = urllib.parse.parse_qs(parsed.query)
                    kind = str((query.get("kind") or [""])[0] or "").strip()
                    try:
                        rows = _decorate_rows(project, _library(project).list(kind))
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                    self._send_json(
                        {
                            "contract": "identity_library.v1",
                            "project_id": str(project.project_id),
                            "kind": kind,
                            "identities": rows,
                            "semantics": {
                                "device_local": True,
                                "embeddings_exposed": False,
                                "suggestions_are_authority": False,
                                "human_confirmation_required": True,
                                "face_portrait_uses_face_crop": True,
                                "full_frame_portrait_fallback": False,
                            },
                        }
                    )
                    return
                return super()._app_get(parsed)

            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "identities"
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    body = web_server._body(self)
                    identity_id = str(body.get("identity_id", "") or "").strip()
                    if not identity_id:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "identity_id 不能为空")
                    try:
                        row = _library(project).update(
                            identity_id,
                            label=str(body.get("label", "") or ""),
                            role_name=str(body.get("role_name", "") or ""),
                        )
                    except KeyError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.NOT_FOUND, "identity 不存在") from error
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                    row = _decorate_rows(project, [row])[0]
                    self._send_json(
                        {
                            "contract": "identity_library.v1",
                            "project_id": str(project.project_id),
                            "identity": row,
                        }
                    )
                    return
                return super()._app_post(parsed)

        return Handler

    web_server.WorkspaceService.capabilities = capabilities_with_identity
    web_server.make_handler = make_handler_with_identity
    _INSTALLED = True


__all__ = ["install_identity_api_runtime"]
