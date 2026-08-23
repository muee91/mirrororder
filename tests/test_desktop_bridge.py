from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_macos_build_uses_drag_capable_desktop_shell():
    build = read("macos-app/build_app.sh")
    source = read("macos-app/MirrorOrderDesktopApp.swift")

    assert 'SOURCE="$ROOT/macos-app/MirrorOrderDesktopApp.swift"' in build
    assert "WKScriptMessageHandler" in source
    assert 'name: "mirrorOrder"' in source
    assert "NSDraggingSession" in source
    assert "NSDraggingItem" in source
    assert ".fileURL" in source
    assert 'NSFilenamesPboardType' in source


def test_desktop_service_start_script_saves_pid_after_background_launch():
    source = read("macos-app/MirrorOrderDesktopApp.swift")

    assert "nohup" in source
    assert "pid=$!" in source
    assert 'echo "$pid"' in source
    assert "& &&" not in source
    assert '@Published var port = "8766"' in source
    assert "gateway" in source
    assert "--pairing-code" in source
    assert 'appendingPathComponent("MirrorOrder/gateway"' in source
    assert 'var pidFile: URL { gatewayStateRoot.appendingPathComponent' in source
    assert "legacyPidFiles" in source
    assert 'command.contains("script-organizer gateway")' in source
    assert 'command.contains("--port \\(portNumber)")' in source
    assert "allWorkspacePaths.contains" in source
    assert "preferredProject(in workspace: GatewayWorkspace)" in source
    assert 'private let selectionExplicitKey = "selectionExplicit"' in source
    assert "selectionExplicit" in source
    assert "lanAddress = \"\"" in source
    assert "lanAddress = await Self.currentLANAddress()" in source
    assert "Task.detached(priority: .utility)" in source
    assert 'WindowGroup("镜序")' in source
    assert "DesktopRootView()" in source
    assert "Settings { EmptyView() }" not in source


def test_desktop_navigation_is_project_first_and_system_features_live_in_settings():
    source = read("macos-app/MirrorOrderDesktopApp.swift")

    assert "enum ConsoleSection" in source
    assert "case projects" in source
    assert "case workbench" in source
    assert '@Published var section: ConsoleSection = .projects' in source
    for removed_top_level in ("case overview", "case service", "case workspaces", "case models", "case frontend", "case agent"):
        assert removed_top_level not in source

    assert "struct ProjectPage" in source
    assert "struct WorkbenchPage" in source
    assert "struct SettingsSheet" in source
    assert 'case general = "通用"' in source
    assert 'case intelligence = "本地智能"' in source
    assert 'case collaboration = "团队协作"' in source
    assert 'case diagnostics = "诊断"' in source
    assert "LocalRuntimeSettingsSection" in source
    assert "FrontendSettingsSection" in source

    assert "private var lastStoppedGatewayPID: Int32?" in source
    assert "private func waitForStoppedGateway() async" in source
    assert "await waitForStoppedGateway()" in source
    assert "statusText = \"正在应用服务配置\"" in source


def test_desktop_gateway_probe_ignores_non_numeric_stats_extensions():
    source = read("macos-app/MirrorOrderDesktopApp.swift")

    assert "private struct GatewayStats: Decodable" in source
    assert "try? container.decode(Int.self, forKey: key)" in source
    assert "var numericStats: [String: Int]" in source
    assert "let stats: [String: Int]?" not in source


