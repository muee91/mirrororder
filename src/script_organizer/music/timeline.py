from __future__ import annotations

from typing import Any


ASSEMBLY_CONTRACT = "assembly_timeline.v1"


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def scene_windows_from_assembly(
    assembly: dict[str, Any],
    *,
    episode: int | None = None,
) -> dict[tuple[int, str], dict[str, Any]]:
    """Translate assembly_timeline.v1 scene-local timing into episode-global windows.

    assembly_timeline.v1 resets each scene cursor to zero. Auto Score needs one
    episode-global clock for music placement, so this adapter accumulates scene
    durations in assembly order and resets the cursor when the episode changes.
    No creative decisions are introduced here; readiness is preserved verbatim.
    """

    if str(assembly.get("contract", "") or "") != ASSEMBLY_CONTRACT:
        raise ValueError("Auto Score V1 requires assembly_timeline.v1")

    windows: dict[tuple[int, str], dict[str, Any]] = {}
    cursors: dict[int, float] = {}
    for raw in _as_list(assembly.get("scenes")):
        if not isinstance(raw, dict):
            continue
        ep = _int(raw.get("episode"), 0)
        if episode is not None and ep != episode:
            continue
        scene_id = str(raw.get("scene_id", "") or "")
        if not scene_id:
            continue
        duration = max(0.0, _float(raw.get("duration"), 0.0))
        start = cursors.get(ep, 0.0)
        end = start + duration
        windows[(ep, scene_id)] = {
            "episode": ep,
            "scene_id": scene_id,
            "start": start,
            "end": end,
            "duration": duration,
            "readiness": str(raw.get("readiness", "needs_review") or "needs_review"),
            "assembly_summary": dict(_as_dict(raw.get("summary"))),
        }
        cursors[ep] = end
    return windows


def assembly_timeline_metadata(assembly: dict[str, Any]) -> dict[str, Any]:
    return {
        "contract": str(assembly.get("contract", "") or ""),
        "revision": str(assembly.get("revision", "") or ""),
        "rough_cut_plan_revision": str(assembly.get("rough_cut_plan_revision", "") or ""),
        "coverage_revision": str(assembly.get("coverage_revision", "") or ""),
        "readiness": str(assembly.get("readiness", "needs_review") or "needs_review"),
        "duration": max(0.0, _float(assembly.get("duration"), 0.0)),
    }
