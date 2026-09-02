from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_desktop_shell_fills_available_canvas() -> None:
    app = read("desktop/src/app/App.tsx")
    redesign = read("desktop/src/app/mirrororder-redesign.css")
    experience = read("desktop/src/features/production/product-experience.css")
    workbench = read("desktop/src/features/production/ProjectWorkbench.tsx")

    assert 'className="app-shell production-app-shell mirrororder-redesign-shell"' in app
    assert 'className="startup-shell"' in app
    assert 'className="workspace-shell application-frame"' in app
    assert 'className="app-main-column"' in app
    assert 'className="app-global-topbar"' in app
    assert ".mirrororder-redesign-shell .application-frame" in redesign
    assert "height: 100%" in redesign
    assert "grid-template-columns: 208px minmax(0, 1fr)" in redesign
    assert ".app-main-column" in redesign
    assert ".project-workbench-canvas { flex: 1;" in experience
    assert 'className="project-workbench-main owns-chrome"' in workbench


def test_global_navigation_and_project_navigation_have_separate_authority() -> None:
    app = read("desktop/src/app/App.tsx")
    workbench = read("desktop/src/features/production/ProjectWorkbench.tsx")
    library = read("desktop/src/features/projects/ProjectLibrary.tsx")

    assert "openTeamProject(project: ProjectSummary)" in app
    assert 'setSurface("team")' in app
    assert 'surface === "team"' in app
    assert "TeamWebWorkbench" in app
    assert "TeamWebWorkbench" not in workbench

    assert 'className="professional-project-toolbar"' in workbench
    assert 'aria-label="制作区域"' in workbench
    assert 'className="professional-secondary-nav"' in workbench
    for label in ("素材", "剧本", "剪辑", "审阅"):
        assert f'label: "{label}"' in workbench

    assert "professional-global-sidebar" in library
    assert 'aria-label="主导航"' in library
    assert 'aria-label="系统导航"' in library
    assert "制作区在项目画布顶部切换。" in library
    assert 'aria-label="当前项目制作导航"' not in library
    assert 'onClick={() => openPage("watch")}' not in library


def test_removed_swiftui_layout_is_not_a_regression_dependency() -> None:
    assert not (ROOT / "macos-app").exists()
    assert (ROOT / "desktop" / "src" / "app" / "App.tsx").is_file()
