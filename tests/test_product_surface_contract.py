from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "desktop" / "src" / "app" / "App.tsx"
RESUME = ROOT / "desktop" / "src" / "app" / "resumeState.ts"
WORKBENCH = ROOT / "desktop" / "src" / "features" / "production" / "ProjectWorkbench.tsx"
PROJECT_LIBRARY = ROOT / "desktop" / "src" / "features" / "projects" / "ProjectLibrary.tsx"
PROJECT_LIFECYCLE = ROOT / "desktop" / "src" / "features" / "projects" / "ProjectLifecyclePanel.tsx"
STATUS_CENTER = ROOT / "desktop" / "src" / "features" / "status" / "StatusCenterWorkbench.tsx"
SETTINGS = ROOT / "desktop" / "src" / "features" / "settings" / "SettingsStatusWorkbench.tsx"
LEGACY_TASK_PANEL = ROOT / "desktop" / "src" / "features" / "settings" / "TaskStatusPanel.tsx"
SEARCH = ROOT / "desktop" / "src" / "features" / "search" / "SemanticSearchPalette.tsx"
SLATE = ROOT / "desktop" / "src" / "features" / "slate" / "SlateWorkbench.tsx"
ANGLE_CARD = ROOT / "desktop" / "src" / "features" / "material-script" / "AngleEvidenceCard.tsx"
ANGLE_CARD_CSS = ROOT / "desktop" / "src" / "features" / "material-script" / "fixed-evidence-cards.css"
CONFIDENCE_CARD = ROOT / "desktop" / "src" / "features" / "material-script" / "CandidateEvidence.tsx"
CONFIDENCE_CSS = ROOT / "desktop" / "src" / "features" / "material-script" / "candidate-evidence.css"
TAKE_LIST = ROOT / "desktop" / "src" / "features" / "material-script" / "VirtualTakeList.tsx"
TAKE_INSPECTOR = ROOT / "desktop" / "src" / "features" / "material-script" / "TakeInspector.tsx"
TEAM = ROOT / "desktop" / "src" / "features" / "team" / "TeamWebWorkbench.tsx"
WEB = ROOT / "web" / "index.html"


