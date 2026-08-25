from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_tauri_main_registers_separate_production_and_team_process_managers() -> None:
    main = read("desktop-v2/src-tauri/src/main.rs")

    assert "mod host;" in main
    assert "mod gateway;" in main
    assert ".manage(host::HostManager::default())" in main
    assert ".manage(gateway::GatewayManager::default())" in main
    assert "host::start_python_host" in main
    assert "gateway::start_team_gateway" in main


def test_production_host_is_loopback_and_readiness_gated() -> None:
    host = read("desktop-v2/src-tauri/src/host.rs")

    assert 'format!("http://127.0.0.1:{port}")' in host
    assert 'arg("serve")' in host
    assert 'arg("--local-only")' in host
    assert "wait_until_ready" in host
    assert "TcpStream::connect_timeout" in host
    assert "Python Host 在监听端口前退出" in host


def test_team_gateway_has_separate_network_security_contract() -> None:
    gateway = read("desktop-v2/src-tauri/src/gateway.rs")

    assert 'arg("gateway")' in gateway
    assert 'arg("--local-only")' in gateway
    assert 'arg("--trusted-lan")' in gateway
    assert 'arg("--pairing-code")' in gateway
    assert "wait_until_ready" in gateway
    assert "Team Web Gateway 在监听端口前退出" in gateway
    assert "local_only_never_exposes_lan_url" in gateway


def test_team_web_is_not_embedded_in_project_workbench() -> None:
    app = read("desktop-v2/src/app/App.tsx")
    project = read("desktop-v2/src/features/production/ProjectWorkbench.tsx")

    assert 'type AppWorkspace = "production" | "team"' in app
    assert "TeamWebWorkbench" in app
    assert "TeamWebWorkbench" not in project
    assert 'label: "团队协作"' not in project


def test_desktop_project_lifecycle_delegates_to_python_authority() -> None:
    ui = read("desktop-v2/src/features/projects/ProjectLifecyclePanel.tsx")
    client = read("desktop-v2/src/api/desktop.ts")
    runtime = read("src/script_organizer/desktop_runtime.py")

    assert "client.preflightProject(payload())" in ui
    assert "client.createProject(payload())" in ui
    assert "client.prepareProject(created.project_id)" in ui
    assert "client.deleteProject(selectedProject.project_id)" in ui
    assert "删除前必须完整输入当前 project_id" in ui
    assert "project-preflight" in client
    assert "prepare" in client
    assert "WorkspaceRegistry" in runtime


def test_desktop_project_tabs_are_explicit_product_surfaces() -> None:
    workbench = read("desktop-v2/src/features/production/ProjectWorkbench.tsx")

    for label in ("素材 / 剧本", "场记", "人物", "小镜", "剪辑", "交付", "本机素材", "设置 / 状态"):
        assert f'label: "{label}"' in workbench
    assert "onOpenTake={openTakeFromEvidence}" in workbench
    assert "initialGroupId={materialFocusGroupId}" in workbench


def test_team_web_remains_a_separate_review_client() -> None:
    html = read("web/index.html")
    app = read("desktop-v2/src/app/App.tsx")

    assert 'id="workspace-select"' in html
    assert 'id="project-select"' in html
    assert 'id="production-bar"' not in html
    assert "TeamWebWorkbench" in app


def test_swiftui_build_chain_is_no_longer_part_of_main() -> None:
    assert not (ROOT / "macos-app").exists()
    ci = read(".github/workflows/ci.yml")
    assert "macos-app-smoke" not in ci
    assert "macos-app/build_app.sh" not in ci
