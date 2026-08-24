from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def desktop_sources() -> tuple[str, str, str, str]:
    return (
        read("macos-app/MirrorOrderDesktopCore.swift"),
        read("macos-app/MirrorOrderDesktopUI.swift"),
        read("macos-app/NativeProjectWorkbench.swift"),
        read("macos-app/build_app.sh"),
    )


def test_macos_build_uses_native_production_workspace():
    core, ui, native, build = desktop_sources()
    assert 'CORE_SOURCE="$ROOT/macos-app/MirrorOrderDesktopCore.swift"' in build
    assert 'UI_SOURCE="$ROOT/macos-app/MirrorOrderDesktopUI.swift"' in build
    assert 'NATIVE_WORKBENCH_SOURCE="$ROOT/macos-app/NativeProjectWorkbench.swift"' in build
    assert '"$CORE_SOURCE" "$UI_SOURCE" "$NATIVE_WORKBENCH_SOURCE"' in build
    assert 'WindowGroup("镜序")' in ui
    assert "DesktopRootView()" in ui
    assert "NativeMulticamSlateProjectWorkbench(" in ui
    assert "NativeProjectWorkbench(" in ui
    assert "struct NativeProjectWorkbench: View" in native
    assert "NativeVideoPlayerView(player: player)" in native
    assert "struct NativeReviewReadModel: Decodable" in core


def test_native_production_canvas_never_embeds_team_web():
    _core, ui, native, _build = desktop_sources()
    for source in (ui, native):
        assert "DesktopWebView(" not in source
        assert "WKWebView" not in source
        assert "production_mode.js" not in source
        assert "timeline_v3.js" not in source
    assert 'Label("团队审阅", systemImage: "person.3")' in ui
    assert "controller.openInBrowser()" in ui


def test_desktop_service_start_script_saves_owned_gateway_pid():
    core, _ui, _native, _build = desktop_sources()
    assert "nohup" in core
    assert "pid=$!" in core
    assert 'echo "$pid"' in core
    assert "& &&" not in core
    assert '@Published var port = "8766"' in core
    assert "--pairing-code" in core
    assert 'appendingPathComponent("MirrorOrder/gateway"' in core
    assert "legacyPidFiles" in core
    assert 'command.contains("script-organizer gateway")' in core
    assert 'command.contains("--port \\(portNumber)")' in core
    assert "allWorkspacePaths.contains" in core
    assert "preferredProject(in workspace: GatewayWorkspace)" in core
    assert "Task.detached(priority: .utility)" in core


def test_desktop_shell_opens_on_project_home_then_native_multicam_slate():
    _core, ui, _native, _build = desktop_sources()
    assert "private struct ProductionSidebar" in ui
    assert "private struct SidebarProjectRow" in ui
    assert "private struct ProjectHomeView" in ui
    assert "private struct ProjectHomeCard" in ui
    assert '@Published var showProjectHome = true' in ui
    assert 'Text("全部项目")' in ui
    assert 'Text("最近项目")' in ui
    assert ".frame(width: 216)" in ui
    assert "ProjectWorkspace(" in ui
    assert "StatusCenterSheet" in ui
    assert "private struct NativeMulticamSlateProjectWorkbench" in ui
    assert 'Label("场记", systemImage: "tablecells")' in ui
    assert 'Label("素材 / 剧本", systemImage: "rectangle.split.3x1")' in ui
    assert 'Label("团队审阅", systemImage: "person.3")' in ui
    assert "ProjectInspector" not in ui
    assert "WorkbenchPage" not in ui


def test_native_slate_is_editable_multicam_table_not_dashboard_cards():
    _core, ui, _native, _build = desktop_sources()
    assert "Table(drafts, selection: $selectedRecordID)" in ui
    for column in ("序号", "场号", "镜号", "次号", "A 机", "B 机", "C 机", "辅助 / 特殊", "状态", "可用范围", "备注"):
        assert f'TableColumn("{column}")' in ui
    assert 'Label("从 Take 加入", systemImage: "film.stack")' in ui
    assert 'Label("新建场记", systemImage: "plus")' in ui
    assert 'Label(store.isSaving ? "保存中" : "保存", systemImage: "square.and.arrow.down")' in ui
    assert 'projectEndpoint(controller, "script-supervisor")' in ui
    assert 'projectEndpoint(controller, "script-supervisor-parse")' in ui
    assert '"expected_revision": board.revision' in ui
    assert '"actor": actor' in ui
    assert "UTType.fileURL.identifier" in ui
    assert "mcQuickMediaID(" in ui
    assert 'projectEndpoint(controller, "media-inventory")' in ui
    assert "I 设入点" in ui and "O 设出点" in ui
    assert "不是 Editorial Best" in ui
    assert "private struct MCMediaCard" in ui
    assert "AVAssetImageGenerator" in ui


def test_desktop_system_features_live_in_settings_and_status_center():
    _core, ui, _native, _build = desktop_sources()
    assert "private enum SettingsTab" in ui
    assert 'case general = "通用"' in ui
    assert 'case runtime = "运行与模型"' in ui
    assert 'case intelligence = "本地智能"' in ui
    assert 'case collaboration = "团队协作"' in ui
    assert 'case diagnostics = "诊断"' in ui
    assert "LocalRuntimeSettingsSection" in ui
    assert "RuntimeOverviewAndModelSettingsSection" in ui
    assert "FrontendSettingsSection" in ui
    assert "CollaborationAccessSection" in ui
    assert "同步、转写、识别和审计任务集中在这里" in ui


