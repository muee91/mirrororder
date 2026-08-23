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


def test_lan_pairing_uses_cookie_safe_browser_requests() -> None:
    app = (ROOT / "web" / "app.js").read_text(encoding="utf-8")

    assert "credentials: 'same-origin'" in app
    assert "fetch(projectApi('/review')" not in app
    assert "fetch(`${projectApi('/search')}" not in app
    assert "sessionStorage.getItem('mirrororder-session')" not in app
    assert "sessionStorage.setItem('mirrororder-session'" not in app


def test_review_room_loads_responsive_professional_surface() -> None:
    html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    css = (ROOT / "web" / "review.css").read_text(encoding="utf-8")

    assert '<link rel="stylesheet" href="/review.css">' in html
    assert 'id="identity-library-button"' in html
    assert '>人物</button>' in html
    assert 'id="proposal-button"' in html
    assert '>建议</button>' in html
    assert 'class="project-switch workspace-switch"' in html
    assert "body{min-width:0" in css
    assert "@media(max-width:1260px)" in css
    assert "@media(max-width:900px)" in css
    assert "@media(max-width:680px)" in css
    assert 'grid-template-areas:"script takes inspector"' in css
    assert "box-shadow:inset 3px 0 0 var(--blue)" in css


def test_desktop_surface_uses_project_first_hierarchy() -> None:
    ui = (ROOT / "macos-app" / "MirrorOrderDesktopUI.swift").read_text(encoding="utf-8")
    build = (ROOT / "macos-app" / "build_app.sh").read_text(encoding="utf-8")

    assert "NativeThemeMode.system.rawValue" in ui
    assert 'Text("项目")' in ui
    assert 'Text("工作台")' not in ui
    assert 'systemImage: "ellipsis"' in ui
    assert 'Text("永久删除项目…")' in ui
    assert 'Text("内容与人物")' in ui
    assert 'Text("可选增强")' in ui
    assert 'Label("\\(attention.count) 项需处理"' in ui
    assert 'case .ready: return stage.kind == .ready' in ui
    assert 'case .attention: return attention.hasIssues || stage.kind == .failed' in ui
    assert 'CORE_SOURCE="$ROOT/macos-app/MirrorOrderDesktopCore.swift"' in build
    assert 'UI_SOURCE="$ROOT/macos-app/MirrorOrderDesktopUI.swift"' in build
