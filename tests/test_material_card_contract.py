from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_team_web_loads_shared_material_card_contract() -> None:
    release = (ROOT / "web" / "startup_release.js").read_text(encoding="utf-8")
    css = (ROOT / "web" / "material_card.css").read_text(encoding="utf-8")
    ui = (ROOT / "web" / "material_card_ui.js").read_text(encoding="utf-8")

    assert "/material_card.css" in release
    assert "import('/material_card_ui.js')" in release
    assert ".shot-type-chip" in css
    assert ".confidence-rail small{display:none}" in css
    assert "script-supervisor" in ui
    assert "medium_closeup: '中近景'" in ui
    assert "extreme_closeup: '特写'" in ui
    assert "景别—" in ui


def test_native_slate_keeps_shot_type_as_per_attachment_fact() -> None:
    source = (ROOT / "macos-app" / "MirrorOrderDesktopUI.swift").read_text(encoding="utf-8")
    assert "var shot_type: String" in source
    assert '"shot_type": $0.shot_type' in source
    assert "parsed.angle_shots" in source
    assert "mcShotTypeLabel(attachment.shot_type)" in source
