from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_desktop_v2_shell_fills_available_canvas() -> None:
    app = read("desktop-v2/src/app/App.tsx")
    styles = read("desktop-v2/src/styles.css")
    production = read("desktop-v2/src/features/production/production.css")

    assert 'className="app-shell"' in app
    assert 'className="standalone-workspace-shell"' in app
    assert 'className="workspace-shell"' in app
    assert ".app-shell { min-height: 100vh" in styles
    assert ".workspace-shell { display: grid" in styles
    assert "min-height: 620px" in styles
    assert ".project-workbench-nav" in production


def test_top_level_workspace_switch_stays_outside_project_tabs() -> None:
    app = read("desktop-v2/src/app/App.tsx")
    workbench = read("desktop-v2/src/features/production/ProjectWorkbench.tsx")

    assert 'className="app-workspace-switch"' in app
    assert ">制作<" in app
    assert ">团队协作<" in app
    assert "TeamWebWorkbench" in app
    assert "TeamWebWorkbench" not in workbench


def test_removed_swiftui_layout_is_not_a_regression_dependency() -> None:
    assert not (ROOT / "macos-app").exists()
