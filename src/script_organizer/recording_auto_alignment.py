"""Automatic waveform alignment for independent original WAV recordings.

Runs inside the durable sync worker across single- or multi-day shoots,
unbounded candidate counts, and mono/stereo/Poly-WAV (up to 32 channels).
High-confidence waveform matches are placed automatically on packed original
audio tracks without pushing manual offset or per-clip confirmation work onto
editors.
"""
from __future__ import annotations

import csv
import hashlib
import json
import subprocess
from fractions import Fraction
from pathlib import Path
from time import monotonic

import numpy as np

from .media_identity import DeviceMediaStore, media_id_for_path
from .recording_reference_index import normalize_waveform_samples
from .recording_waveform_solver import WaveformReference, solve_long_recording, solve_recording_waveform
from .timebase import fcpxml_project_timebase

SR = 16000
_DAY_GUARD_SECONDS = 3600  # 1-hour empty guard between virtual days so no WAV straddles two days.
_MAX_WAV_CHANNELS = 32


def _normalized(samples):
    return samples / max(1.0, float(np.max(np.abs(samples), initial=0)))


def _process(command, check_cancelled):
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for _ in range(150):
            check_cancelled()
            try:
                out, _err = process.communicate(timeout=0.2)
                if process.returncode:
                    raise ValueError("media_decode_failed")
                return out
            except subprocess.TimeoutExpired:
                continue
        raise ValueError("media_decode_timeout")
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()


def _audio_start(path: Path, check_cancelled) -> Fraction:
    data = json.loads(
        _process(
            ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(path)],
            check_cancelled,
        )
    )
    video = next(s for s in data["streams"] if s.get("codec_type") == "video")
    audio = next(s for s in data["streams"] if s.get("codec_type") == "audio")
    # An explicit stream timestamp is needed; metadata absence is not zero.
    return Fraction(audio["start_time"]) - Fraction(video["start_time"])


