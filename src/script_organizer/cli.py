from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .agent_store import AgentTokenStore
from .device_media_runtime import install_device_media_runtime
from .fcpxml_exporter import export
from .material_index import analyze
from .media_identity import DeviceMediaStore
from .web_server import serve
from .workspace import WorkspaceConfig, WorkspaceRegistry


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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="script-organizer")
    subparsers = parser.add_subparsers(dest="command", required=True)

    analyze_parser = subparsers.add_parser("analyze", help="增量分析指定工作区项目")
    analyze_parser.add_argument("workspace", help="workspace.toml 或工作区目录")
    analyze_parser.add_argument("project_id", help="项目 ID")

    export_parser = subparsers.add_parser("export", help="导出指定工作区项目的审核清单")
    export_parser.add_argument("workspace", help="workspace.toml 或工作区目录")
    export_parser.add_argument("project_id", help="项目 ID")

    for command in ("serve", "run"):
        serve_parser = subparsers.add_parser(command, help="启动本地多项目工作台")
        serve_parser.add_argument("workspace", help="workspace.toml 或工作区目录")
        serve_parser.add_argument("--host", default="0.0.0.0")
        serve_parser.add_argument("--port", default=8765, type=int)
        serve_parser.add_argument("--local-only", action="store_true", help="仅允许本机访问")

    scan_parser = subparsers.add_parser("media-scan", help="为当前设备扫描并绑定本地素材副本")
    scan_parser.add_argument("workspace", help="workspace.toml 或工作区目录")
    scan_parser.add_argument("project_id", help="项目 ID")
    scan_parser.add_argument("root", nargs="+", help="一个或多个本机素材目录")

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

    args = parser.parse_args(argv)
    workspace = _workspace(args.workspace)

    if args.command in {"serve", "run"}:
        install_device_media_runtime()
        serve(workspace, "127.0.0.1" if args.local_only else args.host, args.port)
        return 0

    if args.command == "media-scan":
        index = _project_index(workspace, args.project_id)
        if not index:
            raise SystemExit("项目还没有 material_index.json；请先在有源素材的机器完成 analyze")
        summary = DeviceMediaStore().scan(args.project_id, index, args.root)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    if args.command == "media-status":
        index = _project_index(workspace, args.project_id)
        summary = DeviceMediaStore().summary(args.project_id, index)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0

    if args.command == "analyze":
        result = analyze(_project(workspace, args.project_id))
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
        print(json.dumps(WorkspaceService(workspace).project(args.project_id).agent_context(), ensure_ascii=False, indent=2))
        return 0

    parser.error("未知命令")
    return 2


if __name__ == "__main__":
    sys.exit(main())
