from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_confidence_labels_keep_their_light_palette_in_dark_theme() -> None:
    css = (ROOT / "web" / "style.css").read_text(encoding="utf-8")

    assert ".confidence-exact{border-color:#80d1ad;background:#e9f8f1;color:#116844}" in css
    assert ".confidence-manual{border-color:#b8a7eb;background:#f1edff;color:#5f37ad}" in css
    assert ".confidence-possible{border-color:#e9bd64;background:#fff5df;color:#8c5109}" in css


def test_active_desktop_exposes_system_light_and_dark_preferences() -> None:
    settings = (ROOT / "desktop" / "src" / "features" / "settings" / "SettingsStatusWorkbench.tsx").read_text(encoding="utf-8")
    api = (ROOT / "desktop" / "src" / "api" / "desktop.ts").read_text(encoding="utf-8")
    styles = (ROOT / "desktop" / "src" / "styles.css").read_text(encoding="utf-8")

    assert 'theme: "system" | "light" | "dark"' in api
    assert '<option value="system">跟随系统</option>' in settings
    assert '<option value="light">浅色</option>' in settings
    assert '<option value="dark">深色</option>' in settings
    assert "@media (prefers-color-scheme: light)" in styles
    assert not (ROOT / "macos-app").exists()


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


def test_active_desktop_surface_uses_project_home_and_frozen_production_workbenches() -> None:
    app = (ROOT / "desktop" / "src" / "app" / "App.tsx").read_text(encoding="utf-8")
    library = (ROOT / "desktop" / "src" / "features" / "projects" / "ProjectLibrary.tsx").read_text(encoding="utf-8")
    workbench = (ROOT / "desktop" / "src" / "features" / "production" / "ProjectWorkbench.tsx").read_text(encoding="utf-8")

    assert "ProjectLibrary" in app
    assert "ProjectWorkbench" in app
    assert "project-list" in library
    assert "GoldenSlateWorkbench" in workbench
    assert "GoldenMaterialScriptWorkbench" in workbench
    assert 'label: "素材库"' in workbench
    assert 'label: "本机素材"' in workbench
    assert 'label: "人物"' in workbench
    assert 'label: "审阅"' in workbench
    assert "TimelineWorkbench" not in workbench
    assert 'label: "交付"' not in workbench


def test_active_work_has_one_global_status_center_not_settings_task_panel() -> None:
    app = (ROOT / "desktop" / "src" / "app" / "App.tsx").read_text(encoding="utf-8")
    library = (ROOT / "desktop" / "src" / "features" / "projects" / "ProjectLibrary.tsx").read_text(encoding="utf-8")
    status_center = (ROOT / "desktop" / "src" / "features" / "status" / "StatusCenterWorkbench.tsx").read_text(encoding="utf-8")
    settings = (ROOT / "desktop" / "src" / "features" / "settings" / "SettingsStatusWorkbench.tsx").read_text(encoding="utf-8")

    assert "StatusCenterWorkbench" in app
    assert "状态中心" in library
    assert "ProjectTaskClient" in status_center
    assert "TaskStatusPanel" not in settings
    assert "platform-capabilities" not in app
    assert "runtime diagnostics" not in app.lower()
