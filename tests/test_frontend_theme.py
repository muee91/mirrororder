from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_confidence_labels_keep_their_light_palette_in_dark_theme() -> None:
    css = (ROOT / "web" / "style.css").read_text(encoding="utf-8")

    assert ".confidence-exact{border-color:#80d1ad;background:#e9f8f1;color:#116844}" in css
    assert ".confidence-manual{border-color:#b8a7eb;background:#f1edff;color:#5f37ad}" in css
    assert ".confidence-possible{border-color:#e9bd64;background:#fff5df;color:#8c5109}" in css


def test_desktop_app_exposes_light_system_and_dark_themes() -> None:
    ui = (ROOT / "macos-app" / "MirrorOrderDesktopUI.swift").read_text(encoding="utf-8")

    assert "private enum NativeThemeMode" in ui
    assert '"跟随系统"' in ui
    assert '"浅色"' in ui
    assert '"深色"' in ui
    assert "preferredColorScheme(nativeThemeMode.colorScheme)" in ui
    assert "static var background: Color" in ui
    assert "static var panel: Color" in ui


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

    assert "private struct ProductionSidebar" in ui
    assert "private struct SidebarProjectRow" in ui
    assert "private struct ProjectWorkspace" in ui
    assert ".frame(width: 224)" in ui
    assert 'Text("项目")' in ui
    assert 'Text("工作台")' not in ui
    assert "ProjectInspector" not in ui
    assert "WorkbenchPage" not in ui
    assert 'Button("场记") { controller.openScriptSupervisor() }' in ui
    assert 'Button("团队审阅") { controller.openInBrowser() }' in ui
    assert 'CORE_SOURCE="$ROOT/macos-app/MirrorOrderDesktopCore.swift"' in build
    assert 'UI_SOURCE="$ROOT/macos-app/MirrorOrderDesktopUI.swift"' in build


def test_active_work_stays_out_of_the_production_canvas() -> None:
    ui = (ROOT / "macos-app" / "MirrorOrderDesktopUI.swift").read_text(encoding="utf-8")

    assert "private struct ActiveTaskStrip" in ui
    assert "private struct StatusCenterSheet" in ui
    assert "同步、转写、识别和审计任务集中在这里，不占制作画布。" in ui
    assert "if let activity = controller.selectedProjectActivity, activity.isActive" in ui
    assert "ActiveTaskStrip(activity: activity)" in ui
    assert (
        "DesktopWebView(url: controller.workbenchURL, reloadToken: controller.reloadToken)\n"
        "                            .frame(maxWidth: .infinity, maxHeight: .infinity)"
    ) in ui
