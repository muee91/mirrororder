from __future__ import annotations

from pathlib import Path
from typing import Any

from .media_identity import DeviceMediaStore, media_id_for_path
from .media_reader import infer_camera_label
from .media_role_projection import enrich_coverage_graph, enrich_rough_cut_plan, revision_with_media_roles
from .media_role_store import MEDIA_ROLE_CONTRACT, MediaRoleConflictError, MediaRoleStore
from .script_supervisor_projection import (
    enrich_coverage_with_standalone_slate,
    enrich_rough_cut_with_standalone_slate,
)

_INSTALLED = False


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _safe_role(value: object) -> dict[str, Any]:
    raw = _as_dict(value)
    if not raw:
        return {}
    return {
        "media_id": str(raw.get("media_id", "") or ""),
        "display_name": str(raw.get("display_name", "") or "")[:300],
        "camera_override": str(raw.get("camera_override", "") or "")[:40],
        "source_role": str(raw.get("source_role", "sync_camera") or "sync_camera"),
        "role_label": str(raw.get("role_label", "") or "")[:80],
        "sync_policy": str(raw.get("sync_policy", "auto") or "auto"),
        "scene_id": str(raw.get("scene_id", "") or "")[:160],
        "note": str(raw.get("note", "") or "")[:1200],
        "actor": str(raw.get("actor", "") or "")[:80],
        "updated_at": str(raw.get("updated_at", "") or "")[:80],
    }


def _safe_store(payload: dict[str, Any]) -> dict[str, Any]:
    rows = payload.get("media", {}) if isinstance(payload.get("media"), dict) else {}
    return {
        "version": int(payload.get("version", 1) or 1),
        "contract": str(payload.get("contract", MEDIA_ROLE_CONTRACT) or MEDIA_ROLE_CONTRACT),
        "revision": int(payload.get("revision", 0) or 0),
        "updated_at": str(payload.get("updated_at", "") or ""),
        "media": {str(media_id): _safe_role(row) for media_id, row in rows.items() if isinstance(row, dict)},
    }


def _indexed_media(project: Any) -> set[str]:
    result: set[str] = set()
    for clip in project.index.get("clips", []):
        if isinstance(clip, dict) and clip.get("media_id"):
            result.add(str(clip["media_id"]))
    for group in project.index.get("groups", []):
        if not isinstance(group, dict):
            continue
        for member in group.get("members", []):
            if isinstance(member, dict) and member.get("media_id"):
                result.add(str(member["media_id"]))
    return result


def _inventory(project: Any, device: DeviceMediaStore, roles: MediaRoleStore) -> dict[str, Any]:
    workspace_id = str(getattr(project, "workspace_id", "") or "")
    snapshot = device.project_snapshot(workspace_id, project.project_id)
    roots = [str(value) for value in snapshot.get("roots", []) if str(value)]
    files = device._media_files(roots)
    indexed = _indexed_media(project)
    saved = roles.load()
    labels = saved.get("media", {}) if isinstance(saved.get("media"), dict) else {}
    rows: list[dict[str, Any]] = []
    for path in files[:12000]:
        media_id = media_id_for_path(path)
        if not media_id:
            continue
        rows.append(
            {
                "media_id": media_id,
                "display_name": path.name[:300],
                "folder_label": path.parent.name[:120],
                "inferred_camera": infer_camera_label(path, project.config.camera_patterns),
                "indexed": media_id in indexed,
                "label": _safe_role(labels.get(media_id)),
            }
        )
    rows.sort(key=lambda row: (0 if row["label"] else 1, 0 if not row["indexed"] else 1, row["display_name"].casefold(), row["media_id"]))
    return {
        "contract": "media_inventory.v1",
        "project_id": str(project.project_id),
        "role_revision": int(saved.get("revision", 0) or 0),
        "summary": {
            "files": len(rows),
            "indexed": sum(1 for row in rows if row["indexed"]),
            "unindexed": sum(1 for row in rows if not row["indexed"]),
            "labeled": sum(1 for row in rows if row["label"]),
            "auxiliary": sum(1 for row in rows if _as_dict(row.get("label")).get("source_role") not in {None, "", "sync_camera"} or _as_dict(row.get("label")).get("sync_policy") == "exclude"),
        },
        "items": rows,
        "semantics": {
            "paths_exposed": False,
            "device_local_scan": True,
            "media_id_shared_identity": True,
            "unindexed_media_may_be_labeled": True,
            "camera_override_is_shared_human_fact": True,
            "auxiliary_without_timecode_or_audio_is_valid": True,
        },
    }


