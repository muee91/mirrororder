from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_native_production_layer_is_loaded_but_bridge_gated() -> None:
    html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    js = (ROOT / "web" / "production_mode.js").read_text(encoding="utf-8")
    css = (ROOT / "web" / "production.css").read_text(encoding="utf-8")

    assert '<link rel="stylesheet" href="/production.css">' in html
    assert '<script src="/production_mode.js"></script>' in html
    assert "if (!window.webkit?.messageHandlers?.mirrorOrder) return;" in js
    assert "document.documentElement.classList.add('native-production')" in js
    assert "html.native-production .topbar" in css
    assert "html.native-production .app-shell" in css


def test_production_navigation_stays_project_scoped_and_professional() -> None:
    js = (ROOT / "web" / "production_mode.js").read_text(encoding="utf-8")

    for label in ("审阅", "概览", "待处理", "素材", "剧本", "Take", "人物", "粗剪", "组接", "时间线"):
        assert label in js
    assert "项目制作导航" in js
    assert "AI 控制台" not in js
    assert "['timeline', '时间线']" in js


def test_production_layer_does_not_create_a_second_write_path() -> None:
    js = (ROOT / "web" / "production_mode.js").read_text(encoding="utf-8")

    assert "fetchJson(" not in js
    assert "method: 'POST'" not in js
    assert 'method: "POST"' not in js
    assert "method: 'PATCH'" not in js
    assert 'method: "PATCH"' not in js
    assert "review.json" not in js
    assert "auto_decisions.json" not in js


def test_normal_web_review_keeps_review_surface_without_production_dom() -> None:
    html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    ux = (ROOT / "web" / "ux_fixes.js").read_text(encoding="utf-8")
    timeline_loader = (ROOT / "web" / "timeline.js").read_text(encoding="utf-8")

    assert 'id="workspace-select"' in html
    assert 'id="project-select"' in html
    assert 'id="actor-button"' in html
    assert 'id="workspace" class="workspace"' in html
    assert 'id="production-bar"' not in html
    assert 'id="production-panel"' not in html
    assert 'id="create-project" type="button" hidden' in html
    assert 'id="task-button" type="button" hidden' in html
    assert "if (window.webkit?.messageHandlers?.mirrorOrder)" in ux
    assert "if (!window.webkit?.messageHandlers?.mirrorOrder) return;" in timeline_loader


def test_native_workspace_preserves_appkit_bridge_and_team_review_exit() -> None:
    core = (ROOT / "macos-app" / "MirrorOrderDesktopCore.swift").read_text(encoding="utf-8")
    ui = (ROOT / "macos-app" / "MirrorOrderDesktopUI.swift").read_text(encoding="utf-8")
    native = (ROOT / "macos-app" / "NativeProjectWorkbench.swift").read_text(encoding="utf-8")

    assert "struct DesktopWebView: NSViewRepresentable" in core
    assert 'WKScriptMessageHandler' in core
    assert 'name: "mirrorOrder"' in core
    assert "struct NativeReviewReadModel: Decodable" in core
    assert 'appendingPathComponent("review-model")' in core
    assert "struct NativeProjectWorkbench: View" in native
    assert "NativeVideoPlayerView(player: player)" in native
    assert 'Button("团队审阅") { controller.openInBrowser() }' in native
    assert "NativeProjectWorkbench(" in ui


def test_boundary_document_keeps_review_read_model_as_phase_two() -> None:
    doc = (ROOT / "docs" / "production-review-boundary.md").read_text(encoding="utf-8")

    assert "App — Production" in doc
    assert "Web — Review" in doc
    assert "Phase 1：App-only Production Layer" in doc
    assert "Phase 2：Host Review Read Model" in doc
    assert "不得自动 Reject" in doc
    assert "media-bindings.json" in doc
