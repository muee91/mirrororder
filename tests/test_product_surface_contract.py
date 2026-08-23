from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "macos-app" / "MirrorOrderDesktopApp.swift"
WEB = ROOT / "web" / "index.html"


def test_desktop_is_project_first_production_surface() -> None:
    source = APP.read_text(encoding="utf-8")
    assert 'case projects' in source
    assert '@Published var section: ConsoleSection = .projects' in source
    assert 'Label("新建项目", systemImage: "plus")' in source
    assert 'NewProjectSheet(controller: controller' in source
    assert 'workspaceEndpoint("project-preflight")' in source
    assert 'workspaceEndpoint("projects")' in source
    assert 'case intelligence = "本地智能"' in source
    assert 'case collaboration = "团队协作"' in source
    assert 'case diagnostics = "诊断"' in source


def test_web_header_is_review_only() -> None:
    source = WEB.read_text(encoding="utf-8")
    header = source.split('</header>', 1)[0]
    assert '<title>镜序 · 团队审阅</title>' in source
    assert 'AI 建议' in header
    assert '审核人' in header
    assert '>新建项目<' not in header
    assert '>任务<' not in header


def test_web_legacy_production_dom_is_explicitly_hidden() -> None:
    source = WEB.read_text(encoding="utf-8")
    assert '<button id="create-project" type="button" hidden>' in source
    assert '<button id="task-button" type="button" hidden>' in source
    assert '<dialog id="project-dialog" hidden>' in source
    assert '<dialog id="task-dialog" hidden>' in source