def _read_position_table(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as stream:
        return list(csv.DictReader(stream, delimiter="\t"))


def _compressed_translation(
    *,
    rows: list[dict[str, str]],
    raw: dict[str, dict[str, str]],
    zero: Fraction,
    physical_zero: Fraction,
    physical_start: Fraction,
    physical_end: Fraction,
) -> tuple[Fraction | None, str]:
    """Prove a single translation from physical time into this compressed master.

    A removed common gap changes that translation; never silently split the
    original WAV to hide a deleted gap.
    """
    offsets: list[Fraction] = []
    for camera_row in rows:
        phys = Fraction(raw[camera_row["id"]]["pos"]) - physical_zero
        dur = Fraction(camera_row["dur"])
        if phys < physical_end and phys + dur > physical_start:
            offsets.append((Fraction(camera_row["pos"]) - zero) - phys)
    if not offsets:
        return None, "outside_active_camera_coverage"
    if max(offsets) - min(offsets) > Fraction(1, SR):
        return None, "crosses_deleted_common_gap"
    return offsets[0], ""


def _solve_short_recording_candidates(
    original: np.ndarray,
    candidate_refs: list[WaveformReference],
    reference_rows: list[dict],
    day_layouts: list[dict],
    sample_rate: int,
) -> dict:
    """Resolve a 4–20s WAV across multi-day/multi-window candidate references.

    ``solve_recording_waveform`` requires 2–4 unique-camera references that each
    cover the full short recording. We group fingerprint hits by day and build
    one merged reference excerpt per camera (bounded to 180s) from the cached
    16kHz audio, accepting a placement only when exactly one day aligns cleanly.
    """
    max_ref_samples = 180 * sample_rate
    by_day_cam: dict[str, dict[str, list[WaveformReference]]] = {}
    for ref in candidate_refs:
        ref_sec = Fraction(ref.timeline_start_samples, sample_rate)
        day_key = None
        for layout in day_layouts:
            if layout["virtual_start_s"] - 1 <= ref_sec <= layout["virtual_end_s"] + 1:
                day_key = str(layout["day"])
                break
        if day_key is None:
            continue
        by_day_cam.setdefault(day_key, {}).setdefault(ref.camera.strip().casefold(), []).append(ref)

    aligned_results: list[dict] = []
    last_failure: dict = {"status": "unresolved", "reason": "insufficient_or_excess_references"}
    for day_key, cam_map in by_day_cam.items():
        if len(cam_map) < 2:
            continue
        cluster_refs: list[WaveformReference] = []
        for canonical_cam, refs in sorted(cam_map.items())[:4]:
            span_start = min(r.timeline_start_samples for r in refs)
            span_end = max(r.timeline_start_samples + r.samples.size for r in refs)
            best_row = None
            best_overlap = -1
            for rrow in reference_rows:
                if rrow["camera"].strip().casefold() != canonical_cam:
                    continue
                r_origin = rrow["timeline_start_samples"]
                r_size = rrow["cache_path"].stat().st_size // 4
                overlap = min(r_origin + r_size, span_end) - max(r_origin, span_start)
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_row = (rrow, r_origin, r_size)
            if best_row is None or best_overlap <= 0:
                continue
            rrow, r_origin, r_size = best_row
            lo = max(0, span_start - r_origin - 2 * sample_rate)
            hi = min(r_size, span_end - r_origin + 2 * sample_rate)
            if hi - lo > max_ref_samples:
                mid = (lo + hi) // 2
                lo = max(0, mid - max_ref_samples // 2)
                hi = min(r_size, lo + max_ref_samples)
            if hi - lo < original.size:
                continue
            source = np.memmap(rrow["cache_path"], mode="r", dtype="<f4")
            excerpt = normalize_waveform_samples(np.array(source[lo:hi], copy=True))
            del source
            cluster_refs.append(WaveformReference(rrow["camera"].strip(), r_origin + lo, excerpt))
        if not 2 <= len(cluster_refs) <= 4:
            continue
        res = solve_recording_waveform(original, cluster_refs, sample_rate)
        if res["status"] == "aligned":
            aligned_results.append(res)
        else:
            last_failure = res

    if len(aligned_results) == 1:
        return aligned_results[0]
    if len(aligned_results) > 1:
        return {"status": "unresolved", "reason": "ambiguous_multiday_waveform", "method": "waveform_alignment"}
    return last_failure


def _pack_recording_tracks(placements: list[dict]) -> list[dict]:
    """Pack non-overlapping WAV placements onto compact numbered tracks."""
    track_ends: list[int] = []
    ordered = sorted(placements, key=lambda item: (item["at"], item["frames"], item["media_id"], item["source"]))
    for entry in ordered:
        chosen: int | None = None
        for idx, end_frame in enumerate(track_ends):
            if entry["at"] >= end_frame:
                track_ends[idx] = entry["at"] + entry["frames"]
                chosen = idx + 1
                break
        if chosen is None:
            track_ends.append(entry["at"] + entry["frames"])
            chosen = len(track_ends)
        entry["track"] = f"原录音_{chosen}"
    return ordered


def auto_align_recordings(
    *,
    inventory,
    local_paths,
    work: Path,
    media_base: Path,
    days,
    master: Path,
    roots,
    context,
    prior,
    check_cancelled,
    log=lambda text: None,
    budget_seconds: float | None = None,
):
    budget_start = monotonic()

    def over_budget() -> bool:
        return budget_seconds is not None and (monotonic() - budget_start) > budget_seconds

    def pending(reason):
        return None, [
            {
                "code": reason,
                "message": "独立录音未自动确认：" + reason + "；保留既有摆位，不以机内参考声冒充完整录音交付。",
            }
        ]

    if prior and (not isinstance(prior, dict) or prior.get("confirmation_source") != "automatic_waveform.v1"):
        return pending("existing_recording_authority_preserved")
    if not inventory["candidates"]:
        return pending("recording_roster_unknown")
    if not context or not all(context):
        return pending("missing_sync_revision_context")
    if not days:
        return pending("missing_sync_days")

    timebase = fcpxml_project_timebase(master)
    if timebase["status"] != "confirmed":
        return pending("unverified_master_timebase")
    rate = Fraction(timebase["numerator"], timebase["denominator"])

    from .media_identity import _atomic_json
    from .recording_reference_index import build_recording_reference_candidates

    clocks_path = work / "recording_reference_clocks.json"
    clocks = json.loads(clocks_path.read_text()) if clocks_path.exists() else {}

    reference_rows = []
    day_layouts = []
    seen = set()
    master_offset_frames = 0
    virtual_offset_s = Fraction(0)

    for day in days:
        rows = _read_position_table(work / f"positions_{day}_compressed.tsv")
        raw = {r["id"]: r for r in _read_position_table(work / f"positions_{day}.tsv")}
        if not rows or len(rows) != len(raw):
            return pending("ambiguous_master_coordinates")
        zero = min(Fraction(r["pos"]) for r in rows)
        physical_zero = min(Fraction(r["pos"]) for r in raw.values())
        physical_end = max(Fraction(r["pos"]) - physical_zero + Fraction(r["dur"]) for r in raw.values())
        compressed_span = max(Fraction(r["pos"]) + Fraction(r["dur"]) for r in rows) - zero
        day_master_frames = round(compressed_span * rate)

        for row in rows:
            check_cancelled()
            if over_budget():
                _atomic_json(clocks_path, clocks)
                return pending("reference_probe_budget_incomplete")
            if row["cam"] == "?":
                continue
            path = (media_base / row["dir"] / row["file"]).resolve(strict=True)
            if not any(path.is_relative_to(Path(root).resolve()) for root in roots):
                return pending("reference_outside_media_roots")
            identity = media_id_for_path(path)
            if not identity or identity in seen:
                return pending("duplicate_or_unverified_reference_media")
            seen.add(identity)
            occurrence = "\0".join((str(day), row["cam"], str(Path(row["dir"]) / row["file"]), identity))
            expected_id = "v2_" + hashlib.sha1(occurrence.encode("utf-8")).hexdigest()[:32]
            if row["id"] != expected_id:
                return pending("reference_cache_identity_changed")
            cache = work / "audio" / (row["id"] + ".f32")
            if not cache.is_file() or cache.stat().st_size < 4 * SR * 4:
                continue
            if identity not in clocks:
                offset = _audio_start(path, check_cancelled)
                clocks[identity] = [offset.numerator, offset.denominator]
            start = (virtual_offset_s + Fraction(raw[row["id"]]["pos"]) - physical_zero + Fraction(*clocks[identity])) * SR
            reference_rows.append(
                dict(
                    media_id=identity,
                    camera=row["cam"],
                    cache_path=cache,
                    timeline_start_samples=round(start),
                )
            )

        day_layouts.append(
            {
                "day": day,
                "rows": rows,
                "raw": raw,
                "zero": zero,
                "physical_zero": physical_zero,
                "physical_end": physical_end,
                "master_offset_frames": master_offset_frames,
                "master_span_frames": day_master_frames,
                "virtual_start_s": virtual_offset_s,
                "virtual_end_s": virtual_offset_s + physical_end,
            }
        )
        master_offset_frames += day_master_frames
        virtual_offset_s += physical_end + _DAY_GUARD_SECONDS

    _atomic_json(clocks_path, clocks)
    if len({r["camera"] for r in reference_rows}) < 2:
        return pending("insufficient_independent_references")

    total_master_frames = master_offset_frames
    placements, evidence, unresolved = [], [], []
    total_candidates = len(inventory["candidates"])

    for number, row in enumerate(inventory["candidates"], 1):
        check_cancelled()
        log(f"原录音波形核对 {number}/{total_candidates}")
        identity = row["media_id"]
        path = local_paths.get(identity)
        duration_s = Fraction(row.get("sample_count", 0), row.get("sample_rate", 1))
        channels = int(row.get("channels", 0) or 0)
        if (
            row["status"] != "unverified_candidate"
            or not path
            or not 1 <= channels <= _MAX_WAV_CHANNELS
            or not 4 <= duration_s <= 4 * 3600
            or over_budget()
        ):
            unresolved.append(identity)
            evidence.append(
                {
                    "media_id": identity,
                    "status": "unresolved",
                    "reason": "duration_channel_or_budget_unsupported",
                }
            )
            continue

        # Five bounded 8s windows; do not decode hours or pretend a prefix is a file.
        measurement_count = int(duration_s * SR)
        window_seconds = 8 if duration_s >= 40 else 4
        starts = [i * (measurement_count - window_seconds * SR) // 4 for i in range(5)]

        def measure(window_starts):
            if duration_s < 20:
                data = _process(
                    [
                        "ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-map", "0:a:0",
                        "-t", str(float(duration_s)), "-ac", "1", "-ar", str(SR), "-f", "f32le", "pipe:1",
                    ],
                    check_cancelled,
                )
                original = _normalized(np.frombuffer(data, dtype="<f4"))
                if original.size < 4 * SR:
                    return {"status": "unresolved", "reason": "original_window_boundary_unverified"}
                short_starts = [0, max(0, (original.size - 4 * SR) // 2), max(0, original.size - 4 * SR)]
                windows = [(start, original[start : start + 4 * SR]) for start in sorted(set(short_starts))]
                candidates = build_recording_reference_candidates(
                    reference_rows, windows, work / "recording-fingerprints",
                    sample_rate=SR, check_cancelled=check_cancelled,
                )
                if not candidates.complete:
                    return {"status": "unresolved", "reason": candidates.reason}
                res = _solve_short_recording_candidates(
                    original, candidates.references, reference_rows, day_layouts, SR
                )
                res["candidate_search"] = candidates.metadata
                return res
            windows = []
            for source_start in window_starts:
                check_cancelled()
                if over_budget():
                    return {"status": "unresolved", "reason": "budget_incomplete"}
                data = _process(
                    [
                        "ffmpeg", "-nostdin", "-v", "error", "-ss", str(float(Fraction(source_start, SR))),
                        "-i", str(path), "-map", "0:a:0", "-t", str(window_seconds),
                        "-ac", "1", "-ar", str(SR), "-f", "f32le", "pipe:1",
                    ],
                    check_cancelled,
                )
                samples = _normalized(np.frombuffer(data, dtype="<f4"))
                if len(samples) != window_seconds * SR:
                    return {"status": "unresolved", "reason": "original_window_boundary_unverified"}
                windows.append((source_start, samples))
            if media_id_for_path(path) != identity:
                return {"status": "unresolved", "reason": "original_identity_changed"}
            candidates = build_recording_reference_candidates(
                reference_rows, windows, work / "recording-fingerprints",
                sample_rate=SR, check_cancelled=check_cancelled,
            )
            if not candidates.complete:
                return {"status": "unresolved", "reason": candidates.reason}
            res = solve_long_recording(
                windows, measurement_count, candidates.references, SR, check_cancelled=check_cancelled
            )
            res["candidate_search"] = candidates.metadata
            return res

        result = measure(starts)
        # AAC start/seek transients may invalidate a whole anchor. Retest only weak
        # evidence, never conflicts/drift. Keep head/tail, shift interiors once.
        if result.get("reason") == "insufficient_anchor_corroboration" and duration_s >= 45:
            shifted = [start + (SR if 0 < i < 4 else 0) for i, start in enumerate(starts)]
            result = measure(shifted)
            result["anchor_retry"] = "interior_plus_1_second"
        if result["status"] != "aligned":
            unresolved.append(identity)
            evidence.append({"media_id": identity, "status": "unresolved", "reason": result["reason"]})
            continue

        virtual_start = Fraction(*result["timeline_start_seconds"])
        matched_layout = next(
            (
                item
                for item in day_layouts
                if item["virtual_start_s"] - Fraction(1, 2) <= virtual_start < item["virtual_end_s"]
            ),
            None,
        )
        if matched_layout is None:
            unresolved.append(identity)
            evidence.append({"media_id": identity, "status": "unresolved", "reason": "original_range_outside_master"})
            continue

        physical_start = virtual_start - matched_layout["virtual_start_s"]
        if physical_start < -Fraction(1, 2) or physical_start + duration_s > matched_layout["physical_end"] + Fraction(1, 2):
            unresolved.append(identity)
            evidence.append({"media_id": identity, "status": "unresolved", "reason": "original_range_outside_master"})
            continue
        clamped_start = max(Fraction(0), physical_start)
        clamped_end = min(physical_start + duration_s, matched_layout["physical_end"])
        delta, gap_reason = _compressed_translation(
            rows=matched_layout["rows"],
            raw=matched_layout["raw"],
            zero=matched_layout["zero"],
            physical_zero=matched_layout["physical_zero"],
            physical_start=clamped_start,
            physical_end=clamped_end,
        )
        if delta is None:
            unresolved.append(identity)
            evidence.append({"media_id": identity, "status": "unresolved", "reason": gap_reason})
            continue

        day_base_frame = matched_layout["master_offset_frames"]
        day_end_frame = day_base_frame + matched_layout["master_span_frames"]
        at_exact = Fraction(day_base_frame) + (clamped_start + delta) * rate
        at = max(day_base_frame, round(at_exact))
        duration_frames_exact = Fraction(row["sample_count"], row["sample_rate"]) * rate
        frames = duration_frames_exact.numerator // duration_frames_exact.denominator
        if at + frames > day_end_frame:
            frames = day_end_frame - at
        if at < 0 or frames <= 0 or at + frames > total_master_frames:
            unresolved.append(identity)
            evidence.append({"media_id": identity, "status": "unresolved", "reason": "zero_length_segment"})
            continue
        placements.append(
            dict(
                media_id=identity,
                name=path.name,
                track="原录音_1",
                at=at,
                source=0,
                frames=frames,
                source_kind="original",
                timing_basis="original_unretimed",
                source_rate_ratio=[1, 1],
            )
        )
        tail_samples = Fraction(row["sample_count"]) - Fraction(frames, 1) / rate * row["sample_rate"]
        evidence.append(
            dict(
                media_id=identity,
                day=matched_layout["day"],
                reference_media_ids=[r["media_id"] for r in reference_rows],
                waveform=result,
                quantization_error_frames=[
                    (Fraction(at) - at_exact).numerator,
                    (Fraction(at) - at_exact).denominator,
                ],
                omitted_tail_samples=[max(0, tail_samples.numerator), tail_samples.denominator],
            )
        )

    if not placements:
        reason = next(
            (r["reason"] for r in evidence if r.get("status") == "unresolved"),
            "no_unambiguous_bounded_waveform_match",
        )
        return pending(reason)
    if prior and (
        unresolved
        or {p["media_id"] for p in prior.get("placements", [])} - {p["media_id"] for p in placements}
    ):
        return pending("partial_result_existing_authority_preserved")

    placements = _pack_recording_tracks(placements)
    workspace_id, project_id, task_id = context
    check_cancelled()
    DeviceMediaStore().scan(
        workspace_id,
        project_id,
        {"clips": [{"media_id": p["media_id"], "name": p["name"]} for p in placements]},
        [str(root) for root in roots],
        cancelled=lambda: (check_cancelled() or False),
    )
    alignment = dict(
        status="confirmed",
        sync_task_id=task_id,
        confirmation_source="automatic_waveform.v1",
        method="waveform_alignment_not_lip_sync_verification",
        placements=placements,
        evidence=evidence,
        unresolved_media_ids=unresolved,
        coverage="partial" if unresolved else "discovered_candidates_only",
    )
    diagnostics = [
        {
            "code": "waveform_alignment_partial" if unresolved else "waveform_alignment_completed",
            "message": f"已自动波形对齐 {len(placements)} 段原 WAV，未解 {len(unresolved)} 条；已打包写入独立音轨。",
        }
    ]
    return alignment, diagnostics
