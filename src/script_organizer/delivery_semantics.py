from __future__ import annotations

from typing import Any

from .review_store import effective_group_state

DELIVERY_STATES = {"best", "keep", "reject", "unreviewed"}


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _decision(editorial: dict[str, Any], key: str) -> dict[str, Any] | None:
    value = _as_dict(_as_dict(editorial.get("decisions")).get(key))
    state = str(value.get("state", "") or "")
    if state not in {"best", "keep", "reject"}:
        return None
    return {
        "state": state,
        "actor": str(value.get("actor", "") or ""),
        "updated_at": str(value.get("updated_at", "") or ""),
    }


def editorial_decision_for(
    editorial: dict[str, Any],
    *,
    segment_id: str,
    group_id: str,
) -> tuple[dict[str, Any] | None, str]:
    """Return the explicit final decision for this delivery target.

    Assignment decisions are more specific than group decisions. Editorial
    decisions deliberately do not inherit from parent groups after a split:
    a final decision is high-authority and must remain attached to the exact
    target a human confirmed.
    """

    if segment_id:
        assignment = _decision(editorial, f"assignment|{segment_id}|{group_id}")
        if assignment:
            return assignment, "editorial_assignment"
    group = _decision(editorial, f"group|{group_id}")
    if group:
        return group, "editorial_group"
    return None, ""


def legacy_review_state_for(
    review: dict[str, Any],
    *,
    segment_id: str,
    group: dict[str, Any],
) -> tuple[str, str]:
    """Resolve the existing review.json creative state without changing it."""

    group_id = str(group.get("group_id", "") or "")
    parent_group_id = str(group.get("parent_group_id", "") or "")
    member_ids = [
        str(member.get("clip_id", "") or "")
        for member in group.get("members", [])
        if isinstance(member, dict) and member.get("clip_id")
    ]

    assignments = _as_dict(review.get("assignments"))
    rows = _as_dict(assignments.get(segment_id))
    assignment = _as_dict(rows.get(group_id))
    inherited = False
    if not assignment and parent_group_id:
        assignment = _as_dict(rows.get(parent_group_id))
        inherited = bool(assignment)
    assignment_state = str(assignment.get("state", "") or "")
    if assignment_state in {"best", "keep", "reject"}:
        return assignment_state, "legacy_assignment_inherited" if inherited else "legacy_assignment"

    state = effective_group_state(review, group_id, member_ids, parent_group_id)
    if state in {"best", "keep", "reject"}:
        return state, "legacy_group_or_clip"
    return "unreviewed", ""


def resolve_delivery_state(
    *,
    review: dict[str, Any],
    editorial: dict[str, Any],
    segment_id: str,
    group: dict[str, Any],
    automatic_state: str,
) -> dict[str, Any]:
    """Resolve one manifest row without ever counting Individual Opinions.

    Precedence:
      1. explicit Editorial Decision for assignment;
      2. explicit Editorial Decision for group;
      3. existing legacy review.json human state;
      4. the historical automatic mapping fallback used by v2 manifests.

    Individual Opinion rows are intentionally absent from this function. They
    are collaboration evidence, not delivery authority.
    """

    group_id = str(group.get("group_id", "") or "")
    decision, source = editorial_decision_for(
        editorial,
        segment_id=segment_id,
        group_id=group_id,
    )
    if decision:
        return {
            "state": decision["state"],
            "decision_source": source,
            "decision_actor": decision.get("actor", ""),
            "decision_updated_at": decision.get("updated_at", ""),
            "legacy_state": "",
            "automatic_state": automatic_state,
        }

    legacy_state, legacy_source = legacy_review_state_for(
        review,
        segment_id=segment_id,
        group=group,
    )
    if legacy_state != "unreviewed":
        return {
            "state": legacy_state,
            "decision_source": legacy_source,
            "decision_actor": "",
            "decision_updated_at": "",
            "legacy_state": legacy_state,
            "automatic_state": automatic_state,
        }

    fallback = automatic_state if automatic_state in DELIVERY_STATES else "unreviewed"
    return {
        "state": fallback,
        "decision_source": "automatic_mapping_fallback" if fallback != "unreviewed" else "unreviewed",
        "decision_actor": "",
        "decision_updated_at": "",
        "legacy_state": "unreviewed",
        "automatic_state": fallback,
    }
