from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_tauri_main_registers_separate_production_and_team_process_managers() -> None:
    main = read("desktop/src-tauri/src/main.rs")

    assert "mod host;" in main
    assert "mod gateway;" in main
    assert ".manage(gateway::GatewayManager::default())" in main
    assert ".manage(host::HostManager::default())" in main
    assert "host::start_python_host" in main
    assert "gateway::start_team_gateway" in main


def test_production_host_is_loopback_and_readiness_gated() -> None:
    host = read("desktop/src-tauri/src/host.rs")

    assert 'format!("http://127.0.0.1:{port}")' in host
    assert '.arg("serve")' in host
    assert '.arg("--local-only")' in host
    assert "wait_until_ready" in host
    assert 'const HOST_SERVICE: &str = "mirrororder-host"' in host
    assert "probe_service" in host
    assert "status=ok" not in host
    assert "Python Host 在健康检查通过前退出" in host


def test_team_gateway_has_separate_network_security_contract() -> None:
    gateway = read("desktop/src-tauri/src/gateway.rs")

    assert '.arg("gateway")' in gateway
    assert '.arg("--local-only")' in gateway
    assert '.arg("--trusted-lan")' in gateway
    assert '.arg("--pairing-code")' in gateway
    assert "wait_until_ready" in gateway
    assert "Team Web Gateway 在健康检查通过前退出" in gateway
    assert 'const GATEWAY_SERVICE: &str = "mirrororder-gateway"' in gateway
    assert "probe_service" in gateway
    assert "local_lan_address" in gateway
    assert "lan_url" in gateway


def test_team_web_is_not_embedded_in_project_workbench() -> None:
    app = read("desktop/src/app/App.tsx")
    project = read("desktop/src/features/production/ProjectWorkbench.tsx")

    assert 'type AppSurface = "home" | "projects" | "production" | "status" | "team" | "settings"' in app
    assert "TeamWebWorkbench" in app
    assert 'surface === "team"' in app
    assert "TeamWebWorkbench" not in project
    assert 'label: "团队协作"' not in project


def test_desktop_project_lifecycle_delegates_to_python_authority() -> None:
    ui = read("desktop/src/features/projects/ProjectLifecyclePanel.tsx")
    app = read("desktop/src/app/App.tsx")
    client = read("desktop/src/api/desktop.ts")
    runtime = read("src/script_organizer/desktop_runtime.py")

    assert "client.preflightProject(payload())" in ui
    assert "client.createProject(payload())" in ui
    assert "client.prepareProject(created.project_id)" in ui
    assert "new DesktopClient(snapshot.baseUrl).deleteProject(project.project_id)" in app
    assert "永久删除项目" in app
    assert "原始媒体、剧本与 FCPXML 不会删除" in app
    assert "/api/v1/projects/preflight" in client
    assert "current.registry.preflight_create" in runtime


