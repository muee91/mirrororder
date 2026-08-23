from __future__ import annotations

import argparse
import json
import sys
from threading import Event, Thread
from typing import Any

from .config import ProjectConfig
from .identity_index import IdentityIndexer


def _emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def _listen_for_cancellation(cancelled: Event) -> None:
    for line in sys.stdin:
        if line.strip() == "cancel":
            cancelled.set()
            return


def _pending_total(indexer: IdentityIndexer, kind: str, group_ids: list[str]) -> int | None:
    """Report a truthful initial total before the first expensive inference."""

    index = indexer._index()
    if not index:
        return None
    groups = indexer._groups(index)
    requested = set(group_ids)
    if requested:
        return sum(
            1
            for group_id in requested
            if group_id in groups and not indexer._already_indexed(kind, group_id)
        )
    return sum(
        1
        for group in groups.values()
        if not indexer._already_indexed(kind, str(group.get("group_id", "")))
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mirrororder-identity-worker")
    parser.add_argument("--workspace-id", required=True)
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--kind", choices=("face", "speaker"), required=True)
    parser.add_argument("--group-id", action="append", default=[])
    args = parser.parse_args(argv)

    cancelled = Event()
    Thread(target=_listen_for_cancellation, args=(cancelled,), daemon=True).start()
    group_ids = [str(value) for value in args.group_id if str(value)]

    try:
        label = "演员人脸识别" if args.kind == "face" else "角色声纹识别"
        _emit({"type": "status", "message": f"正在读取{label}缓存"})
        config = ProjectConfig.from_file(args.config)
        indexer = IdentityIndexer(args.workspace_id, args.project_id, config)
        pending_total = _pending_total(indexer, args.kind, group_ids)
        if pending_total is not None:
            _emit({"type": "progress", "done": 0, "total": pending_total, "group_id": ""})
        _emit({"type": "status", "message": f"正在加载{label}模型"})

        def report(done: int, total: int, group_id: str) -> None:
            _emit({
                "type": "progress",
                "done": int(done),
                "total": int(total),
                "group_id": str(group_id),
            })

        result = indexer.run(
            args.kind,
            group_ids=group_ids or None,
            progress=report,
            cancelled=cancelled.is_set,
        )
        _emit({"type": "result", "result": result})
        return 0
    except Exception as error:
        _emit({"type": "error", "error": str(error)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
