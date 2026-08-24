from __future__ import annotations

from pathlib import Path
from typing import Any

from .editorial_store import EditorialConflictError, EditorialStore

_INSTALLED = False


def _counts(payload: dict[str, Any]) -> dict[str, int]:
    opinion_rows = payload.get("opinions", {}) if isinstance(payload.get("opinions", {}), dict) else {}
    decisions = payload.get("decisions", {}) if isinstance(payload.get("decisions", {}), dict) else {}
    opinions = 0
    reviewers: set[str] = set()
    for row in opinion_rows.values():
        if not isinstance(row, dict):
            continue
        reviewer_rows = row.get("reviewers", {}) if isinstance(row.get("reviewers", {}), dict) else {}
        opinions += len(reviewer_rows)
        for reviewer_key, opinion in reviewer_rows.items():
            if isinstance(opinion, dict):
                reviewers.add(str(opinion.get("reviewer_id", "") or reviewer_key))
    return {
        "opinions": opinions,
        "reviewers": len(reviewers),
        "decisions": len(decisions),
    }


def _store_for_project(project: Any) -> EditorialStore:
    return EditorialStore(project.config.output_dir)


def install_editorial_runtime() -> None:
    """Layer revision-safe collaboration onto review.v1 and Host routes.

    Legacy review.json remains untouched. Team Web may submit reviewer opinions;
    final Editorial Decision writes are Host-local until a role/permission model
    exists. The review.v1 projection is enriched at read time only.
    """

    global _INSTALLED
    if _INSTALLED:
        return

    from . import review_read_model, web_server

    original_build = review_read_model.build_review_read_model
    original_state = web_server.ProjectService.state
    original_make_handler = web_server.make_handler

    def build_with_editorial(project: Any, **kwargs: Any) -> dict[str, Any]:
        payload = original_build(project, **kwargs)
        store = _store_for_project(project)
        editorial = store.load()
        counts = _counts(editorial)
        for take in payload.get("take_groups", []):
            if not isinstance(take, dict):
                continue
            group_id = str(take.get("group_id", "") or "")
            collaboration = store.for_group(group_id)
            state = take.get("editorial_state", {})
            if not isinstance(state, dict):
                state = {}
            state["individual_opinions"] = collaboration["opinions"]
            state["editorial_decision"] = collaboration["decision"]
            state.pop("individual_opinion", None)
            take["editorial_state"] = state
        payload.setdefault("revisions", {})["editorial"] = int(editorial.get("revision", 0) or 0)
        payload.setdefault("capabilities", {}).update(
            {
                "individual_opinions": True,
                "editorial_decision": True,
                "editorial_decision_write_scope": "host_local",
            }
        )
        payload.setdefault("summary", {})["collaboration"] = counts
        payload.setdefault("review_state", {})["editorial"] = {
            "version": int(editorial.get("version", 2) or 2),
            "revision": int(editorial.get("revision", 0) or 0),
            "updated_at": str(editorial.get("updated_at", "") or ""),
            "opinions": editorial.get("opinions", {}) if isinstance(editorial.get("opinions", {}), dict) else {},
            "decisions": editorial.get("decisions", {}) if isinstance(editorial.get("decisions", {}), dict) else {},
        }
        payload["review_state"].pop("individual_opinions", None)
        payload["review_state"].pop("editorial_decisions", None)
        return payload

    def state_with_editorial(project: Any) -> dict[str, Any]:
        payload = original_state(project)
        editorial = _store_for_project(project).load()
        payload["editorial_revision"] = int(editorial.get("revision", 0) or 0)
        payload["editorial_updated_at"] = str(editorial.get("updated_at", "") or "")
        return payload

    def make_handler_with_editorial(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "editorial"
                ):
                    project = service.project(parts[3])
                    self._send_json(_store_for_project(project).load())
                    return
                return super()._app_get(parsed)

            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if len(parts) == 5 and parts[:3] == ["api", "v1", "projects"]:
                    project = service.project(parts[3])
                    store = _store_for_project(project)
                    if parts[4] == "opinions":
                        payload = web_server._body(self)
                        saved = store.apply_opinion(payload)
                        self._send_json(
                            {
                                "editorial": saved,
                                "group": store.for_group(str(payload.get("group_id", "") or "")),
                            }
                        )
                        return
                    if parts[4] == "editorial-decision":
                        self._local_only()
                        payload = web_server._body(self)
                        try:
                            saved = store.apply_decision(payload)
                        except EditorialConflictError as error:
                            raise web_server.ApiError(web_server.HTTPStatus.CONFLICT, str(error)) from error
                        self._send_json(
                            {
                                "editorial": saved,
                                "group": store.for_group(str(payload.get("group_id", "") or "")),
                            }
                        )
                        return
                return super()._app_post(parsed)

        return Handler

    review_read_model.build_review_read_model = build_with_editorial
    web_server.ProjectService.state = state_with_editorial
    web_server.make_handler = make_handler_with_editorial
    _INSTALLED = True

    # Runtime order is deliberate. Audit adds rebuildable evidence. Script
    # Supervisor, Identity and Media Roles add human/device-local production
    # facts without gaining editorial authority. Waveform is also rebuildable
    # device-local media evidence for Desktop editing and never gains review or
    # editorial authority. Media Roles must install before Coverage/Rough Cut
    # modules are imported so their module-level projection bindings include
    # camera overrides and auxiliary media. Rough Placement adds a Host-local
    # human coarse-placement surface; it writes only episode-level review
    # authority after explicit confirmation. Assembly remains preview-only.
    # Assistant sits on top without gaining review, Editorial Decision, Delivery
    # or FCPXML write authority. Semantic Retrieval installs last because it wraps
    # the finished assistant and task runtime with read-only retrieval grounding.
    from .audit_runtime import install_audit_runtime
    from .script_supervisor_runtime import install_script_supervisor_runtime
    from .identity_api_runtime import install_identity_api_runtime
    from .media_role_runtime import install_media_role_runtime
    from .waveform_runtime import install_waveform_runtime
    from .rough_placement_runtime import install_rough_placement_runtime

    install_audit_runtime()
    install_script_supervisor_runtime()
    install_identity_api_runtime()
    install_media_role_runtime()
    install_waveform_runtime()
    install_rough_placement_runtime()

    from .coverage_runtime import install_coverage_runtime
    from .rough_cut_runtime import install_rough_cut_runtime
    from .assembly_runtime import install_assembly_runtime
    from .assistant_runtime import install_assistant_runtime
    from .semantic_runtime import install_semantic_runtime

    install_coverage_runtime()
    install_rough_cut_runtime()
    install_assembly_runtime()
    install_assistant_runtime()
    install_semantic_runtime()
