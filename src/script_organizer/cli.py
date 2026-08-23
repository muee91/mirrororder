from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from pathlib import Path

from .agent_store import AgentTokenStore
from .analysis_runtime import analyze
from .automation_runtime import install_automation_runtime
from .device_media_runtime import install_device_media_runtime
from .runtime_diagnostics import environment_payload
from .fcpxml_exporter import export
from .local_vision_runtime import LocalVisionRuntime
from .media_identity import DeviceMediaStore
from .tasks import TaskManager
from .web_server import serve, serve_gateway
from .workspace import WorkspaceConfig, WorkspaceRegistry, ensure_workspace_id


def _workspace(value: str) -> WorkspaceConfig:
    candidate = Path(value).expanduser()
    if candidate.is_dir():
        candidate = candidate / "workspace.toml"
    return WorkspaceConfig.from_file(candidate)


def _project(workspace: WorkspaceConfig, project_id: str):
    return WorkspaceRegistry(workspace).project_config(project_id)


def _project_index(workspace: WorkspaceConfig, project_id: str) -> dict:
    config = _project(workspace, project_id)
    path = config.output_dir / "material_index.json"
    try:
        with path.open(encoding="utf-8") as handle:
            payload = json.load(handle)
        return payload if isinstance(payload, dict) else {}
    except (OSError, ValueError):
        return {}


