from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "desktop" / "src" / "app" / "App.tsx"
WORKBENCH = ROOT / "desktop" / "src" / "features" / "production" / "ProjectWorkbench.tsx"
PROJECT_LIBRARY = ROOT / "desktop" / "src" / "features" / "projects" / "ProjectLibrary.tsx"
STATUS_CENTER = ROOT / "desktop" / "src" / "features" / "status" / "StatusCenterWorkbench.tsx"
SETTINGS = ROOT / "desktop" / "src" / "features" / "settings" / "SettingsStatusWorkbench.tsx"
WEB = ROOT / "web" / "index.html"


def test_desktop_is_project_first_production_surface() -> None:
    app = APP.read_text(encoding="utf-8")
    workbench = WORKBENCH.read_text(encoding="utf-8")

    assert "ProjectLibrary" in app
    assert "ProjectWorkbench" in app
    assert 'setAppWorkspace("production")' in app
    assert 'setAppWorkspace("team")' in app

    # Product navigation is organized by production objects/stages, not by
    # backend module count. These four areas are the stable top-level contract.
    for label in ("素材", "剧本", "剪辑", "审阅"):
        assert f'label: "{label}"' in workbench

    # Capabilities live under a clear production home instead of becoming
    # additional primary tabs as the backend grows.
    for label in (
        "素材库",
        "Take",
        "人物",
        "场记",
        "覆盖",
        "粗剪",
        "组接",
        "时间线",
        "交付",
        "看片",
        "待处理",
        "概览",
    ):
        assert f'label: "{label}"' in workbench

    assert 'label: "素材 / 剧本"' not in workbench
    assert 'label: "本机素材"' not in workbench
    assert 'label: "设置 / 状态"' not in workbench
    assert 'label: "小镜"' not in workbench


def test_frontend_parity_surfaces_are_reachable_from_product_ia() -> None:
    workbench = WORKBENCH.read_text(encoding="utf-8")

    assert "MediaLibraryWorkbench" in workbench
    assert "CoverageWorkbench" in workbench
    assert "RoughCutWorkbench" in workbench
    assert "AssemblyWorkbench" in workbench
    assert "ReviewAttentionWorkbench" in workbench
    assert "ProjectOverviewWorkbench" in workbench
    assert "showEditorial" in workbench


def test_background_tasks_have_one_global_status_center_home() -> None:
    app = APP.read_text(encoding="utf-8")
    library = PROJECT_LIBRARY.read_text(encoding="utf-8")
    status_center = STATUS_CENTER.read_text(encoding="utf-8")
    settings = SETTINGS.read_text(encoding="utf-8")

    assert "StatusCenterWorkbench" in app
    assert "statusCenterOpen" in app
    assert "状态中心" in library
    assert "ProjectTaskClient" in status_center
    assert "canCancelTask" in status_center
    assert "canRetryTask" in status_center
    assert "TaskStatusPanel" not in settings
    assert "后台任务的进度、取消与重试统一放在左侧“状态中心”" in settings


def test_team_web_is_top_level_and_not_a_project_tab() -> None:
    app = APP.read_text(encoding="utf-8")
    workbench = WORKBENCH.read_text(encoding="utf-8")

    assert "TeamWebWorkbench" in app
    assert 'type AppWorkspace = "production" | "team"' in app
    assert "TeamWebWorkbench" not in workbench
    assert 'label: "团队协作"' not in workbench


def test_product_shell_hides_runtime_diagnostics_from_primary_surface() -> None:
    app = APP.read_text(encoding="utf-8")

    assert "高级连接选项" in app
    assert "本机服务地址" in app
    assert "platform-capabilities" not in app
    assert "Python Core" not in app
    assert "API ${" not in app
    assert "Local Production Host" not in app


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
