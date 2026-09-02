from __future__ import annotations

import mimetypes
from http import HTTPStatus
from pathlib import Path
from typing import Any


_INSTALLED = False


def _parse_http_byte_range(header: str, size: int) -> tuple[int, int] | None:
    """Parse the first HTTP bytes range used by WebKit media playback.

    MirrorOrder serves one local file per request and does not emit multipart
    byte ranges. Browsers use single ranges for media probing/seeking, so keep
    the existing first-range behavior while implementing open-ended and suffix
    ranges according to HTTP semantics.
    """

    if not header.startswith("bytes="):
        return None
    if size <= 0:
        raise ValueError("range invalid")

    value = header.removeprefix("bytes=").split(",", 1)[0].strip()
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
                path = Path(project.resolve_media_path(clip))
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