def _submit_and_wait(workspace: WorkspaceConfig, project_id: str, task_type: str) -> int:
    manager = TaskManager(WorkspaceRegistry(workspace).project_config, workspace.workspace_id)
    task = manager.submit(project_id, task_type, {}, actor="cli")
    task_id = str(task.get("task_id", ""))
    terminal = {"completed", "failed", "cancelled", "interrupted"}
    while task.get("status") not in terminal:
        time.sleep(0.2)
        task = next((item for item in manager.list(project_id) if item.get("task_id") == task_id), task)
    print(json.dumps(task, ensure_ascii=False, indent=2))
    return 0 if task.get("status") == "completed" else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="script-organizer")
    subparsers = parser.add_subparsers(dest="command", required=True)

    analyze_parser = subparsers.add_parser("analyze", help="增量分析指定工作区项目")
    analyze_parser.add_argument("workspace", help="workspace.toml 或工作区目录")
    analyze_parser.add_argument("project_id", help="项目 ID")

    for command, help_text in (
        ("prepare", "自动完成同步、ASR、剧本匹配和低置信度救援"),
        ("multicam-sync", "只运行本地多机位音频同步并生成 FCPXML"),
        ("auto-resolve", "重新计算自动确认 / AI救援 / 人工异常队列"),
    ):
        task_parser = subparsers.add_parser(command, help=help_text)
        task_parser.add_argument("workspace", help="workspace.toml 或工作区目录")
        task_parser.add_argument("project_id", help="项目 ID")

    export_parser = subparsers.add_parser("export", help="导出指定工作区项目的审核清单")
    export_parser.add_argument("workspace", help="workspace.toml 或工作区目录")
    export_parser.add_argument("project_id", help="项目 ID")

    for command in ("serve", "run"):
        serve_parser = subparsers.add_parser(command, help="启动本地多项目工作台")
        serve_parser.add_argument("workspace", help="workspace.toml 或工作区目录")
        serve_parser.add_argument("--host", default="0.0.0.0")
        serve_parser.add_argument("--port", default=8765, type=int)
        serve_parser.add_argument("--local-only", action="store_true", help="仅允许本机访问")

    gateway_parser = subparsers.add_parser("gateway", help="启动多工作区局域网网关")
    gateway_parser.add_argument("workspace", nargs="+", help="一个或多个 workspace.toml 或工作区目录")
    gateway_parser.add_argument("--host", default="0.0.0.0")
    gateway_parser.add_argument("--port", default=8766, type=int)
    gateway_parser.add_argument("--local-only", action="store_true", help="仅允许本机访问")
    gateway_parser.add_argument("--trusted-lan", action="store_true", help="可信局域网免配对")
    gateway_parser.add_argument("--pairing-code", default="", help="指定局域网首次配对码")

    scan_parser = subparsers.add_parser("media-scan", help="为当前设备扫描并绑定本地素材副本")
    scan_parser.add_argument("workspace", help="workspace.toml 或工作区目录")
    scan_parser.add_argument("project_id", help="项目 ID")
    scan_parser.add_argument("root", nargs="+", help="一个或多个本机素材目录")

    scan_all_parser = subparsers.add_parser("media-scan-all", help="用同一素材目录扫描当前工作区所有项目")
    scan_all_parser.add_argument("workspace", help="workspace.toml 或工作区目录")
    scan_all_parser.add_argument("root", nargs="+", help="一个或多个本机素材目录")

    media_status_parser = subparsers.add_parser("media-status", help="查看当前设备的本地素材绑定状态")
    media_status_parser.add_argument("workspace", help="workspace.toml 或工作区目录")
    media_status_parser.add_argument("project_id", help="项目 ID")

    token_parser = subparsers.add_parser("agent-token-create", help="创建受限智能体令牌")
    token_parser.add_argument("workspace", help="workspace.toml 或工作区目录")
    token_parser.add_argument("project_id", help="仅允许访问的项目 ID")
    token_parser.add_argument("--name", default="local-agent")
    token_parser.add_argument("--scope", action="append", choices=("read", "analyze", "propose"))
    token_parser.add_argument("--expires-days", default=30, type=int)

    context_parser = subparsers.add_parser("agent-context", help="打印项目智能体约束与当前状态")
    context_parser.add_argument("workspace", help="workspace.toml 或工作区目录")
    context_parser.add_argument("project_id", help="项目 ID")

    doctor_parser = subparsers.add_parser("doctor", help="检查本机运行环境与工作区写权限")
    doctor_parser.add_argument("workspace", nargs="*", help="一个或多个 workspace.toml 或工作区目录")

    args = parser.parse_args(argv)
    if args.command == "doctor":
        paths = [str(_workspace(value).config_path.parent) for value in args.workspace]
        print(json.dumps(environment_payload([Path(value) for value in paths]), ensure_ascii=False, indent=2))
        return 0
    if args.command == "gateway":
        workspaces = [ensure_workspace_id(_workspace(value).config_path) for value in args.workspace]
        install_device_media_runtime()
        install_automation_runtime()
        previous_sigterm = signal.getsignal(signal.SIGTERM)

        def stop_gateway(_signum, _frame) -> None:
            raise KeyboardInterrupt

        signal.signal(signal.SIGTERM, stop_gateway)
        try:
            serve_gateway(
                workspaces,
                "127.0.0.1" if args.local_only else args.host,
                args.port,
                require_pairing=not args.trusted_lan,
                pairing_code=args.pairing_code or None,
            )
        finally:
            LocalVisionRuntime.stop()
            signal.signal(signal.SIGTERM, previous_sigterm)
        return 0

    workspace = ensure_workspace_id(_workspace(args.workspace).config_path)

    if args.command in {"serve", "run"}:
        install_device_media_runtime()
        install_automation_runtime()
        previous_sigterm = signal.getsignal(signal.SIGTERM)

        def stop_host(_signum, _frame) -> None:
            raise KeyboardInterrupt

        signal.signal(signal.SIGTERM, stop_host)
        try:
            serve(workspace, "127.0.0.1" if args.local_only else args.host, args.port)
        finally:
            LocalVisionRuntime.stop()
            signal.signal(signal.SIGTERM, previous_sigterm)
        return 0

    if args.command == "prepare":
        return _submit_and_wait(workspace, args.project_id, "prepare_project")
    if args.command == "multicam-sync":
        return _submit_and_wait(workspace, args.project_id, "multicam_sync")
    if args.command == "auto-resolve":
        return _submit_and_wait(workspace, args.project_id, "auto_resolve")

    if args.command == "media-scan":
        store = DeviceMediaStore()
        index = _project_index(workspace, args.project_id)
        summary = (
            store.scan(workspace.workspace_id, args.project_id, index, args.root)
            if index
            else store.probe_roots(workspace.workspace_id, args.project_id, args.root)
        )
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    if args.command == "media-scan-all":
        store = DeviceMediaStore()
        summaries = {}
        registry = WorkspaceRegistry(workspace)
        for entry in registry.list():
            project_id = str(entry.get("project_id", "") or "")
            if not project_id:
                continue
            index = _project_index(workspace, project_id)
            summaries[project_id] = (
                store.scan(workspace.workspace_id, project_id, index, args.root)
                if index
                else store.probe_roots(workspace.workspace_id, project_id, args.root)
            )
        print(json.dumps({"projects": summaries}, ensure_ascii=False, indent=2))
        return 0

    if args.command == "media-status":
        index = _project_index(workspace, args.project_id)
        summary = DeviceMediaStore().summary(workspace.workspace_id, args.project_id, index)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    if args.command == "analyze":
        config = _project(workspace, args.project_id)
        result = analyze(config)
        if config.is_media_directory:
            store = DeviceMediaStore()
            snapshot = store.project_snapshot(workspace.workspace_id, args.project_id)
            roots = snapshot.get("roots", []) if isinstance(snapshot, dict) else []
            if roots:
                store.scan(workspace.workspace_id, args.project_id, result["index"], roots)
        print(json.dumps(result["index"]["stats"], ensure_ascii=False))
        return 0

    if args.command == "export":
        print(json.dumps(export(_project(workspace, args.project_id)), ensure_ascii=False))
        return 0

    if args.command == "agent-token-create":
        WorkspaceRegistry(workspace).get(args.project_id)
        record, token = AgentTokenStore(workspace).create(
            args.name,
            [args.project_id],
            args.scope or ["read", "analyze", "propose"],
            args.expires_days,
        )
        print(json.dumps({"token": token, "record": record}, ensure_ascii=False))
        return 0

    if args.command == "agent-context":
        from .web_server import WorkspaceService

        install_device_media_runtime()
        install_automation_runtime()
        print(json.dumps(WorkspaceService(workspace).project(args.project_id).agent_context(), ensure_ascii=False, indent=2))
        return 0

    parser.error("未知命令")
    return 2


if __name__ == "__main__":
    sys.exit(main())
