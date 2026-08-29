from __future__ import annotations

import copy
import json
from typing import Any

from .timeline_delivery import UnsafeTimelineDelivery


MULTICAM_SYNC_METADATA_KEY = "multicam_sync_v1"


def _frame(value: object, label: str, *, positive: bool = False) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise UnsafeTimelineDelivery(f"{label} must be an integer frame")
    if value < 0 or (positive and value <= 0):
        qualifier = "positive" if positive else "non-negative"
        raise UnsafeTimelineDelivery(f"{label} must be a {qualifier} integer frame")
    return value


def _sync_ranges(raw: object, clip_id: str) -> dict[str, tuple[int, int]]:
    if not isinstance(raw, str) or not raw.strip():
        raise UnsafeTimelineDelivery(f"Timeline multicam sync metadata is invalid: {clip_id}")
    try:
        envelope = json.loads(raw)
    except (TypeError, ValueError) as error:
        raise UnsafeTimelineDelivery(f"Timeline multicam sync metadata is invalid: {clip_id}") from error
    if not isinstance(envelope, dict) or envelope.get("version") != 1 or not isinstance(envelope.get("sources"), list):
        raise UnsafeTimelineDelivery(f"Timeline multicam sync metadata is invalid: {clip_id}")
    ranges: dict[str, tuple[int, int]] = {}
    for item in envelope["sources"]:
        if not isinstance(item, dict):
            raise UnsafeTimelineDelivery(f"Timeline multicam sync metadata is invalid: {clip_id}")
        source_id = str(item.get("source_id", "") or "").strip()
        start = _frame(item.get("start_frame"), f"sync {source_id or '<empty>'} start_frame")
        end = _frame(item.get("end_frame"), f"sync {source_id or '<empty>'} end_frame", positive=True)
        if not source_id or end <= start or source_id in ranges:
            raise UnsafeTimelineDelivery(f"Timeline multicam sync metadata is invalid: {clip_id}")
        ranges[source_id] = (start, end)
    if len(ranges) < 2:
        raise UnsafeTimelineDelivery(f"Timeline multicam sync metadata is incomplete: {clip_id}")
    return ranges


def normalize_timeline_delivery_request(request: dict[str, Any]) -> dict[str, Any]:
    """Rebase selected multicam angles using immutable Rust-owned clip metadata.

    Rust keeps ``clip.source_in`` in the base source coordinate when the editor
    switches ``selected_angle_source_id``. New Timeline clips persist a versioned
    synchronization envelope inside ``clip.metadata``; Delivery consumes that
    immutable evidence before the existing FCPXML converter runs. Historical
    clips without the envelope are left untouched so the v1 material-index
    fallback remains available for legacy checkpoints.
    """
    payload = copy.deepcopy(request)
    timeline = payload.get("timeline")
    if not isinstance(timeline, dict):
        return payload
    sequences = timeline.get("sequences")
    if not isinstance(sequences, list):
        return payload

    for sequence in sequences:
        if not isinstance(sequence, dict):
            continue
        tracks = sequence.get("tracks")
        if not isinstance(tracks, list):
            continue
        for track in tracks:
            if not isinstance(track, dict):
                continue
            clips = track.get("clips")
            if not isinstance(clips, list):
                continue
            for clip in clips:
                if not isinstance(clip, dict) or not clip.get("multicam_group_id"):
                    continue
                clip_id = str(clip.get("clip_id", "") or "<unknown>")
                base_source_id = str(clip.get("source_id", "") or "").strip()
                selected_source_id = str(clip.get("selected_angle_source_id", "") or "").strip()
                if not base_source_id or not selected_source_id or selected_source_id == base_source_id:
                    continue
                metadata = clip.get("metadata")
                raw = metadata.get(MULTICAM_SYNC_METADATA_KEY) if isinstance(metadata, dict) else None
                if raw is None:
                    # Legacy Timeline: retain Stage 14 material-index fallback.
                    continue
                ranges = _sync_ranges(raw, clip_id)
                base = ranges.get(base_source_id)
                selected = ranges.get(selected_source_id)
                if base is None or selected is None:
                    raise UnsafeTimelineDelivery(f"Timeline multicam sync metadata does not cover selected angle: {clip_id}")
                source_in = _frame(clip.get("source_in"), f"clip {clip_id} source_in")
                duration = _frame(clip.get("duration"), f"clip {clip_id} duration", positive=True)
                base_start, base_end = base
                selected_start, selected_end = selected
                if source_in < base_start or source_in + duration > base_end:
                    raise UnsafeTimelineDelivery(f"Timeline clip exceeds base multicam sync range: {clip_id}")
                selected_in = selected_start + (source_in - base_start)
                if selected_in + duration > selected_end:
                    raise UnsafeTimelineDelivery(f"Timeline clip exceeds selected multicam sync range: {clip_id}")
                # The existing exporter sees selected==base after this transform,
                # so it preserves the exact source time without re-applying the
                # legacy material-index origin delta.
                clip["source_id"] = selected_source_id
                clip["source_in"] = selected_in
    return payload


__all__ = ["MULTICAM_SYNC_METADATA_KEY", "normalize_timeline_delivery_request"]