def test_desktop_gateway_probe_ignores_non_numeric_stats_extensions():
    core, _ui, _native, _build = desktop_sources()
    assert "private struct GatewayStats: Decodable" in core
    assert "try? container.decode(Int.self, forKey: key)" in core
    assert "var numericStats: [String: Int]" in core
    assert "let stats: [String: Int]?" not in core


def test_desktop_project_activity_uses_only_current_tasks():
    core, ui, _native, _build = desktop_sources()
    assert 'tasks.first(where: { $0.status == "queued" || $0.status == "running" }) {' in core
    assert 'tasks.first(where: { $0.status == "queued" || $0.status == "running" }) ?? tasks.first' not in core
    assert "filter(\\.isActive)" in ui


def test_native_workspace_reads_versioned_host_projection():
    core, ui, native, _build = desktop_sources()
    assert 'appendingPathComponent("review-model")' in core
    assert 'nextModel.contract_version == "review.v1"' in ui
    assert "JSONDecoder().decode(NativeReviewReadModel.self" in ui
    assert "JSONDecoder().decode(NativeReviewReadModel.self" in native
    assert "URLSession.shared.data(for: request)" in native


def test_desktop_has_native_project_creation_through_host_authority():
    core, ui, _native, _build = desktop_sources()
    runtime = read("src/script_organizer/automation_runtime.py")
    server = read("src/script_organizer/web_server.py")
    assert "private struct NewProjectSheet" in ui
    assert 'Text("原始素材").tag("media-directory")' in ui
    assert 'Text("已有对齐 FCPXML").tag("fcpxml")' in ui
    assert "controller.preflightProject" in ui
    assert "controller.createProject" in ui
    assert 'workspaceEndpoint("project-preflight")' in core
    assert 'workspaceEndpoint("projects")' in core
    assert '"media_roots": roots' in core
    assert "func startProject(_ project: GatewayProject)" in core
    assert "func deleteProject(_ project: GatewayProject)" in core
    assert 'projectEndpoint(project.project_id, "tasks")' in core
    assert 'projectEndpoint(project.project_id, "delete")' in core
    assert 'rest == ["delete"]' in server
    assert 'parts == ["api", "v1", "project-preflight"]' in runtime
    assert "self._local_only()" in runtime
    assert "def create_and_prepare" in runtime
    assert 'result["prepare_task_id"]' in runtime


def test_desktop_controls_have_stable_hit_targets():
    _core, ui, native, _build = desktop_sources()
    runtime = read("macos-app/LocalRuntimeSettingsView.swift")
    assert "struct AppHitTarget: ViewModifier" in ui
    assert "func appHitTarget(minWidth: CGFloat = 40, minHeight: CGFloat = 36)" in ui
    assert ".contentShape(Rectangle())" in ui
    assert ".appHitTarget(minWidth: 32, minHeight: 32)" in native
    assert ".frame(width: 44, height: 40)" in runtime


def test_team_web_remains_separate_review_client():
    html = read("web/index.html")
    ui = read("macos-app/MirrorOrderDesktopUI.swift")
    core = read("macos-app/MirrorOrderDesktopCore.swift")
    assert 'id="workspace-select"' in html
    assert 'id="project-select"' in html
    assert 'id="production-bar"' not in html
    assert 'id="production-panel"' not in html
    assert 'Label("团队审阅", systemImage: "person.3")' in ui
    assert "controller.openInBrowser()" in ui
    assert "NSWorkspace.shared.open(workbenchURL(for: projectID))" in core


def test_desktop_can_scan_this_macs_media_without_writing_shared_paths():
    core = read("macos-app/MirrorOrderDesktopCore.swift")
    ui = read("macos-app/MirrorOrderDesktopUI.swift")
    cli = read("src/script_organizer/cli.py")
    identity = read("src/script_organizer/media_identity.py")
    runtime = read("src/script_organizer/device_media_runtime.py")
    assert "chooseLocalMediaRoot(replace: true)" in ui
    assert '"--replace"' in core
    assert 'scanAll ? "media-scan-all" : "media-scan"' in core
    assert "workspacePaths" in core
    assert 'subparsers.add_parser("media-scan-all"' in cli
    assert '"Application Support" / "MirrorOrder"' in identity
    assert 'item["source_media_path"]' in runtime
    assert 'item["resolved_media_path"]' in runtime
    assert 'item["media_path"] = resolved or source_path' in runtime
    assert 'projectEndpoint(controller, "media-inventory")' in ui
    assert '"source_media_path"' not in ui
    assert '"resolved_media_path"' not in ui


def test_build_packages_complete_runtime_and_team_web_tree():
    _core, _ui, _native, build = desktop_sources()
    assert 'rsync -a --exclude \'__pycache__\' --exclude \'*.pyc\' "$ROOT/src/" "$RUNTIME/src/"' in build
    assert 'cp -R "$ROOT/web" "$RUNTIME/web"' in build
    assert 'cp "$INFO" "$APP/Contents/Info.plist"' in build


def test_sync_contract_keeps_device_paths_outside_shared_workspace():
    sync = read("SYNC_MODEL.md")
    agents = read("AGENTS.md")
    assert "media-bindings.json" in sync
    assert "不得放进共享 workspace" in sync
    assert "review.json" in sync
    assert "单一写入权威" in sync
    assert "绝对路径不是共享身份" in agents
