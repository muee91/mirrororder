from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .fcpxml_exporter import UnsafeFCPXMLExport, export
from .nle_delivery import (
    PREMIERE_REPORT_NAME,
    PREMIERE_XMEML_NAME,
    TIMELINE_FCPXML_NAME,
    TIMELINE_REPORT_NAME,
    UnsafeTimelineDelivery,
    export_timeline_delivery,
    export_timeline_premiere_delivery,
)

_INSTALLED = False
_ALLOWED_ARTIFACTS = {
    "organized_fcpxml": "organized.fcpxml",
    "selection_manifest": "selection_manifest.json",
}
_TIMELINE_ALLOWED_ARTIFACTS = {
    "organized_fcpxml": TIMELINE_FCPXML_NAME,
}
_PREMIERE_ALLOWED_ARTIFACTS = {
    "premiere_xmeml": PREMIERE_XMEML_NAME,
}


def _artifact_path(project: Any, key: str, value: object) -> Path | None:
    """Resolve a first-party logical legacy delivery ref at the Host-local boundary."""
    expected = _ALLOWED_ARTIFACTS[key]
    ref = str(value or "").strip().replace("\\", "/")
    if ref != expected:
        return None
    return Path(project.config.output_dir) / expected


def _timeline_artifact_path(project: Any, key: str, value: object) -> Path | None:
    """Resolve a first-party logical Timeline delivery ref at the Host-local boundary."""
    expected = _TIMELINE_ALLOWED_ARTIFACTS[key]
    ref = str(value or "").strip().replace("\\", "/")
    if ref != expected:
        return None
    return Path(project.config.output_dir) / expected


def _premiere_artifact_path(project: Any, key: str, value: object) -> Path | None:
    """Resolve a first-party logical Premiere interchange ref at the Host-local boundary."""
    expected = _PREMIERE_ALLOWED_ARTIFACTS[key]
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


def _decorate_timeline_report(project: Any, report: object) -> dict[str, Any]:
    """Decorate only the logical Timeline FCPXML artifact for localhost Desktop."""
    payload = dict(report) if isinstance(report, dict) else {}
    persisted_path_safe = not bool(payload.get("device_paths_exposed", False))
    artifact = _timeline_artifact_path(project, "organized_fcpxml", payload.get("organized_fcpxml"))
    payload["organized_fcpxml_exists"] = bool(artifact and artifact.is_file())
    payload["organized_fcpxml_ref"] = str(payload.get("organized_fcpxml", "") or "")
    payload["organized_fcpxml"] = str(artifact) if artifact is not None else ""
    payload["persisted_report_path_safe"] = persisted_path_safe
    payload["device_paths_exposed"] = True
    payload["device_paths_scope"] = "localhost_response_only"
    return payload


def _decorate_premiere_report(project: Any, report: object) -> dict[str, Any]:
    """Decorate only the logical Premiere XMEML artifact for localhost Desktop."""
    payload = dict(report) if isinstance(report, dict) else {}
    persisted_path_safe = not bool(payload.get("persisted_report_contains_device_paths", False))
    artifact = _premiere_artifact_path(project, "premiere_xmeml", payload.get("premiere_xmeml"))
    payload["premiere_xmeml_exists"] = bool(artifact and artifact.is_file())
    payload["premiere_xmeml_ref"] = str(payload.get("premiere_xmeml", "") or "")
    payload["premiere_xmeml"] = str(artifact) if artifact is not None else ""
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


def _existing_timeline_report(project: Any) -> dict[str, Any]:
    path = Path(project.config.output_dir) / TIMELINE_REPORT_NAME
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return _decorate_timeline_report(project, payload)
    except (OSError, ValueError):
        return {}


def _existing_premiere_report(project: Any) -> dict[str, Any]:
    path = Path(project.config.output_dir) / PREMIERE_REPORT_NAME
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return _decorate_premiere_report(project, payload)
    except (OSError, ValueError):
        return {}


def install_delivery_runtime() -> None:
    """Expose first-party delivery exporters to the local Desktop app.

    The historical ``delivery-export`` endpoint remains the Review/Editorial
    keyword export. Timeline Final Cut and Premiere endpoints both accept the
    same immutable Rust Timeline snapshot and consume the shared NLE-neutral IR;
    neither adapter may reinterpret Editorial decisions. Persisted reports stay
    path-free; concrete output paths are reconstructed only in this localhost
    adapter.
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
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "timeline-delivery-export"
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    self._send_json({
                        "contract": "timeline_delivery_export.v1",
                        "report": _existing_timeline_report(project),
                    })
                    return
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "timeline-premiere-export"
                ):
                    self._local_only()
                    project = service.project(parts[3])
                    self._send_json({
                        "contract": "premiere_timeline_delivery_export.v1",
                        "report": _existing_premiere_report(project),
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
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "timeline-delivery-export"
                ):
                    self._local_only()
                    project_id = parts[3]
                    project = service.project(project_id)
                    payload = web_server._body(self)
                    try:
                        report = export_timeline_delivery(
                            project.config,
                            payload,
                            expected_project_id=project_id,
                        )
                    except UnsafeTimelineDelivery as error:
                        raise web_server.ApiError(web_server.HTTPStatus.CONFLICT, str(error)) from error
                    self._send_json({
                        "contract": "timeline_delivery_export.v1",
                        "report": _decorate_timeline_report(project, report),
                    })
                    return
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "timeline-premiere-export"
                ):
                    self._local_only()
                    project_id = parts[3]
                    project = service.project(project_id)
                    payload = web_server._body(self)
                    try:
                        report = export_timeline_premiere_delivery(
                            project.config,
                            payload,
                            expected_project_id=project_id,
                        )
                    except UnsafeTimelineDelivery as error:
                        raise web_server.ApiError(web_server.HTTPStatus.CONFLICT, str(error)) from error
                    self._send_json({
                        "contract": "premiere_timeline_delivery_export.v1",
                        "report": _decorate_premiere_report(project, report),
                    })
                    return
                return super()._app_post(parsed)

        return Handler

    web_server.make_handler = make_handler_with_delivery
    _INSTALLED = True
