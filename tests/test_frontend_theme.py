from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_confidence_labels_keep_their_light_palette_in_dark_theme() -> None:
    css = (ROOT / "web" / "style.css").read_text(encoding="utf-8")

    assert ".confidence-exact{border-color:#80d1ad;background:#e9f8f1;color:#116844}" in css
    assert ".confidence-manual{border-color:#b8a7eb;background:#f1edff;color:#5f37ad}" in css
    assert ".confidence-possible{border-color:#e9bd64;background:#fff5df;color:#8c5109}" in css


def test_desktop_app_exposes_light_system_and_dark_workbench_themes() -> None:
    settings = (ROOT / "macos-app" / "LocalRuntimeSettingsView.swift").read_text(encoding="utf-8")

    assert 'Text("浅色").tag("light")' in settings
    assert 'Text("跟随系统").tag("system")' in settings
    assert 'Text("深色").tag("dark")' in settings
    assert "置信度标签保持浅色模式的原有颜色" in settings
