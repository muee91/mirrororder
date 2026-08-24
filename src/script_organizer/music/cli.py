from __future__ import annotations

import argparse
import json
from pathlib import Path

from ..workspace import WorkspaceConfig, WorkspaceRegistry, ensure_workspace_id
from .library import index_music_library
from .runtime import build_music_plan


def _workspace(value: str) -> WorkspaceConfig:
    candidate = Path(value).expanduser()
    if candidate.is_dir():
        candidate = candidate / "workspace.toml"
    return ensure_workspace_id(candidate)


def _analysis_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--analysis",
        choices=("off", "basic", "auto"),
        default="auto",
        help="off=仅元数据；basic=ffmpeg能量/结构；auto=basic + 可选 Beat This",
    )
    parser.add_argument(
        "--force-analysis",
        action="store_true",
        help="忽略设备本地音乐分析缓存并重新分析",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mirrororder-auto-score")
    subparsers = parser.add_subparsers(dest="command", required=True)

    index_parser = subparsers.add_parser("index", help="扫描本地音乐库并输出授权/音频分析索引")
    index_parser.add_argument("music_root", help="本地音乐库目录")
    index_parser.add_argument("--output", help="可选 JSON 输出路径")
    _analysis_args(index_parser)

    plan_parser = subparsers.add_parser("plan", help="为镜序项目生成 auto-score.v1 配乐计划")
    plan_parser.add_argument("workspace", help="workspace.toml 或工作区目录")
    plan_parser.add_argument("project_id", help="项目 ID")
    plan_parser.add_argument("music_root", help="本地音乐库目录")
    plan_parser.add_argument("--episode", type=int, help="只规划指定集")
    plan_parser.add_argument("--timeline-seconds", type=float, help="该集/计划目标时长；当前按剧本权重分配 cue")
    plan_parser.add_argument("--top-k", type=int, default=5, help="每个 cue 保留候选数量")
    plan_parser.add_argument(
        "--allow-unverified",
        action="store_true",
        help="开发测试：允许未验证授权音乐进入候选；正式项目不建议使用",
    )
    _analysis_args(plan_parser)

    args = parser.parse_args(argv)
    if args.command == "index":
        payload = index_music_library(
            args.music_root,
            analysis_mode=args.analysis,
            force_analysis=args.force_analysis,
        )
        if args.output:
            output = Path(args.output).expanduser().resolve()
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    workspace = _workspace(args.workspace)
    config = WorkspaceRegistry(workspace).project_config(args.project_id)
    plan = build_music_plan(
        config,
        args.music_root,
        episode=args.episode,
        timeline_seconds=args.timeline_seconds,
        top_k=args.top_k,
        allow_unverified=args.allow_unverified,
        analysis_mode=args.analysis,
        force_analysis=args.force_analysis,
    )
    print(json.dumps(plan["summary"], ensure_ascii=False, indent=2))
    print(str(config.output_dir / "music" / "music_plan.json"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
