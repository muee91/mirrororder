from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .agent_store import AgentTokenStore
from .fcpxml_exporter import export
from .material_index import analyze
from .web_server import serve
from .workspace import WorkspaceConfig, WorkspaceRegistry


def _workspace(value: str) -> WorkspaceConfig:
    candidate = Path(value).expanduser()
    if candidate.is_dir():
        candidate = candidate / "workspace.toml"
    return WorkspaceConfig.from_file(candidate)


def _project(workspace: WorkspaceConfig, project_id: str):
    return WorkspaceRegistry(workspace).project_config(project_id)


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
        serve(workspace, "127.0.0.1" if args.local_only else args.host, args.port)
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

        print(json.dumps(WorkspaceService(workspace).project(args.project_id).agent_context(), ensure_ascii=False, indent=2))
        return 0

    parser.error("未知命令")
    return 2


if __name__ == "__main__":
    sys.exit(main())
