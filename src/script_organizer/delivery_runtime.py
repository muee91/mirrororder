from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .fcpxml_exporter import UnsafeFCPXMLExport, export

_INSTALLED = False


def _decorate_report(report: object) -> dict[str, Any]:
    payload = dict(report) if isinstance(report, dict) else {}
    fcpxml = Path(str(payload.get("organized_fcpxml", "") or ""))
    manifest = Path(str(payload.get("selection_manifest", "") or ""))
    payload["organized_fcpxml_exists"] = bool(str(fcpxml)) and fcpxml.is_file()
    payload["selection_manifest_exists"] = bool(str(manifest)) and manifest.is_file()
    payload["device_paths_exposed"] = True
    return payload


def _existing_report(project: Any) -> dict[str, Any]:
    path = Path(project.config.output_dir) / "export_report.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return _decorate_report(payload)
    except (OSError, ValueError):
        return {}


def install_delivery_runtime() -> None:
    """Expose the existing Python delivery exporter to the local Desktop app.

    This adapter does not move FCPXML semantics into Tauri. It simply gives an
    explicit local human action access to the same exporter already used by the
    CLI, after which platform-specific open/reveal remains a Tauri concern.
    """
    global _INSTALLED
    if _INSTALLED:
        return
    from . import web_server

    original_make_handler = web_server.make_handler

    def make_handler_with_delivery(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "delivery-export"
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    self._send_json({
                        "contract": "delivery_export.v1",
                        "report": _existing_report(project),
                    })
                    return
                return super()._app_get(parsed)

            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "delivery-export"
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    try:
                        report = export(project.config, preserve_source=True)
                    except UnsafeFCPXMLExport as error:
                        raise web_server.ApiError(web_server.HTTPStatus.CONFLICT, str(error)) from error
                    self._send_json({
                        "contract": "delivery_export.v1",
                        "report": _decorate_report(report),
                    })
                    return
                return super()._app_post(parsed)

        return Handler

    web_server.make_handler = make_handler_with_delivery
    _INSTALLED = True
