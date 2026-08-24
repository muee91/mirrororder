from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def desktop_sources() -> tuple[str, str, str]:
    return (
        read("macos-app/MirrorOrderDesktopCore.swift"),
        read("macos-app/MirrorOrderDesktopUI.swift"),
        read("macos-app/build_app.sh"),
    )


def test_macos_build_uses_split_drag_capable_desktop_shell():
    core, ui, build = desktop_sources()
    assert 'CORE_SOURCE="$ROOT/macos-app/MirrorOrderDesktopCore.swift"' in build
    assert 'UI_SOURCE="$ROOT/macos-app/MirrorOrderDesktopUI.swift"' in build
    assert '"$CORE_SOURCE" "$UI_SOURCE"' in build
    assert "WKScriptMessageHandler" in core
    assert 'name: "mirrorOrder"' in core
    assert "NSDraggingSession" in core
    assert "NSDraggingItem" in core
    assert ".fileURL" in core
    assert 'NSFilenamesPboardType' in core
    assert 'WindowGroup("镜序")' in ui
    assert "DesktopRootView()" in ui


def test_desktop_service_start_script_saves_owned_gateway_pid():
    core, _ui, _build = desktop_sources()
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


def test_desktop_shell_keeps_projects_persistent_in_left_sidebar():
    _core, ui, _build = desktop_sources()
    native = read("macos-app/NativeProjectWorkbench.swift")
    assert "private struct ProductionSidebar" in ui
    assert "private struct SidebarProjectRow" in ui
    assert ".frame(width: 224)" in ui
    assert "ProjectWorkspace(" in ui
    assert "controller: controller" in ui
    assert "StatusCenterSheet" in ui
    assert "项目常驻左栏" in ui
    assert "ProjectInspector" not in ui
    assert "ProjectPage" not in ui
    assert "WorkbenchPage" not in ui
    assert 'Button("场记") { showSupervisor = true }' in native
    assert 'Button("团队审阅") { controller.openInBrowser() }' in native
    assert 'WindowGroup("镜序")' in ui


def test_desktop_system_features_live_in_settings_and_status_center():
    _core, ui, _build = desktop_sources()
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
    core, _ui, _build = desktop_sources()
    assert "private struct GatewayStats: Decodable" in core
    assert "try? container.decode(Int.self, forKey: key)" in core
    assert "var numericStats: [String: Int]" in core
    assert "let stats: [String: Int]?" not in core


def test_desktop_project_activity_uses_only_current_tasks():
    core, ui, _build = desktop_sources()
    assert 'tasks.first(where: { $0.status == "queued" || $0.status == "running" }) {' in core
    assert 'tasks.first(where: { $0.status == "queued" || $0.status == "running" }) ?? tasks.first' not in core
    assert "filter(\\.isActive)" in ui


def test_desktop_webview_recovers_navigation_failures_and_reports_runtime_errors():
    core, _ui, _build = desktop_sources()
    assert "defaultWebpagePreferences.allowsContentJavaScript = true" in core
    assert "decidePolicyFor navigationAction" in core
    assert "decisionHandler(.allow, preferences)" in core
    assert "WKNavigationDelegate" in core
    assert "didFailProvisionalNavigation" in core
    assert "reloadFromOrigin()" in core
    assert "runtimeError" in core
    assert "unhandledrejection" in core
    assert "mirrororder-runtime-error" in core
    assert "var isLoading = false" in core
    assert "if !context.coordinator.isLoading" in core


def test_desktop_has_native_project_creation_through_host_authority():
    core, ui, _build = desktop_sources()
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
    _core, ui, _build = desktop_sources()
    runtime = read("macos-app/LocalRuntimeSettingsView.swift")
    assert "struct AppHitTarget: ViewModifier" in ui
    assert "func appHitTarget(minWidth: CGFloat = 40, minHeight: CGFloat = 36)" in ui
    assert ".contentShape(Rectangle())" in ui
    assert ".frame(width: 44, height: 40)" in runtime


def test_timeline_loader_is_app_only_and_drops_legacy_automation_bundle():
    html = read("web/index.html")
    loader = read("web/timeline.js")
    timeline = read("web/timeline_v3.js")
    ux = read("web/ux_fixes.js")
    production = read("web/production_mode.js")
    css = read("web/timeline.css")

    assert '<script src="/device_media.js"></script>' in html
    assert '<script src="/timeline.js"></script>' in html
    assert "document.createElement('script')" not in ux
    assert "window.webkit?.messageHandlers?.mirrorOrder" in loader
    assert "window.__mirrorOrderTimelineReady" in loader
    assert "/timeline_v3.js" in loader
    assert "/device_media.js" not in loader
    assert "/automation.js" not in loader
    assert "['timeline', '时间线']" in production
    assert "timelineToggle" in production
    assert "html.native-production #timeline-toggle" in css
    assert "media-rep" in timeline
    assert "placementForGroup" in timeline
    assert "manualScriptIds" in timeline
    assert "dragPath" in timeline
    assert "未关联" in timeline


def test_external_drag_is_native_not_html5_datatransfer():
    timeline = read("web/timeline_v3.js")
    core = read("macos-app/MirrorOrderDesktopCore.swift")
    assert "dataTransfer" not in timeline
    assert "beginDraggingSession" in core
    assert "prepareFileDrag" in timeline
    assert "prepareFileDrag" in core


def test_team_web_does_not_activate_production_timeline():
    loader = read("web/timeline.js")
    assert "if (!window.webkit?.messageHandlers?.mirrorOrder)" in loader
    assert "window.__mirrorOrderTimelineReady = Promise.resolve()" in loader
    assert "return;" in loader


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


def test_build_packages_complete_runtime_and_web_tree():
    _core, _ui, build = desktop_sources()
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
