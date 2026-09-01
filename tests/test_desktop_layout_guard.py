from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_desktop_shell_fills_available_canvas() -> None:
    app = read("desktop/src/app/App.tsx")
    styles = read("desktop/src/styles.css")
    production = read("desktop/src/features/production/production.css")
    experience = read("desktop/src/features/production/product-experience.css")

    assert 'className="app-shell production-app-shell"' in app
    assert 'className="startup-shell"' in app
    assert 'className="workspace-shell application-frame"' in app
    assert ".app-shell { min-height: 100vh" in styles
    assert ".workspace-shell { display: grid" in styles
    assert ".project-workbench-canvas { flex: 1;" in experience
    assert ".production-secondary-workspace" in production or ".production-secondary-workspace" in experience
    assert ".production-secondary-bar" in production or ".production-secondary-bar" in experience


def test_top_level_workspace_switch_stays_outside_project_tools() -> None:
    app = read("desktop/src/app/App.tsx")
    workbench = read("desktop/src/features/production/ProjectWorkbench.tsx")

    assert 'onOpenTeam={() => setSurface("team")}' in app
    assert 'surface === "team"' in app
    assert "TeamWebWorkbench" in app
    assert "TeamWebWorkbench" not in workbench
    assert 'aria-label="项目工具"' in workbench


def test_removed_swiftui_layout_is_not_a_regression_dependency() -> None:
    assert not (ROOT / "macos-app").exists()
    assert (ROOT / "desktop" / "src" / "app" / "App.tsx").is_file()
