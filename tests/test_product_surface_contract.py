from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "desktop" / "src" / "app" / "App.tsx"
RESUME = ROOT / "desktop" / "src" / "app" / "resumeState.ts"
REDESIGN = ROOT / "desktop" / "src" / "app" / "mirrororder-redesign.css"
WORKBENCH = ROOT / "desktop" / "src" / "features" / "production" / "ProjectWorkbench.tsx"
PROJECT_LIBRARY = ROOT / "desktop" / "src" / "features" / "projects" / "ProjectLibrary.tsx"
WORKSPACE_HOME = ROOT / "desktop" / "src" / "features" / "projects" / "WorkspaceHome.tsx"
PROJECT_LIFECYCLE = ROOT / "desktop" / "src" / "features" / "projects" / "ProjectLifecyclePanel.tsx"
STATUS_CENTER = ROOT / "desktop" / "src" / "features" / "status" / "StatusCenterWorkbench.tsx"
SETTINGS = ROOT / "desktop" / "src" / "features" / "settings" / "SettingsStatusWorkbench.tsx"
LEGACY_TASK_PANEL = ROOT / "desktop" / "src" / "features" / "settings" / "TaskStatusPanel.tsx"
SLATE = ROOT / "desktop" / "src" / "features" / "slate" / "GoldenSlateWorkbench.tsx"
MEDIA_CARD = ROOT / "desktop" / "src" / "features" / "media" / "MirrorOrderMediaCard.tsx"
MEDIA_CARD_CSS = ROOT / "desktop" / "src" / "features" / "media" / "mirrororder-media-card.css"
TEAM = ROOT / "desktop" / "src" / "features" / "team" / "TeamWebWorkbench.tsx"
WEB = ROOT / "web" / "index.html"


def test_desktop_uses_workspace_home_and_authoritative_production_ia() -> None:
    app = APP.read_text(encoding="utf-8")
    workbench = WORKBENCH.read_text(encoding="utf-8")
    library = PROJECT_LIBRARY.read_text(encoding="utf-8")
    workspace_home = WORKSPACE_HOME.read_text(encoding="utf-8")
    redesign = REDESIGN.read_text(encoding="utf-8")

    assert "WorkspaceHome" in app
    assert "ProjectHome" in app
    assert "ProjectLibrary" in app
    assert "ProjectWorkbench" in app
    assert 'type AppSurface = "home" | "projects" | "production" | "status" | "team" | "settings"' in app
    assert 'className="global-sidebar"' in app
    assert 'workbench-shell main-stage surface-${surface}' in app
    assert 'className="app-global-topbar"' in app
    assert "今晚继续哪里？" in workspace_home
    assert "制作台" not in app
    assert "app-workspace-switch" not in app
    assert "grid-template-columns: 208px minmax(0, 1fr)" in redesign

    assert "const AREAS: Record<ProductionArea, AreaDefinition>" in workbench
    assert 'className="professional-project-toolbar"' in workbench
    assert 'aria-label="制作区域"' in workbench
    assert 'className="professional-secondary-nav"' in workbench
    for label in ("素材", "剧本", "剪辑", "审阅"):
        assert f'label: "{label}"' in workbench
    for page, label in (
        ("slate", "场记"),
        ("media-library", "素材库"),
        ("takes", "Take"),
        ("identity", "人物"),
        ("script", "剧本"),
        ("coverage", "覆盖"),
        ("rough-cut", "粗剪"),
        ("assembly", "组接"),
        ("timeline", "时间线"),
        ("delivery", "交付"),
        ("watch", "看片"),
        ("attention", "待处理"),
        ("overview", "概览"),
    ):
        assert f'{{ page: "{page}", label: "{label}" }}' in workbench
    assert "TimelineWorkbench" in workbench
    assert "RoughCutWorkbench" in workbench
    assert "AssemblyWorkbench" in workbench
    edit_area = workbench.split("edit: {", 1)[1].split("review: {", 1)[0]
    assert '{ page: "timeline", label: "时间线" }' in edit_area
    assert '{ page: "delivery", label: "交付" }' in edit_area

    assert "professional-global-sidebar" in library
    assert 'aria-label="主导航"' in library
    assert 'aria-label="系统导航"' in library
    assert "状态中心" in library
    assert ">设置<" in library
    assert 'aria-label="当前项目制作导航"' not in library
    assert 'onClick={() => openPage("watch")}' not in library


def test_project_resume_defaults_new_state_to_slate_and_restores_valid_project_page() -> None:
    app = APP.read_text(encoding="utf-8")
    resume = RESUME.read_text(encoding="utf-8")
    workbench = WORKBENCH.read_text(encoding="utf-8")

    assert 'const DEFAULT_PROJECT_PAGE: ProductionPage = "slate"' in resume
    assert 'useState<AppSurface>("home")' in app
    assert 'setSelectedProject(rememberedProject)' in app
    assert 'setSurface("home")' in app
    assert "safeProductionPage(readProjectPage(project.project_id))" in workbench
    assert "rememberProjectPage(project.project_id, page)" in workbench
    assert "VALID_PROJECT_PAGES.has(value)" in resume