def test_desktop_project_navigation_matches_workspace_authority() -> None:
    workbench = read("desktop/src/features/production/ProjectWorkbench.tsx")
    resume = read("desktop/src/app/resumeState.ts")
    library = read("desktop/src/features/projects/ProjectLibrary.tsx")
    material = read("desktop/src/features/material/MaterialWorkspace.tsx")
    material_take = read("desktop/src/features/material/MaterialTakeView.tsx")
    script = read("desktop/src/features/script/ScriptWorkspace.tsx")
    script_block = read("desktop/src/features/material-script/ScriptBlock.tsx")
    review = read("desktop/src/features/review/ReviewWorkspace.tsx")

    assert "safeProductionPage(readProjectPage(project.project_id))" in workbench
    assert "MaterialWorkspace" in workbench
    assert "ScriptWorkspace" in workbench
    assert "ReviewWorkspace" in workbench
    assert "MaterialScriptWorkbench" not in workbench
    assert 'surface="takes"' not in workbench
    assert 'surface="script"' not in workbench
    assert 'surface="review"' not in workbench
    assert 'type ProductionArea = "material" | "script" | "timeline" | "review"' in workbench
    assert 'className="professional-project-toolbar"' in workbench
    assert 'aria-label="制作区域"' in workbench
    assert 'const showSecondaryNavigation = area !== "material"' in workbench
    for label in ("素材", "剧本", "时间线", "审阅"):
        assert f'label: "{label}"' in workbench
    for page, label in (
        ("slate", "场记"),
        ("media-library", "素材库"),
        ("takes", "Take"),
        ("identity", "人物"),
        ("script", "剧本"),
        ("timeline", "时间线"),
        ("delivery", "交付"),
        ("watch", "看片"),
    ):
        assert f'{{ page: "{page}", label: "{label}" }}' in workbench
    assert '{ page: "coverage", label: "覆盖"' not in workbench
    assert '{ page: "media-binding", label: "本机素材", hidden: true }' in workbench
    assert '{ page: "attention",' not in workbench
    assert '{ page: "overview",' not in workbench
    assert 'page === "coverage"' in resume
    assert 'return "script"' in resume
    assert 'page === "attention" || page === "overview"' in resume
    assert 'return "watch"' in resume
    assert 'page === "rough-cut" || page === "assembly"' in resume
    assert 'return "timeline"' in resume
    assert ">小镜</button>" in workbench
    assert "TimelineWorkbench" in workbench
    assert "CoverageWorkbench" not in workbench
    assert "ReviewAttentionWorkbench" not in workbench
    assert "ProjectOverviewWorkbench" not in workbench
    assert "RoughCutWorkbench" not in workbench
    assert "AssemblyWorkbench" not in workbench

    assert 'export type MaterialView = "slate" | "library" | "takes" | "people" | "repair"' in material
    assert 'aria-label="素材视图"' in material
    assert "GoldenSlateWorkbench" in material
    assert "MediaLibraryWorkbench" in material
    assert "MaterialTakeView" in material
    assert "IdentityWorkbench" in material
    assert "MediaBindingWorkbench" in material
    assert 'onOpenMediaBinding={() => onViewChange("repair")}' in material
    assert "setGroupPlacement" not in material
    assert "setGroupPlacement" not in material_take
    assert "showEditorial" not in material_take
    assert "production.scriptSupervisor(project.project_id)" in material_take
    assert ">在剧本中打开</button>" in material_take
    assert ">在审阅中打开</button>" in material_take
    assert ">到时间线</button>" in material_take
    assert ">修复本机素材</button>" in material_take

    assert "ScriptProjectionMode" in script
    assert '{ value: "script", label: "正文" }' in script
    assert '{ value: "coverage", label: "覆盖" }' in script
    assert '{ value: "issues", label: "问题" }' in script
    assert 'placeholder="搜索剧本、角色或场景"' in script
    assert "placeTakeOnSelectedBlock" in script
    assert 'actionLabel={mappedHere ? "查看" : "归集到此段"}' in script
    assert "connection.setGroupPlacement" in script
    assert "connection.clearGroupPlacement" in script
    assert "onOpenCoverage" not in script
    assert 'data-script-projection={projectionMode}' in script_block
    assert "mappedTakeIds" in script_block
    assert "candidateTakeIds" in script_block

    assert "showEditorial" in review
    assert "setGroupPlacement" not in review
    assert 'onOpenTimeline={(groupId) => focusTake(groupId, "timeline")}' in workbench
    assert 'aria-label="当前项目制作导航"' not in library
    assert 'onClick={() => openPage("watch")}' not in library
    assert "制作区在项目画布顶部切换。" in library


def test_team_web_remains_a_separate_review_client() -> None:
    html = read("web/index.html")
    app = read("desktop/src/app/App.tsx")

    assert 'id="workspace-select"' in html
    assert 'id="project-select"' in html
    assert 'id="production-bar"' not in html
    assert "TeamWebWorkbench" in app


def test_swiftui_build_chain_is_no_longer_part_of_main() -> None:
    assert not (ROOT / "macos-app").exists()
    ci = read(".github/workflows/ci.yml")
    assert "macos-app-smoke" not in ci
    assert "macos-app/build_app.sh" not in ci
