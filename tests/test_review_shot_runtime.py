from __future__ import annotations

from script_organizer.review_shot_runtime import enrich_review_model_with_shot_intelligence


def _review_payload() -> dict:
    return {
        "contract_version": "review.v1",
        "revisions": {"analysis": "analysis-current", "review": 2},
        "capabilities": {},
        "summary": {"take_groups": 1},
        "take_groups": [
            {
                "group_id": "G_1",
                "angles": [
                    {"clip_id": "C_A", "camera": "A"},
                    {"clip_id": "C_B", "camera": "B"},
                    {"clip_id": "C_C", "camera": "C"},
                ],
            }
        ],
    }


def test_current_audit_projects_shot_intelligence_by_clip_id_only() -> None:
    payload = _review_payload()
    audit = {
        "analysis_revision": "analysis-current",
        "groups": {
            "G_1": {
                "shot_intelligence": {
                    "angles": {
                        "C_A": {"shot_type": "wide", "coverage_role": "master"},
                        "C_B": {"shot_type": "close_up", "coverage_role": "dialogue"},
                    }
                }
            }
        },
    }

    result = enrich_review_model_with_shot_intelligence(payload, audit)
    angles = result["take_groups"][0]["angles"]

    assert angles[0]["shot_type"] == "wide"
    assert angles[1]["shot_type"] == "close_up"
    assert "shot_type" not in angles[2]
    assert result["capabilities"]["clip_shot_intelligence"] is True
    assert result["summary"]["shot_angles"] == 2
    assert result["revisions"]["audit_analysis"] == "analysis-current"


def test_stale_audit_never_leaks_old_shot_labels_into_current_analysis() -> None:
    payload = _review_payload()
    audit = {
        "analysis_revision": "analysis-old",
        "groups": {
            "G_1": {
                "shot_intelligence": {
                    "angles": {"C_A": {"shot_type": "close_up"}}
                }
            }
        },
    }

    result = enrich_review_model_with_shot_intelligence(payload, audit)

    assert "shot_type" not in result["take_groups"][0]["angles"][0]
    assert result["capabilities"]["clip_shot_intelligence"] is False
    assert result["revisions"]["audit_analysis"] == "analysis-old"


def test_unknown_or_take_level_shot_values_are_not_promoted_to_angles() -> None:
    payload = _review_payload()
    audit = {
        "analysis_revision": "analysis-current",
        "groups": {
            "G_1": {
                "shot_type": "close_up",
                "shot_intelligence": {
                    "angles": {
                        "C_A": {"shot_type": "unknown", "coverage_role": "unknown"},
                    }
                },
            }
        },
    }

    result = enrich_review_model_with_shot_intelligence(payload, audit)

    assert all("shot_type" not in angle for angle in result["take_groups"][0]["angles"])
    assert result["capabilities"]["clip_shot_intelligence"] is False
    assert result["summary"]["shot_angles"] == 0