def test_production_surfaces_are_reachable_from_project_toolbar_not_sidebar() -> None:
    workbench = WORKBENCH.read_text(encoding="utf-8")
    library = PROJECT_LIBRARY.read_text(encoding="utf-8")

    assert 'const materialScript = page === "takes" || page === "script"' in workbench
    assert "GoldenMaterialScriptWorkbench" in workbench
    assert 'initialMode={page === "takes" ? "rough" : "precise"}' in workbench
    assert "MediaLibraryWorkbench" in workbench
    assert "MediaBindingWorkbench" in workbench
    assert "IdentityWorkbench" in workbench
    assert "CoverageWorkbench" in workbench
    assert "RoughCutWorkbench" in workbench
    assert "AssemblyWorkbench" in workbench
    assert "TimelineWorkbench" in workbench
    assert "DeliveryWorkbench" in workbench
    assert "ReviewAttentionWorkbench" in workbench
    assert "ProjectOverviewWorkbench" in workbench
    assert "showEditorial={false}" in workbench
    assert "制作区在项目画布顶部切换。" in library
    for label in ("场记", "素材库", "Take", "人物", "剧本", "覆盖", "粗剪", "组接", "时间线", "交付", "看片", "待处理", "概览"):
        assert f'label: "{label}"' in workbench


def test_assistant_is_a_contextual_tool_not_a_project_tab() -> None:
    workbench = WORKBENCH.read_text(encoding="utf-8")

    assert "assistant-context-drawer" in workbench
    assert "has-assistant-drawer" in workbench
    assert "setAssistantOpen" in workbench
    assert 'aria-label="小镜上下文助手"' in workbench
    assert 'label: "小镜"' not in workbench


def test_slate_is_dense_table_and_preserves_keyboard_flow() -> None:
    slate = SLATE.read_text(encoding="utf-8")

    assert '<table className="golden-slate-table">' in slate
    for column in ("集", "场号", "镜号", "次号", "A 机", "B 机", "C 机", "辅助 / 特殊", "状态"):
        assert f">{column}<" in slate
    assert '(event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s"' in slate
    assert '(event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n"' in slate
    assert "expectedRevision: revision" in slate
    assert "displayedDrafts.findIndex" in slate


def test_project_creation_is_low_frequency_modal_not_sidebar_form() -> None:
    lifecycle = PROJECT_LIFECYCLE.read_text(encoding="utf-8")

    assert 'className="project-new-button project-home-new-button"' in lifecycle
    assert 'className="project-lifecycle-overlay"' in lifecycle
    assert 'role="dialog"' in lifecycle
    assert "创建后自动整理" in lifecycle
    assert "后台整理素材、转写并匹配剧本" in lifecycle
    assert "Python WorkspaceRegistry" not in lifecycle


def test_media_card_has_stable_shared_compact_and_inspector_geometry() -> None:
    component = MEDIA_CARD.read_text(encoding="utf-8")
    css = MEDIA_CARD_CSS.read_text(encoding="utf-8")

    assert "MirrorOrderMediaCard" in component
    assert ".mo-media-card.is-compact { width: 180px; height: 88px; }" in css
    assert ".mo-media-card.is-inspector { width: min(300px, 100%); height: 124px; }" in css
    assert "grid-template-columns: 70px minmax(0, 1fr) 20px" in css
    assert "grid-template-columns: 136px minmax(0, 1fr) 20px" in css
    assert "border: 2px solid" not in css
    assert "mo-media-select" in component


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
    assert "showHistory" in status_center
    assert "currentTaskStates" in status_center
    for label in ("准备项目", "多机位同步", "增量素材分析", "剧本归集整理", "转写", "证据提取", "人物 / 声纹索引"):
        assert label in status_center
    assert not LEGACY_TASK_PANEL.exists()
    assert "后台任务、下载进度与失败恢复统一在“状态中心”查看" in settings


def test_settings_do_not_confuse_team_web_preferences_with_desktop_canvas() -> None:
    settings = SETTINGS.read_text(encoding="utf-8")

    assert "团队审阅偏好" in settings
    assert "这些选项只控制 Team Web，不改变 Desktop 场记画布" in settings
    assert ">默认视图<" in settings
    assert ">默认工作台<" not in settings
    assert "DesktopAppearanceControl" in settings
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


def test_product_shell_keeps_runtime_connection_chrome_secondary_to_global_navigation() -> None:
    app = APP.read_text(encoding="utf-8")

    assert 'className="app-workspace-menu"' in app
    assert 'className="app-workspace-chip"' in app
    assert 'className="workspace-advanced app-workspace-advanced"' in app
    assert ">高级连接<" in app
    assert "connection-panel" not in app
    assert 'className="app-global-topbar"' in app
    assert 'className="app-global-context"' in app
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
