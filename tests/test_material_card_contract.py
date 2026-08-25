from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_team_web_loads_shared_material_card_contract() -> None:
    release = (ROOT / "web" / "startup_release.js").read_text(encoding="utf-8")
    css = (ROOT / "web" / "material_card.css").read_text(encoding="utf-8")
    ui = (ROOT / "web" / "material_card_ui.js").read_text(encoding="utf-8")

    assert "/material_card.css" in release
    assert "loadScript('/material_card_ui.js')" in release
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
    projection = (ROOT / "web" / "assistant_projection_ui.js").read_text(encoding="utf-8")
    workbench = (ROOT / "desktop/src/features/assistant/AssistantWorkbench.tsx").read_text(encoding="utf-8")

    assert "if (!APP_CLIENT)" in assistant and "nudge.hidden = true" in assistant
    assert "if (!APP_CLIENT)" in control and "nudge.hidden = true" in control
    assert "if (window.webkit?.messageHandlers?.mirrorOrder) return;" in projection
    assert "由制作 Host 计算 · Web 只展示结果" in projection
    assert "fetchJson(projectApi('/assistant')" in projection
    assert "cycleAssistant" in workbench and "messageAssistant" in workbench


def test_native_slate_keeps_shot_type_as_per_attachment_fact() -> None:
    source = (ROOT / "desktop/src/features/slate/SlateWorkbench.tsx").read_text(encoding="utf-8")
    runtime = (ROOT / "src/script_organizer/script_supervisor_runtime.py").read_text(encoding="utf-8")
    assert "const angles: SlateEntry[\"angles\"]" in source
    assert "const shotType = parsed.angle_shots[camera]" in source
    assert "angles[angle.clip_id]" in source
    assert '"shot_type": str(_as_dict(row).get("shot_type", "unknown")' in runtime
