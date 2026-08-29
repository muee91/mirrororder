from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .fcpxml_exporter import UnsafeFCPXMLExport, export

_INSTALLED = False
_ALLOWED_ARTIFACTS = {
    "organized_fcpxml": "organized.fcpxml",
    "selection_manifest": "selection_manifest.json",
}


def _artifact_path(project: Any, key: str, value: object) -> Path | None:
    """Resolve a first-party logical artifact ref at the Host-local boundary."""
    expected = _ALLOWED_ARTIFACTS[key]
    ref = str(value or "").strip().replace("\\", "/")
    if ref != expected:
        return None
    return Path(project.config.output_dir) / expected


def _decorate_report(project: Any, report: object) -> dict[str, Any]:
    """Add Host-local paths for native reveal/open without persisting them.

    ``export_report.json`` remains path-free. Absolute paths are reconstructed
    only for this localhost-only API response because Desktop platform commands
    need a concrete file to reveal/open on the current device.
    """
    payload = dict(report) if isinstance(report, dict) else {}
    persisted_path_safe = not bool(payload.get("device_paths_exposed", False))
    for key in ("organized_fcpxml", "selection_manifest"):
        artifact = _artifact_path(project, key, payload.get(key))
        payload[f"{key}_exists"] = bool(artifact and artifact.is_file())
        payload[f"{key}_ref"] = str(payload.get(key, "") or "")
        payload[key] = str(artifact) if artifact is not None else ""
    payload["persisted_report_path_safe"] = persisted_path_safe
    payload["device_paths_exposed"] = True
    payload["device_paths_scope"] = "localhost_response_only"
    return payload


def _existing_report(project: Any) -> dict[str, Any]:
    path = Path(project.config.output_dir) / "export_report.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return _decorate_report(project, payload)
    except (OSError, ValueError):
        return {}


def install_delivery_runtime() -> None:
    """Expose the existing Python delivery exporter to the local Desktop app.

    This adapter does not move FCPXML semantics into Tauri. It simply gives an
    explicit local human action access to the same exporter already used by the
    CLI. Persisted delivery artifacts are path-free; concrete paths are resolved
    only in this localhost-only adapter for platform reveal/open actions.
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
                        "report": _decorate_report(project, report),
                    })
                    return
                return super()._app_post(parsed)

        return Handler

    web_server.make_handler = make_handler_with_delivery
    _INSTALLED = True
