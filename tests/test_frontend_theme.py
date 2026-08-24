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


def test_review_media_cards_share_fixed_low_noise_visual_contract() -> None:
    css = (ROOT / "web" / "review.css").read_text(encoding="utf-8")

    assert "flex:0 0 164px" in css
    assert "width:164px" in css
    assert "height:64px" in css
    assert ".member-card.active::after" in css
    assert 'content:"✓"' in css
    assert ".member-card:disabled::before" in css
    assert 'content:"缺失"' in css
    assert "text-overflow:ellipsis" in css
    assert ".camera-run.repeated{min-width:0;width:max-content" in css


def test_desktop_surface_uses_project_home_and_multicam_slate() -> None:
    ui = (ROOT / "macos-app" / "MirrorOrderDesktopUI.swift").read_text(encoding="utf-8")
    build = (ROOT / "macos-app" / "build_app.sh").read_text(encoding="utf-8")

    assert "private struct ProductionSidebar" in ui
    assert "private struct SidebarProjectRow" in ui
    assert "private struct ProjectHomeView" in ui
    assert "private struct ProjectHomeCard" in ui
    assert "private struct ProjectWorkspace" in ui
    assert '@Published var showProjectHome = true' in ui
    assert 'Text("全部项目")' in ui
    assert 'Text("最近项目")' in ui
    assert ".frame(width: 216)" in ui
    assert "private struct NativeMulticamSlateProjectWorkbench" in ui
    assert 'TableColumn("A 机")' in ui
    assert 'TableColumn("B 机")' in ui
    assert 'TableColumn("C 机")' in ui
    assert 'TableColumn("辅助 / 特殊")' in ui
    assert "private struct MCMediaCard" in ui
    assert "AVAssetImageGenerator" in ui
    assert "checkmark.circle.fill" in ui
    assert 'CORE_SOURCE="$ROOT/macos-app/MirrorOrderDesktopCore.swift"' in build
    assert 'UI_SOURCE="$ROOT/macos-app/MirrorOrderDesktopUI.swift"' in build


def test_active_work_stays_out_of_the_production_canvas() -> None:
    ui = (ROOT / "macos-app" / "MirrorOrderDesktopUI.swift").read_text(encoding="utf-8")

    assert "private struct ActiveTaskStrip" in ui
    assert "private struct StatusCenterSheet" in ui
    assert "同步、转写、识别和审计任务集中在这里，不占制作画布。" in ui
    assert "if let activity = controller.selectedProjectActivity, activity.isActive" in ui
    assert "ActiveTaskStrip(activity: activity)" in ui
    assert "NativeProjectWorkbench(" in ui
