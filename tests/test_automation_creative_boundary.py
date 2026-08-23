from pathlib import Path


def test_automation_never_supplies_best_keep_reject_state() -> None:
    root = Path(__file__).resolve().parents[1]
    automation = (root / "web" / "automation.js").read_text(encoding="utf-8")
    editorial = (root / "web" / "editorial_ui.js").read_text(encoding="utf-8")

    assert "automationFor(group)?.editorial_state" not in automation
    assert "does not override assignmentState" in automation
    assert "can never manufacture Best / Keep / Reject" in automation
    assert "assignmentState = function editorialAssignmentState" in editorial
    assert "return opinion?.state || 'unreviewed';" in editorial
