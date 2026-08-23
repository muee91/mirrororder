from pathlib import Path


def test_team_web_writes_individual_opinions_with_stable_reviewer_identity() -> None:
    root = Path(__file__).resolve().parents[1]
    ui = (root / "web" / "editorial_ui.js").read_text(encoding="utf-8")
    html = (root / "web" / "index.html").read_text(encoding="utf-8")

    assert "mirrororder-reviewer-id" in ui
    assert "crypto.randomUUID()" in ui
    assert "reviewer_id: stableReviewerId()" in ui
    assert "projectApi('/opinions')" in ui
    assert "target_kind: targetKind" in ui
    assert "setDecision = async function editorialSetDecision" in ui
    assert "setGroupDecision = async function editorialSetGroupDecision" in ui
    assert "projectApi('/review')" not in ui
    assert "我的最佳" in ui
    assert "我的保留" in ui
    assert "我的隐藏" in ui
    assert "团队意见" in ui
    assert html.index('<script src="/production_mode.js"></script>') < html.index(
        '<script src="/editorial_ui.js"></script>'
    )


def test_native_app_gets_final_decision_without_changing_delivery_semantics() -> None:
    root = Path(__file__).resolve().parents[1]
    ui = (root / "web" / "editorial_ui.js").read_text(encoding="utf-8")
    runtime = (root / "src" / "script_organizer" / "editorial_runtime.py").read_text(encoding="utf-8")

    assert "window.webkit?.messageHandlers?.mirrorOrder" in ui
    assert "projectApi('/editorial')" in ui
    assert "projectApi('/editorial-decision')" in ui
    assert "expected_revision: Number(nativeEditorial.revision || 0)" in ui
    assert "最终编辑决定" in ui
    assert "不会改变 FCPXML 或导出结果" in ui
    assert 'parts[4] == "editorial-decision"' in runtime
    assert "self._local_only()" in runtime


def test_web_personal_state_is_not_legacy_review_state() -> None:
    root = Path(__file__).resolve().parents[1]
    ui = (root / "web" / "editorial_ui.js").read_text(encoding="utf-8")

    assert "assignmentState = function editorialAssignmentState" in ui
    assert "return opinion?.state || 'unreviewed';" in ui
    assert "尚未提交我的意见" in ui
    assert "只看我未判断" in ui
    assert "我的意见" in ui
