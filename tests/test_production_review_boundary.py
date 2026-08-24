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


def test_native_production_navigation_stays_project_scoped_and_opens_on_slate() -> None:
    ui = (ROOT / "macos-app" / "MirrorOrderDesktopUI.swift").read_text(encoding="utf-8")
    native = (ROOT / "macos-app" / "NativeProjectWorkbench.swift").read_text(encoding="utf-8")

    assert "private struct ProductionSidebar" in ui
    assert "private struct SidebarProjectRow" in ui
    assert "ProjectWorkspace(" in ui
    assert 'Text("项目")' in ui
    assert 'Text("工作台")' not in ui
    assert 'case supervisor = "场记"' in native
    assert '@State private var surface: NativeProjectSurface = .supervisor' in native
    assert "NativeScriptSupervisorWorkspace(controller: controller, model: model)" in native
    assert "NativeScriptSupervisorSheet" not in native
    assert 'Label("人物", systemImage: "person.2")' in native
    assert 'Text("AI 控制台")' not in native


def test_native_slate_remains_human_evidence_not_editorial_authority() -> None:
    native = (ROOT / "macos-app" / "NativeProjectWorkbench.swift").read_text(encoding="utf-8")
    runtime = (ROOT / "src" / "script_organizer" / "script_supervisor_runtime.py").read_text(encoding="utf-8")
    parser = (ROOT / "src" / "script_organizer" / "script_supervisor_parser.py").read_text(encoding="utf-8")

    assert "不是 Editorial Best" in native
    assert '"editorial_authority": False' in runtime
    assert "禁止编造秒数、人物身份、Best/Keep/Reject" in parser
    assert "range_hint" in parser
    assert "usable_range" not in parser.split("def deterministic_parse", 1)[1].split("def _sanitize_model", 1)[0]


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
    assert 'Label("团队审阅", systemImage: "person.3")' in native
    assert "controller.openInBrowser()" in native
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