def test_desktop_is_project_first_production_surface() -> None:
    app = APP.read_text(encoding="utf-8")
    workbench = WORKBENCH.read_text(encoding="utf-8")
    library = PROJECT_LIBRARY.read_text(encoding="utf-8")

    assert "ProjectLibrary" in app
    assert "ProjectWorkbench" in app
    assert 'type AppSurface = "production" | "status" | "team" | "settings"' in app
    assert 'className="global-sidebar"' in app
    assert 'className="workbench-shell main-stage"' in app
    assert "制作台" not in app
    assert "app-workspace-switch" not in app

    for label in ("素材", "剧本", "剪辑", "审阅"):
        assert f'label: "{label}"' in workbench

    for label in (
        "场记",
        "素材库",
        "Take",
        "人物",
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

    assert "状态中心" in library
    assert "团队审阅" in library
    assert ">设置<" in library
    assert 'label: "小镜"' not in workbench


def test_project_resume_restores_last_canvas_and_defaults_to_slate() -> None:
    resume = RESUME.read_text(encoding="utf-8")
    workbench = WORKBENCH.read_text(encoding="utf-8")

    assert 'const DEFAULT_PROJECT_PAGE: ProductionPage = "slate"' in resume
    assert "readProjectPage(project.project_id)" in workbench
    assert "rememberProjectPage(project.project_id, page)" in workbench
    assert '{ id: "material", label: "素材", pages: [{ id: "slate", label: "场记" }, { id: "media-library", label: "素材库" }' in workbench


def test_frontend_parity_surfaces_are_reachable_from_product_ia() -> None:
    workbench = WORKBENCH.read_text(encoding="utf-8")

    assert "MediaLibraryWorkbench" in workbench
    assert "CoverageWorkbench" in workbench
    assert "RoughCutWorkbench" in workbench
    assert "AssemblyWorkbench" in workbench
    assert "ReviewAttentionWorkbench" in workbench
    assert "ProjectOverviewWorkbench" in workbench
    assert "showEditorial" in workbench


def test_project_search_and_assistant_are_contextual_tools_not_new_tabs() -> None:
    workbench = WORKBENCH.read_text(encoding="utf-8")
    search = SEARCH.read_text(encoding="utf-8")

    assert "SemanticSearchPalette" in workbench
    assert "onOpenTake={openTakeFromEvidence}" in workbench
    assert 'event.key.toLowerCase() === "k"' in search
    assert "画面、对白和人工场记证据" in search
    assert "assistant-context-drawer" in workbench
    assert "has-assistant-drawer" in workbench
    assert "setAssistantOpen" in workbench
    assert 'label: "小镜"' not in workbench


def test_slate_is_dense_table_and_preserves_keyboard_flow() -> None:
    slate = SLATE.read_text(encoding="utf-8")

    assert '<table className="slate-table">' in slate
    for column in ("Take", "集", "场", "镜", "条", "机位 / 景别", "状态", "备注", "记录人"):
        assert f">{column}<" in slate
    assert 'event.altKey && event.key === "ArrowUp"' in slate
    assert 'event.altKey && event.key === "ArrowDown"' in slate
    assert '(event.metaKey || event.ctrlKey) && event.key === "Enter"' in slate
    assert "expectedRevision: board.revision" in slate


def test_project_creation_is_low_frequency_modal_not_sidebar_form() -> None:
    lifecycle = PROJECT_LIFECYCLE.read_text(encoding="utf-8")

    assert 'className="project-new-button"' in lifecycle
    assert 'className="project-lifecycle-overlay"' in lifecycle
    assert 'role="dialog"' in lifecycle
    assert "创建后在后台自动整理素材、转写并匹配剧本" in lifecycle
    assert "Python WorkspaceRegistry" not in lifecycle
    assert "prepare task" not in lifecycle


def test_fixed_angle_card_is_one_shared_geometry_contract() -> None:
    component = ANGLE_CARD.read_text(encoding="utf-8")
    css = ANGLE_CARD_CSS.read_text(encoding="utf-8")
    take_list = TAKE_LIST.read_text(encoding="utf-8")
    inspector = TAKE_INSPECTOR.read_text(encoding="utf-8")

    assert "fixed-angle-card" in component
    assert "width: 220px" in css
    assert "min-width: 220px" in css
    assert "max-width: 220px" in css
    assert "height: 76px" in css
    assert "min-height: 76px" in css
    assert "max-height: 76px" in css
    assert "AngleEvidenceCard" in take_list
    assert "AngleEvidenceCard" in inspector
    assert "inspector-angle-cards" in inspector


def test_fixed_confidence_card_cannot_expand_with_content() -> None:
    component = CONFIDENCE_CARD.read_text(encoding="utf-8")
    css = CONFIDENCE_CSS.read_text(encoding="utf-8")

    assert "fixed-confidence-card" in component
    assert ">置信度<" in component
    assert 'ScoreRow label="对白"' in component
    assert 'ScoreRow label="时序"' in component
    assert 'ScoreRow label="上下文"' in component
    assert "height: 263px" in css
    assert "min-height: 263px" in css
    assert "max-height: 263px" in css
    assert "-webkit-line-clamp: 2" in css
    assert "candidate.evidence.slice(0, 4)" in component


def test_background_tasks_have_one_global_status_center_home() -> None:
    app = APP.read_text(encoding="utf-8")
    library = PROJECT_LIBRARY.read_text(encoding="utf-8")
    status_center = STATUS_CENTER.read_text(encoding="utf-8")
    settings = SETTINGS.read_text(encoding="utf-8")

    assert "StatusCenterWorkbench" in app
    assert 'setSurface("status")' in app
    assert "状态中心" in library
    assert "ProjectTaskClient" in status_center
    assert "canCancelTask" in status_center
    assert "canRetryTask" in status_center
    assert "showCompleted" in status_center
    for label in ("准备项目", "多机位同步", "增量素材分析", "剧本归集整理", "转写", "证据提取", "人物 / 声纹索引"):
        assert label in status_center
    assert not LEGACY_TASK_PANEL.exists()
    assert "后台任务统一在“状态中心”查看" in settings


def test_settings_do_not_confuse_team_web_preferences_with_desktop_canvas() -> None:
    settings = SETTINGS.read_text(encoding="utf-8")

    assert "团队审阅偏好" in settings
    assert "这些选项只控制浏览器团队审阅界面，不改变 Desktop 项目的默认场记画布" in settings
    assert ">默认视图<" in settings
    assert ">默认工作台<" not in settings
    assert "settings-advanced-diagnostics" in settings
    assert "高级诊断" in settings


def test_team_web_and_settings_are_global_utilities_not_project_tabs() -> None:
    app = APP.read_text(encoding="utf-8")
    workbench = WORKBENCH.read_text(encoding="utf-8")
    library = PROJECT_LIBRARY.read_text(encoding="utf-8")
    team = TEAM.read_text(encoding="utf-8")

    assert "TeamWebWorkbench" in app
    assert "SettingsStatusWorkbench" in app
    assert "TeamWebWorkbench" not in workbench
    assert "SettingsStatusWorkbench" not in workbench
    assert "团队审阅" in library
    assert ">设置<" in library
    assert "团队审阅" in team
    assert "高级连接设置" in team
    primary = team.split('<details className="team-advanced-settings">', 1)[0]
    assert "Gateway Scope" not in primary
    assert "Network Boundary" not in primary
    assert "Isolated Collaboration Workspace" not in primary


def test_product_shell_hides_runtime_connection_chrome_from_primary_surface() -> None:
    app = APP.read_text(encoding="utf-8")

    assert 'className="workspace-control"' in app
    assert 'className="workspace-advanced"' in app
    assert "connection-panel" not in app
    assert "topbar" not in app
    assert "app-workspace-switch" not in app
    assert "platform-capabilities" not in app
    assert "Python Core" not in app
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
