from pathlib import Path


def test_mapping_stale_audit_is_not_exposed_as_current_assistant_judgment() -> None:
    root = Path(__file__).resolve().parents[1]
    tools = (root / "src" / "script_organizer" / "agent_tools.py").read_text(encoding="utf-8")
    runtime = (root / "src" / "script_organizer" / "audit_runtime.py").read_text(encoding="utf-8")
    orchestrator = (root / "src" / "script_organizer" / "assistant_orchestrator.py").read_text(encoding="utf-8")

    assert "def _audit_freshness" in tools
    assert "if mapping_current:" in tools
    assert "judge = {}" in tools
    assert "role_suggestions = []" in tools
    assert '"audit_mapping_stale": bool(visual_current and not mapping_current)' in tools
    assert '"shot_intelligence": _as_dict(audit_row.get("shot_intelligence")) if visual_current else {}' in tools

    assert '"mapping_stale": True' in runtime
    assert '"visual_current": True' in runtime
    assert "_apply_shot_intelligence(take, row)" in runtime
    assert "Judge, mapping issues, role suggestions and rough-cut guidance" in runtime

    assert "_mapping_for_group" in orchestrator
    assert "if _as_dict(row.get(\"mapping\")) != current_mapping:" in orchestrator
    assert "if allow_actions and plan is None" in orchestrator
