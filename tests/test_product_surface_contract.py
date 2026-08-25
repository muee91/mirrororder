from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "desktop-v2" / "src" / "app" / "App.tsx"
WORKBENCH = ROOT / "desktop-v2" / "src" / "features" / "production" / "ProjectWorkbench.tsx"
WEB = ROOT / "web" / "index.html"


def test_desktop_v2_is_project_first_production_surface() -> None:
    app = APP.read_text(encoding="utf-8")
    workbench = WORKBENCH.read_text(encoding="utf-8")

    assert "ProjectLibrary" in app
    assert "ProjectWorkbench" in app
    assert 'setAppWorkspace("production")' in app
    assert 'setAppWorkspace("team")' in app
    for label in ("素材 / 剧本", "场记", "人物", "小镜", "剪辑", "交付", "本机素材", "设置 / 状态"):
        assert f'label: "{label}"' in workbench


def test_team_web_is_top_level_and_not_a_project_tab() -> None:
    app = APP.read_text(encoding="utf-8")
    workbench = WORKBENCH.read_text(encoding="utf-8")

    assert "TeamWebWorkbench" in app
    assert 'type AppWorkspace = "production" | "team"' in app
    assert "TeamWebWorkbench" not in workbench
    assert 'label: "团队协作"' not in workbench


def test_web_header_is_review_only() -> None:
    source = WEB.read_text(encoding="utf-8")
    header = source.split("</header>", 1)[0]

    assert '<title>镜序 · 团队审阅</title>' in source
    assert "审核人" in header
    assert ">新建项目<" not in header
    assert ">任务<" not in header
    assert "镜序助理" not in header
    assert "时间线" not in header


def test_web_legacy_production_dom_is_explicitly_hidden() -> None:
    source = WEB.read_text(encoding="utf-8")
    assert '<button id="create-project" type="button" hidden>' in source
    assert '<button id="task-button" type="button" hidden>' in source
    assert '<dialog id="project-dialog" hidden>' in source
    assert '<dialog id="task-dialog" hidden>' in source


def test_swiftui_client_is_physically_removed() -> None:
    assert not (ROOT / "macos-app").exists()
