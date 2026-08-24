from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "macos-app" / "MirrorOrderDesktopCore.swift"
UI = ROOT / "macos-app" / "MirrorOrderDesktopUI.swift"
WEB = ROOT / "web" / "index.html"


def test_desktop_is_project_first_production_surface() -> None:
    core = CORE.read_text(encoding="utf-8")
    ui = UI.read_text(encoding="utf-8")

    assert "private struct ProductionSidebar" in ui
    assert "private struct SidebarProjectRow" in ui
    assert "ProjectWorkspace(controller: controller" in ui
    assert 'Button(action: onNewProject)' in ui
    assert "private struct NewProjectSheet" in ui
    assert 'Text("原始素材").tag("media-directory")' in ui
    assert 'Text("已有对齐 FCPXML").tag("fcpxml")' in ui
    assert 'Button("开始自动整理")' in ui
    assert 'Button("永久删除项目…", role: .destructive)' in ui
    assert 'case intelligence = "本地智能"' in ui
    assert 'case collaboration = "团队协作"' in ui
    assert 'case diagnostics = "诊断"' in ui
    assert 'workspaceEndpoint("project-preflight")' in core
    assert 'workspaceEndpoint("projects")' in core


def test_web_header_is_review_only() -> None:
    source = WEB.read_text(encoding="utf-8")
    header = source.split('</header>', 1)[0]

    assert '<title>镜序 · 团队审阅</title>' in source
    assert '审核人' in header
    assert '>新建项目<' not in header
    assert '>任务<' not in header
    assert '镜序助理' not in header
    assert '时间线' not in header


def test_web_legacy_production_dom_is_explicitly_hidden() -> None:
    source = WEB.read_text(encoding="utf-8")
    assert '<button id="create-project" type="button" hidden>' in source
    assert '<button id="task-button" type="button" hidden>' in source
    assert '<dialog id="project-dialog" hidden>' in source
    assert '<dialog id="task-dialog" hidden>' in source
