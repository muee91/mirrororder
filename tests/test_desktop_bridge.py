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
    assert "status=ok" not in host  # parsed by the shared HTTP health probe
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

    assert 'type AppSurface = "production" | "status" | "team" | "settings"' in app
    assert "TeamWebWorkbench" in app
    assert "TeamWebWorkbench" not in project
    assert 'label: "团队协作"' not in project


def test_desktop_project_lifecycle_delegates_to_python_authority() -> None:
    ui = read("desktop/src/features/projects/ProjectLifecyclePanel.tsx")
    client = read("desktop/src/api/desktop.ts")
    runtime = read("src/script_organizer/desktop_runtime.py")

    assert "client.preflightProject(payload())" in ui
    assert "client.createProject(payload())" in ui
    assert "client.prepareProject(created.project_id)" in ui
    assert "client.deleteProject(selectedProject.project_id)" in ui
    assert "移除前必须完整输入当前项目 ID" in ui
    assert "/api/v1/projects/preflight" in client
    assert "current.registry.preflight_create" in runtime


def test_desktop_project_tabs_are_explicit_product_surfaces() -> None:
    workbench = read("desktop/src/features/production/ProjectWorkbench.tsx")

    for label in ("素材", "剧本", "剪辑", "审阅"):
        assert f'label: "{label}"' in workbench
    assert "project-workbench-primary" in workbench
    assert ">小镜</button>" in workbench
    assert "onOpenTake={openTakeFromEvidence}" in workbench
    assert "initialGroupId={materialFocusGroupId}" in workbench


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
