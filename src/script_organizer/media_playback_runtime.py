from __future__ import annotations

from functools import lru_cache
import mimetypes
import re
from urllib.parse import parse_qs, urlsplit
from http import HTTPStatus
from pathlib import Path
from typing import Any


_INSTALLED = False


def _parse_http_byte_range(header: str, size: int) -> tuple[int, int] | None:
    """Parse a single HTTP bytes range used by WebKit media playback.

    MirrorOrder serves one local file per request and does not emit multipart
    byte ranges. Browsers normally use single ranges for media probing/seeking.
    If a client asks for multiple ranges, ignore the Range header and let the
    handler return the full representation instead of pretending the first
    range satisfies a multipart request.
    """

    if not header.startswith("bytes="):
        return None
    value = header.removeprefix("bytes=").strip()
    if "," in value:
        return None
    if size <= 0:
        raise ValueError("range invalid")

    left, separator, right = value.partition("-")
    left = left.strip()
    right = right.strip()
    if separator != "-" or (not left and not right):
        raise ValueError("range invalid")

    if left:
        if not left.isdigit() or (right and not right.isdigit()):
            raise ValueError("range invalid")
        start = int(left)
        if start >= size:
            raise ValueError("range invalid")
        end = size - 1 if not right else min(int(right), size - 1)
        if end < start:
            raise ValueError("range invalid")
        return start, end

    if not right.isdigit():
        raise ValueError("range invalid")
    suffix_length = int(right)
    if suffix_length <= 0:
        raise ValueError("range invalid")
    suffix_length = min(suffix_length, size)
    return size - suffix_length, size - 1


@lru_cache(maxsize=128)
def _sample_registered(path, identity_stat):
    from .source_descriptor_receipt import _sampled_id
    return _sampled_id(Path(path))


def _registered_preview_path(project, media_id):
    from .source_descriptor_receipt import _stat
    from .media_identity import DeviceMediaStore
    from .paper_filename_context import _bindings
    attrs=(getattr(project,'workspace_id',''),project.project_id)
    if not attrs[0]:return None
    store=DeviceMediaStore(create=False)
    current=lambda:_bindings(store,*attrs).get(media_id)
    bound=current()
    if not isinstance(bound,str) or not Path(bound).is_absolute():return None
    try:
        path=Path(bound).resolve(strict=True);before=_stat(path)
        if (not path.is_file() or _sample_registered(str(path),tuple(before))!=media_id or
            _stat(path)!=before or current()!=bound or Path(bound).resolve(strict=True)!=path):return None
        return path
    except OSError:return None


def install_media_playback_runtime() -> None:
    """Harden production Host media responses for native WebKit playback."""

    global _INSTALLED
    if _INSTALLED:
        return

    from . import web_server

    original_make_handler = web_server.make_handler

    def make_handler_with_media_playback(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _media(self, project: Any, clip_id: str, head_only: bool = False) -> None:
                clip = project.clips.get(clip_id)
                if not clip:
                    raise web_server.ApiError(HTTPStatus.NOT_FOUND, "unknown clip")
                # A slate inspector knows the exact pair, while legacy players
                # request only clip_id. Check the optional pair before resolving
                # bytes on every HEAD/range request; don't let a changed index
                # silently show a different original in review.
                query = parse_qs(urlsplit(self.path).query, keep_blank_values=True)
                if "expected_media_id" in query:
                    identities = query["expected_media_id"]
                    if len(identities) != 1 or not re.fullmatch(r"M_[0-9a-f]{24}", identities[0]):
                        raise web_server.ApiError(HTTPStatus.BAD_REQUEST, "invalid expected media identity")
                    if clip.get("media_id") != identities[0]:
                        raise web_server.ApiError(HTTPStatus.CONFLICT, "clip media identity changed")
                if "slate_registered_source" in query:
                    if query["slate_registered_source"]!=["1"] or "expected_media_id" not in query:
                        raise web_server.ApiError(HTTPStatus.BAD_REQUEST,"invalid slate preview identity")
                    path=_registered_preview_path(project,identities[0])
                    if path is None:
                        raise web_server.ApiError(HTTPStatus.NOT_FOUND,"registered source missing or changed")
                else:path = Path(project.resolve_media_path(clip))
                if not path.exists() or not path.is_file():
                    raise web_server.ApiError(HTTPStatus.NOT_FOUND, "media missing")

                size = path.stat().st_size
                range_header = self.headers.get("Range", "")
                try:
                    byte_range = _parse_http_byte_range(range_header, size)
                except ValueError:
                    # A media element expects a standards-shaped 416 rather
                    # than the JSON API error used by ordinary Host routes.
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "video/mp4")
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return

                if byte_range is None:
                    start = 0
                    end = size - 1
                    status = HTTPStatus.OK
                    length = size
                else:
                    start, end = byte_range
                    status = HTTPStatus.PARTIAL_CONTENT
                    length = end - start + 1

                self.send_response(status)
                self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "video/mp4")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Length", str(length))
                if status == HTTPStatus.PARTIAL_CONTENT:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.end_headers()
                if head_only or length <= 0:
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

        return Handler

    web_server.make_handler = make_handler_with_media_playback
    _INSTALLED = True


__all__ = ["install_media_playback_runtime"]