def install_media_role_runtime() -> None:
    """Install shared media roles plus App-local media inventory and projections."""
    global _INSTALLED
    if _INSTALLED:
        return
    from . import review_read_model, web_server

    original_build = review_read_model.build_review_read_model
    original_state = web_server.ProjectService.state
    original_capabilities = web_server.WorkspaceService.capabilities
    original_make_handler = web_server.make_handler
    device = DeviceMediaStore()

    def build_with_media_roles(project: Any, **kwargs: Any) -> dict[str, Any]:
        payload = original_build(project, **kwargs)
        store = MediaRoleStore(project.config.output_dir)
        roles = store.load()
        rows = roles.get("media", {}) if isinstance(roles.get("media"), dict) else {}
        for take in payload.get("take_groups", []):
            if not isinstance(take, dict):
                continue
            for angle in take.get("angles", []):
                if not isinstance(angle, dict):
                    continue
                media_id = str(angle.get("media_id", "") or "")
                role = _safe_role(rows.get(media_id))
                angle["media_role"] = role
                override = str(role.get("camera_override", "") or "")
                if override:
                    angle["detected_camera"] = str(angle.get("camera", "") or "")
                    angle["camera"] = override
        payload.setdefault("revisions", {})["media_roles"] = int(roles.get("revision", 0) or 0)
        payload.setdefault("summary", {})["media_roles"] = {"labeled": len(rows), "auxiliary": len(store.auxiliary())}
        payload.setdefault("capabilities", {}).update({"media_roles_v1": True, "media_role_write_scope": "host_local", "media_role_is_editorial_authority": False})
        return payload

    def state_with_media_roles(project: Any) -> dict[str, Any]:
        payload = original_state(project)
        roles = MediaRoleStore(project.config.output_dir).load()
        payload["media_role_revision"] = int(roles.get("revision", 0) or 0)
        payload["media_role_updated_at"] = str(roles.get("updated_at", "") or "")
        return payload

    def capabilities_with_media_roles(service: Any, agent: dict[str, Any]) -> dict[str, Any]:
        payload = original_capabilities(service, agent)
        payload["media_roles"] = {"contract": MEDIA_ROLE_CONTRACT, "read": True, "agent_write": False, "app_write": True, "auxiliary_inventory": True, "editorial_authority": False}
        return payload

    def make_handler_with_media_roles(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if len(parts) == 5 and parts[:3] == ["api", "v1", "projects"]:
                    project = service.project(parts[3])
                    if parts[4] == "media-roles":
                        self._local_only(); self._send_json(_safe_store(MediaRoleStore(project.config.output_dir).load())); return
                    if parts[4] == "media-inventory":
                        self._local_only(); self._send_json(_inventory(project, device, MediaRoleStore(project.config.output_dir))); return
                return super()._app_get(parsed)

            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if len(parts) == 5 and parts[:3] == ["api", "v1", "projects"] and parts[4] == "media-roles":
                    self._local_only()
                    project = service.project(parts[3]); store = MediaRoleStore(project.config.output_dir); body = web_server._body(self)
                    try:
                        saved = store.apply_many(body)
                    except MediaRoleConflictError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.CONFLICT, str(error)) from error
                    except ValueError as error:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, str(error)) from error
                    self._send_json(_safe_store(saved)); return
                return super()._app_post(parsed)

            def _agent_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if len(parts) == 6 and parts[:4] == ["api", "agent", "v1", "projects"] and parts[5] == "media-roles":
                    project_id = parts[4]; agent = self._agent("read", project_id); project = service.project(project_id)
                    service.tokens.audit(agent, "read:media-roles", project_id)
                    self._send_json(_safe_store(MediaRoleStore(project.config.output_dir).load())); return
                return super()._agent_get(parsed)
        return Handler

    # Coverage is patched before its runtime imports. The order is deliberate:
    # base deterministic coverage -> media role auxiliary -> standalone slate.
    from . import coverage_graph
    original_coverage_build = coverage_graph.build_coverage_graph
    original_coverage_revision = coverage_graph.coverage_revision

    def coverage_with_production_evidence(project: Any, **kwargs: Any) -> dict[str, Any]:
        payload = enrich_coverage_graph(project, original_coverage_build(project, **kwargs))
        return enrich_coverage_with_standalone_slate(project, payload)

    def coverage_revision_with_media_roles(project: Any) -> str:
        base = original_coverage_revision(project)
        role_revision = int(MediaRoleStore(project.config.output_dir).load().get("revision", 0) or 0)
        return revision_with_media_roles(base, role_revision)

    coverage_graph.build_coverage_graph = coverage_with_production_evidence
    coverage_graph.coverage_revision = coverage_revision_with_media_roles

    # Rough Cut binds the already-patched Coverage builder, then receives both
    # auxiliary projections as optional coverage. Neither may become Primary.
    from . import rough_cut_plan
    original_rough_cut_build = rough_cut_plan.build_rough_cut_plan

    def rough_cut_with_production_evidence(project: Any, **kwargs: Any) -> dict[str, Any]:
        payload = enrich_rough_cut_plan(project, original_rough_cut_build(project, **kwargs))
        return enrich_rough_cut_with_standalone_slate(project, payload)

    rough_cut_plan.build_rough_cut_plan = rough_cut_with_production_evidence

    review_read_model.build_review_read_model = build_with_media_roles
    web_server.ProjectService.state = state_with_media_roles
    web_server.WorkspaceService.capabilities = capabilities_with_media_roles
    web_server.make_handler = make_handler_with_media_roles
    _INSTALLED = True
