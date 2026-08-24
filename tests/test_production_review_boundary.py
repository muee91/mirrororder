from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_app_production_is_native_and_does_not_embed_team_web() -> None:
    ui = (ROOT / "macos-app" / "MirrorOrderDesktopUI.swift").read_text(encoding="utf-8")
    native = (ROOT / "macos-app" / "NativeProjectWorkbench.swift").read_text(encoding="utf-8")

    assert "NativeProjectWorkbench(" in ui
    assert "struct NativeProjectWorkbench: View" in native
    assert "NativeVideoPlayerView(player: player)" in native
    assert "DesktopWebView(" not in ui
    assert "DesktopWebView(" not in native
    assert "WKWebView" not in ui
    assert "WKWebView" not in native
    assert "production_mode.js" not in ui
    assert "production_mode.js" not in native


def test_native_production_navigation_stays_project_scoped_and_professional() -> None:
    ui = (ROOT / "macos-app" / "MirrorOrderDesktopUI.swift").read_text(encoding="utf-8")
    native = (ROOT / "macos-app" / "NativeProjectWorkbench.swift").read_text(encoding="utf-8")

    assert "private struct ProductionSidebar" in ui
    assert "private struct SidebarProjectRow" in ui
    assert "ProjectWorkspace(" in ui
    assert 'Text("项目")' in ui
    assert 'Text("工作台")' not in ui
    assert 'Button("人物库") { showPeople = true }' in native
    assert 'Button("场记") { showSupervisor = true }' in native
    assert 'Text("AI 控制台")' not in native


def test_team_web_keeps_review_surface_without_production_dom() -> None:
    html = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    ux = (ROOT / "web" / "ux_fixes.js").read_text(encoding="utf-8")

    assert 'id="workspace-select"' in html
    assert 'id="project-select"' in html
    assert 'id="actor-button"' in html
    assert 'id="workspace" class="workspace"' in html
    assert 'id="production-bar"' not in html
    assert 'id="production-panel"' not in html
    assert 'id="create-project" type="button" hidden' in html
    assert 'id="task-button" type="button" hidden' in html
    assert "document.createElement('script')" not in ux


def test_native_workspace_reads_host_projection_and_opens_team_review_externally() -> None:
    core = (ROOT / "macos-app" / "MirrorOrderDesktopCore.swift").read_text(encoding="utf-8")
    ui = (ROOT / "macos-app" / "MirrorOrderDesktopUI.swift").read_text(encoding="utf-8")
    native = (ROOT / "macos-app" / "NativeProjectWorkbench.swift").read_text(encoding="utf-8")

    assert "struct NativeReviewReadModel: Decodable" in core
    assert 'appendingPathComponent("review-model")' in core
    assert "struct NativeProjectWorkbench: View" in native
    assert "JSONDecoder().decode(NativeReviewReadModel.self" in native
    assert 'Button("团队审阅") { controller.openInBrowser() }' in native
    assert "NSWorkspace.shared.open(workbenchURL(for: projectID))" in core
    assert "NativeProjectWorkbench(" in ui


def test_boundary_document_defines_native_production_and_web_review() -> None:
    doc = (ROOT / "docs" / "production-review-boundary.md").read_text(encoding="utf-8")

    assert "App — Native Production" in doc
    assert "Web — Team Review" in doc
    assert "App 主制作画布不得嵌入 WebView" in doc
    assert "review.v1" in doc
    assert "不得自动 Reject" in doc
    assert "media-bindings.json" in doc
