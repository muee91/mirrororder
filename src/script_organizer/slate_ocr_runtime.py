"""项目级场记识别：读取项目自带场记，逐页提取候选并持久化。

这是 evidence/proposal 的 durable 实现：后台任务负责分批调用视觉模型，
把每一页的候选写到项目本地状态文件；任何写入场记 authority 的动作仍由
人工在 UI 核对后完成。响应/状态文件永远不包含绝对路径或 API Key。
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from .media_identity import _atomic_json
from .paper_vlm_intake import (
    MAX_PDF_BYTES,
    MAX_PDF_PAGES,
    extract_paper_slate_photo_candidates,
    pdf_page_count,
)
from .vision_provider import VisionProviderConfig

CANDIDATES_CONTRACT = "slate_candidates.v1"
SLATE_SUFFIXES = {".pdf", ".jpg", ".jpeg", ".png", ".webp"}
_STATUS_VALUES = {"usable", "partial", "ng", "unmarked"}
_CANDIDATE_FIELDS = (
    "page", "row", "episode", "scene", "shot", "take", "status",
    "note", "confidence", "authority",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def candidates_path(config: Any) -> Path:
    return Path(config.output_dir) / "slate_candidates.json"


def empty_candidates(project_id: str, config: Any | None = None) -> dict[str, Any]:
    slate = _slate_source(config) if config is not None else None
    return {
        "contract": CANDIDATES_CONTRACT,
        "project_id": project_id,
        "slate_attached": slate is not None,
        "slate_name": slate.name[:200] if slate else "",
        "status": "none",
        "revision": 0,
        "pages_total": 0,
        "pages_done": 0,
        "candidates": [],
        "warning": "",
        "error": "",
        "provider": "",
        "model": "",
        "started_at": "",
        "completed_at": "",
        "updated_at": "",
        "task_id": "",
    }


def _safe_candidates(rows: object) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for value in rows if isinstance(rows, list) else []:
        if not isinstance(value, dict):
            continue
        row = {field: value.get(field) for field in _CANDIDATE_FIELDS}
        row["page"] = str(row.get("page") or "1")[:60]
        try:
            row["row"] = max(0, int(row.get("row") or 0))
        except (TypeError, ValueError):
            row["row"] = 0
        episode = row.get("episode")
        row["episode"] = int(episode) if isinstance(episode, int) and not isinstance(episode, bool) and episode > 0 else None
        for key in ("scene", "shot", "take", "note"):
            row[key] = str(row.get(key) or "")[:600]
        row["status"] = str(row.get("status") or "unmarked")
        if row["status"] not in _STATUS_VALUES:
            row["status"] = "unmarked"
        try:
            confidence = float(row.get("confidence") or 0.0)
        except (TypeError, ValueError):
            confidence = 0.0
        row["confidence"] = round(min(1.0, max(0.0, confidence)), 3)
        row["authority"] = False
        result.append(row)
    return result


def _write(config: Any, state: dict[str, Any]) -> None:
    state = {**state, "updated_at": _now()}
    _atomic_json(candidates_path(config), state)


def read_slate_candidates(config: Any, project_id: str) -> dict[str, Any]:
    """Lightweight GET read model. Never performs OCR or model work."""
    base = empty_candidates(project_id, config)
    try:
        raw = json.loads(candidates_path(config).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return base
    if not isinstance(raw, dict) or raw.get("contract") != CANDIDATES_CONTRACT:
        return base
    if raw.get("project_id") != project_id:
        return base
    for key in base:
        if key == "candidates":
            base[key] = _safe_candidates(raw.get("candidates"))
        elif key in {"project_id", "slate_attached", "slate_name"}:
            # The project config is the authority for which slate is attached.
            continue
        elif key in {"revision", "pages_total", "pages_done"}:
            try:
                base[key] = max(0, int(raw.get(key) or 0))
            except (TypeError, ValueError):
                base[key] = 0
        elif isinstance(base[key], bool):
            base[key] = bool(raw.get(key))
        elif isinstance(base[key], str):
            base[key] = str(raw.get(key) or "")[:1200]
    return base


def _slate_source(config: Any) -> Path | None:
    slate = getattr(config, "slate", None)
    if not slate:
        return None
    try:
        path = Path(slate).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return None
    return path if path.is_file() else None


def _summary(state: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": state["status"],
        "pages_total": state["pages_total"],
        "pages_done": state["pages_done"],
        "candidate_count": len(state["candidates"]),
        "revision": state["revision"],
        "warning": state["warning"],
        "error": state["error"],
    }


def run_slate_ocr(
    config: Any,
    *,
    project_id: str,
    task_id: str = "",
    progress: Callable[[int, int], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
    vision_config: VisionProviderConfig | None = None,
) -> dict[str, Any]:
    """Recognize the project's attached slate as a cancellable durable task.

    Returns a small summary for the task result; the full candidate list is
    persisted separately and read through ``read_slate_candidates``.
    """
    slate = _slate_source(config)
    previous = read_slate_candidates(config, project_id)
    state = empty_candidates(project_id)
    state.update({
        "status": "running",
        "revision": previous["revision"] + 1,
        "slate_attached": slate is not None,
        "slate_name": slate.name[:200] if slate else "",
        "started_at": _now(),
        "task_id": str(task_id or "")[:96],
    })
    _write(config, state)

    if slate is None:
        state["status"] = "failed"
        state["error"] = "项目未附带可读取的场记文件；请在创建项目时选择 PDF 或照片。"
        state["completed_at"] = _now()
        _write(config, state)
        return _summary(state)
    if slate.suffix.lower() not in SLATE_SUFFIXES:
        state["status"] = "failed"
        state["error"] = "场记文件必须是 PDF、JPEG、PNG 或 WEBP。"
        state["completed_at"] = _now()
        _write(config, state)
        return _summary(state)

    try:
        if slate.stat().st_size > MAX_PDF_BYTES:
            raise ValueError("场记文件超过 20MB 大小上限")
        source_bytes = slate.read_bytes()
    except (OSError, ValueError) as error:
        state["status"] = "failed"
        state["error"] = str(error)
        state["completed_at"] = _now()
        _write(config, state)
        return _summary(state)

    is_pdf = slate.suffix.lower() == ".pdf" or source_bytes.startswith(b"%PDF-")
    total = max(1, min(pdf_page_count(source_bytes) if is_pdf else 1, MAX_PDF_PAGES))
    state["pages_total"] = total
    _write(config, state)

    candidates: list[dict[str, Any]] = []
    warnings: list[str] = []
    for page in range(1, total + 1):
        if cancelled and cancelled():
            state["status"] = "cancelled"
            state["warning"] = "；".join(warnings[-20:])[:1200]
            state["completed_at"] = _now()
            _write(config, state)
            return _summary(state)
        payload: dict[str, Any] = {
            "file_path": str(slate),
            "page_label": str(page),
        }
        if is_pdf and total > 1:
            payload["pdf_page_start"] = page
            payload["pdf_page_limit"] = 1
        result: dict[str, Any] = {"candidates": [], "warning": ""}
        try:
            result = extract_paper_slate_photo_candidates(payload, config=vision_config)
        except ValueError as error:
            warnings.append(f"第 {page} 页识别失败：{str(error)[:200]}")
        except Exception:
            warnings.append(f"第 {page} 页识别失败：视觉模型暂不可用")
        candidates.extend(_safe_candidates(result.get("candidates")))
        page_warning = str(result.get("warning") or "").strip()
        if page_warning:
            warnings.append(f"第 {page} 页：{page_warning[:200]}")
        state["pages_done"] = page
        state["candidates"] = candidates
        state["warning"] = "；".join(warnings[-20:])[:1200]
        state["provider"] = str(result.get("provider") or "")[:80]
        state["model"] = str(result.get("model") or "")[:200]
        _write(config, state)
        if progress:
            progress(page, total)

    state["status"] = "completed"
    state["completed_at"] = _now()
    state["error"] = ""
    _write(config, state)
    return _summary(state)


__all__ = [
    "CANDIDATES_CONTRACT",
    "SLATE_SUFFIXES",
    "candidates_path",
    "empty_candidates",
    "read_slate_candidates",
    "run_slate_ocr",
]
