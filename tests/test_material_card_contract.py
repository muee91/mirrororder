from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_team_web_loads_shared_material_card_contract() -> None:
    release = (ROOT / "web" / "startup_release.js").read_text(encoding="utf-8")
    css = (ROOT / "web" / "material_card.css").read_text(encoding="utf-8")
    ui = (ROOT / "web" / "material_card_ui.js").read_text(encoding="utf-8")

    assert "/material_card.css" in release
    assert "import('/material_card_ui.js')" in release
    assert ".shot-type-chip" in css
    assert 'content:"剧本匹配"' in css
    assert ".confidence-rail small{" in css
    assert "font-variant-numeric:tabular-nums" in css
    assert "script-supervisor" in ui
    assert "medium_closeup: '中近景'" in ui
    assert "extreme_closeup: '特写'" in ui
    assert "big_closeup: '大特写'" in ui
    assert "景别—" in ui


def test_small_mirror_is_button_only_on_team_web_and_reuses_rough_preview() -> None:
    assistant = (ROOT / "web" / "assistant_ui.js").read_text(encoding="utf-8")
    control = (ROOT / "web" / "assistant_control_ui.js").read_text(encoding="utf-8")
    native = (ROOT / "macos-app" / "NativeProjectWorkbench.swift").read_text(encoding="utf-8")

    assert "if (!APP_CLIENT)" in assistant and "nudge.hidden = true" in assistant
    assert "if (!APP_CLIENT)" in control and "nudge.hidden = true" in control
    assert 'Label("小镜", systemImage: "sparkles")' in native
    assert 'projectEndpoint(controller, "rough-placement")' in native
    assert 'payload: ["text": text, "confirm": false]' in native
    assert 'payload: ["text": text, "confirm": true, "actor": actor]' in native


def test_native_slate_keeps_shot_type_as_per_attachment_fact() -> None:
    source = (ROOT / "macos-app" / "MirrorOrderDesktopUI.swift").read_text(encoding="utf-8")
    assert "var shot_type: String" in source
    assert '"shot_type": $0.shot_type' in source
    assert "parsed.angle_shots" in source
    assert "mcShotTypeLabel(attachment.shot_type)" in source
