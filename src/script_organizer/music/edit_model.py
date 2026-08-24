from __future__ import annotations

from typing import Any

from .timeline import assembly_timeline_metadata, scene_windows_from_assembly


MUSIC_EDIT_CONTRACT = "music_edit_plan.v1"


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _mix_policy(dialogue_density: float, duration: float) -> dict[str, Any]:
    density = max(0.0, min(1.0, dialogue_density))
    if density >= 0.65:
        gain_db = -18.0
        reduction_db = 7.0
    elif density >= 0.35:
        gain_db = -15.0
        reduction_db = 5.0
    else:
        gain_db = -12.0
        reduction_db = 3.0
    fade = max(0.15, min(1.5, duration * 0.06))
    return {
        "base_gain_db": gain_db,
        "fade_in_seconds": round(fade, 3),
        "fade_out_seconds": round(fade, 3),
        "ducking": {
            "enabled": density >= 0.35,
            "reduction_db": reduction_db,
            "attack_seconds": 0.12,
            "release_seconds": 0.35,
            "source": "scene_dialogue_density",
            "precision": "scene_level",
        },
    }


def build_music_edit_plan(
    music_plan: dict[str, Any],
    assembly: dict[str, Any],
    *,
    episode: int | None = None,
) -> dict[str, Any]:
    """Build a read-only, exporter-neutral music edit plan.

    This contract turns selected Auto Score cues into deterministic timeline
    placements using assembly_timeline.v1 timing. It intentionally stops before
    FCPXML mutation. Only scenes whose assembly readiness is `ready` are marked
    exportable; incomplete scenes remain visible but blocked.
    """

    windows = scene_windows_from_assembly(assembly, episode=episode)
    assembly_meta = assembly_timeline_metadata(assembly)
    edits: list[dict[str, Any]] = []

    for cue in _as_list(music_plan.get("cues")):
        if not isinstance(cue, dict):
            continue
        try:
            cue_episode = int(cue.get("episode", 0) or 0)
        except (TypeError, ValueError):
            cue_episode = 0
        if episode is not None and cue_episode != episode:
            continue
        scene_id = str(cue.get("scene_id", "") or "")
        window = windows.get((cue_episode, scene_id))
        selected = _as_dict(cue.get("selected"))
        asset = _as_dict(cue.get("asset"))
        density = max(0.0, min(1.0, _float(cue.get("dialogue_density"), 0.0)))

        if window is None:
            status = "timeline_missing"
            exportable = False
            placement: dict[str, Any] = {}
        elif str(window.get("readiness", "") or "") != "ready":
            status = "timeline_blocked"
            exportable = False
            placement = {
                "timeline_start": round(_float(window.get("start")), 3),
                "timeline_end": round(_float(window.get("end")), 3),
                "duration": round(_float(window.get("duration")), 3),
            }
        elif not selected or not asset:
            status = "needs_music"
            exportable = False
            placement = {
                "timeline_start": round(_float(window.get("start")), 3),
                "timeline_end": round(_float(window.get("end")), 3),
                "duration": round(_float(window.get("duration")), 3),
            }
        elif asset.get("license") and not bool(_as_dict(asset.get("license")).get("eligible", False)):
            status = "rights_blocked"
            exportable = False
            placement = {}
        else:
            duration = max(0.0, _float(window.get("duration"), 0.0))
            source_start = max(0.0, _float(selected.get("source_start"), 0.0))
            source_end = max(source_start, _float(selected.get("source_end"), source_start))
            available = max(0.0, source_end - source_start)
            placement = {
                "timeline_start": round(_float(window.get("start")), 3),
                "timeline_end": round(_float(window.get("end")), 3),
                "duration": round(duration, 3),
                "source_start": round(source_start, 3),
                "source_end": round(source_end, 3),
                "source_duration": round(available, 3),
                "fit": "exact_or_longer" if available + 0.05 >= duration else "extend_required",
                "boundary_source": str(selected.get("boundary_source", "") or ""),
                "beat_aligned": bool(selected.get("beat_aligned", False)),
            }
            exportable = available + 0.05 >= duration
            status = "ready" if exportable else "extend_required"

        edit = {
            "cue_id": str(cue.get("cue_id", "") or ""),
            "episode": cue_episode,
            "scene_id": scene_id,
            "status": status,
            "exportable": exportable,
            "assembly_readiness": str(window.get("readiness", "missing") if window else "missing"),
            "placement": placement,
            "asset": {
                "asset_id": str(asset.get("asset_id", "") or ""),
                "path": str(asset.get("path", "") or ""),
                "title": str(asset.get("title", "") or ""),
                "generated": bool(asset.get("generated", False)),
                "license": dict(_as_dict(asset.get("license"))),
            } if asset else {},
            "mix": _mix_policy(density, _float(placement.get("duration"), 0.0)),
            "semantics": {
                "timeline_source": "assembly_timeline.v1",
                "creative_selection_source": "auto-score.v1",
                "writes_fcpxml": False,
                "writes_editorial": False,
                "preview_only": True,
            },
        }
        edits.append(edit)

    ready = sum(1 for item in edits if item["status"] == "ready")
    blocked = sum(1 for item in edits if not item["exportable"])
    return {
        "contract": MUSIC_EDIT_CONTRACT,
        "version": 1,
        "feature_level": "v1.0-alpha",
        "source": {
            "music_contract": str(music_plan.get("contract", "") or ""),
            "music_feature_level": str(music_plan.get("feature_level", "") or ""),
            "assembly": assembly_meta,
        },
        "summary": {
            "edits": len(edits),
            "ready": ready,
            "blocked": blocked,
            "exportable": ready,
        },
        "edits": edits,
        "semantics": {
            "real_timeline_timing": True,
            "scene_level_cues": True,
            "ducking_precision": "scene_level",
            "writes_fcpxml": False,
            "mutates_source_timeline": False,
            "requires_safe_exporter_before_delivery": True,
        },
    }
