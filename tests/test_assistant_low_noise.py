from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_assistant_only_promotes_production_issue_codes() -> None:
    source = (ROOT / "web" / "assistant_ui.js").read_text(encoding="utf-8")
    for code in (
        "technical_quality",
        "continuity_risk",
        "possible_pickup",
        "multicam_speaker_visual_mismatch",
    ):
        assert code in source
    assert "PRODUCTION_ISSUE_CODES" in source
    assert "item?.source === 'ai_audit'" not in source
    assert "mapping_conflict" in source
    assert "audit-disagree" in source
    assert "priority: 68" in source