def test_desktop_has_native_project_creation_through_host_authority():
    source = read("macos-app/MirrorOrderDesktopApp.swift")
    runtime = read("src/script_organizer/automation_runtime.py")
    server = read("src/script_organizer/web_server.py")

    assert 'Label("新建项目", systemImage: "plus")' in source
    assert "struct NewProjectSheet" in source
    assert 'workspaceEndpoint("project-preflight")' in source
    assert 'workspaceEndpoint("projects")' in source
    assert '"input_kind": inputKind' in source
    assert '"media_root": mediaRoot' in source
    assert '"script": script' in source
    assert "prepare_task_id" in source
    assert "func startProject(_ project: GatewayProject)" in source
    assert "func deleteProject(_ project: GatewayProject)" in source
    assert 'projectEndpoint(project.project_id, "tasks")' in source
    assert 'projectEndpoint(project.project_id, "delete")' in source
    assert '"开始项目整理"' in source
    assert '"重新开始项目整理"' in source
    assert 'Label("删除项目", systemImage: "trash")' in source
    assert '.alert(item: $state.deleteProject)' in source
    assert "let progress: [String: Int]?" in source
    assert "let logs: [String]?" in source
    assert "private func startTaskPolling" in source
    assert "整理任务进度" in source
    assert 'Text("已有对齐 FCPXML").tag("fcpxml")' in source
    assert 'Button("选择目录…")' in source
    assert '"media_roots": roots' in source
    assert 'rest == ["delete"]' in server

    # Host remains the authority: preflight is local-only and create is wrapped
    # to submit prepare_project automatically.
    assert 'parts == ["api", "v1", "project-preflight"]' in runtime
    assert "self._local_only()" in runtime
    assert "def create_and_prepare" in runtime
    assert '"prepare_project"' in runtime
    assert 'result["prepare_task_id"]' in runtime
    assert 'self._rewrite(parsed, "/api/v1/projects")' in server


def test_desktop_controls_have_stable_hit_targets():
    source = read("macos-app/MirrorOrderDesktopApp.swift")
    runtime = read("macos-app/LocalRuntimeSettingsView.swift")

    assert "private struct AppHitTarget: ViewModifier" in source
    assert "func appHitTarget(minWidth: CGFloat = 44, minHeight: CGFloat = 40)" in source
    assert ".frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)" in source
    assert ".appHitTarget()" in source
    assert ".appHitTarget(minWidth: 40, minHeight: 34)" in source
    assert ".appHitTarget(minWidth: 230, minHeight: 40)" in source
    assert ".frame(width: 44, height: 40)" in runtime
    assert ".contentShape(Rectangle())" in runtime


def test_web_loader_uses_review_aware_timeline_v3_only():
    loader = read("web/timeline.js")
    timeline = read("web/timeline_v3.js")

    assert "/timeline_v3.js" in loader
    assert "/device_media.js" in loader
    assert "timeline_v2" not in loader
    assert "media-rep" in timeline
    assert "placementForGroup" in timeline
    assert "manualScriptIds" in timeline
    assert "dragPath" in timeline
    assert "未关联" in timeline


def test_external_drag_is_native_not_html5_datatransfer():
    timeline = read("web/timeline_v3.js")
    source = read("macos-app/MirrorOrderDesktopApp.swift")

    assert "dataTransfer" not in timeline
    assert "beginDraggingSession" in source
    assert "prepareFileDrag" in timeline
    assert "prepareFileDrag" in source


def test_timeline_extension_is_installed_from_review_workbench():
    ux = read("web/ux_fixes.js")
    assert "'/timeline.js'" in ux or '"/timeline.js"' in ux


def test_desktop_can_scan_this_macs_media_without_writing_shared_paths():
    source = read("macos-app/MirrorOrderDesktopApp.swift")
    cli = read("src/script_organizer/cli.py")
    identity = read("src/script_organizer/media_identity.py")
    runtime = read("src/script_organizer/device_media_runtime.py")

    assert "替换并扫描本机素材目录" in source
    assert 'controller.chooseLocalMediaRoot(replace: true)' in source
    assert '"--replace"' in source
    assert 'scanAll ? "media-scan-all" : "media-scan"' in source
    assert "workspacePaths" in source
    assert "media-scan-all" in source
    assert "扫描当前项目库全部项目" in source
    assert 'subparsers.add_parser("media-scan-all"' in cli
    assert '"Application Support" / "MirrorOrder"' in identity
    assert 'item["source_media_path"]' in runtime
    assert 'item["resolved_media_path"]' in runtime
    assert 'item["media_path"] = resolved or source_path' in runtime


def test_sync_contract_keeps_device_paths_outside_shared_workspace():
    sync = read("SYNC_MODEL.md")
    agents = read("AGENTS.md")

    assert "media-bindings.json" in sync
    assert "不得放进共享 workspace" in sync
    assert "review.json" in sync
    assert "单一写入权威" in sync
    assert "绝对路径不是共享身份" in agents
