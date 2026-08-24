from __future__ import annotations

from typing import Any

from .audit_store import AuditStore

_INSTALLED = False


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _safe_shot(value: object) -> dict[str, str]:
    shot = _as_dict(value)
    result: dict[str, str] = {}
    shot_type = str(shot.get("shot_type", "") or "").strip()
    coverage_role = str(shot.get("coverage_role", "") or "").strip()
    if shot_type and shot_type != "unknown":
        result["shot_type"] = shot_type[:40]
    if coverage_role and coverage_role != "unknown":
        result["coverage_role"] = coverage_role[:40]
    return result


def enrich_review_model_with_shot_intelligence(
    payload: dict[str, Any],
    audit: dict[str, Any],
) -> dict[str, Any]:
    """Project current audit shot evidence into review.v1 angle rows.

    audit.json remains rebuildable evidence, not review authority.  Stale audit
    revisions are deliberately ignored so old shot labels cannot leak into a
    newly analyzed project.  Values are joined strictly by clip_id; no Take-level
    fallback is allowed because A/B/C may have different shot sizes.
    """

    revisions = _as_dict(payload.get("revisions"))
    analysis_revision = str(revisions.get("analysis", "") or "")
    audit_revision = str(audit.get("analysis_revision", "") or "")
    revisions["audit_analysis"] = audit_revision
    payload["revisions"] = revisions

    capabilities = _as_dict(payload.get("capabilities"))
    capabilities["clip_shot_intelligence"] = False
    payload["capabilities"] = capabilities

    if not analysis_revision or audit_revision != analysis_revision:
        return payload

    audit_groups = _as_dict(audit.get("groups"))
    projected = 0
    for take in _as_list(payload.get("take_groups")):
        if not isinstance(take, dict):
            continue
        group_id = str(take.get("group_id", "") or "")
        audit_group = _as_dict(audit_groups.get(group_id))
        shot_angles = _as_dict(_as_dict(audit_group.get("shot_intelligence")).get("angles"))
        if not shot_angles:
            continue
        for angle in _as_list(take.get("angles")):
            if not isinstance(angle, dict):
                continue
            clip_id = str(angle.get("clip_id", "") or "")
            shot = _safe_shot(shot_angles.get(clip_id))
            if not shot:
                continue
            angle.update(shot)
            projected += 1

    capabilities["clip_shot_intelligence"] = projected > 0
    summary = _as_dict(payload.get("summary"))
    summary["shot_angles"] = projected
    payload["summary"] = summary
    return payload


def install_review_shot_intelligence_runtime() -> None:
    """Decorate review.v1 after its read-model runtime has been installed."""

    global _INSTALLED
    if _INSTALLED:
        return

    from . import review_read_model

    original = review_read_model.build_review_read_model

    def build_with_shot_intelligence(project: Any, **kwargs: Any) -> dict[str, Any]:
        payload = original(project, **kwargs)
        audit = AuditStore(project.config.output_dir).load()
        return enrich_review_model_with_shot_intelligence(payload, audit)

    review_read_model.build_review_read_model = build_with_shot_intelligence
    _INSTALLED = True
