"""Conservative direct-source waveform alignment, not lip-sync verification."""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from fractions import Fraction
from time import monotonic
from typing import Any

import numpy as np
from scipy.signal import correlate


@dataclass(frozen=True)
class WaveformReference:
    camera: str
    # Position of reference sample zero on the same integral master sample grid.
    timeline_start_samples: int
    samples: np.ndarray


def _signal(samples: np.ndarray, minimum: int, maximum: int) -> bool:
    return (
        isinstance(samples, np.ndarray)
        and samples.ndim == 1
        and minimum <= samples.size <= maximum
        and samples.dtype.kind == "f"
        and bool(np.isfinite(samples).all())
        and float(np.max(np.abs(samples))) <= 1.01
    )


def _emphasize(samples: np.ndarray) -> np.ndarray:
    return samples[1:].astype(np.float64) - 0.95 * samples[:-1]


def _match(
    search: np.ndarray, pattern: np.ndarray, energy: np.ndarray, sample_rate: int,
) -> tuple[int, float, float] | None:
    template = pattern - pattern.mean()
    magnitude = np.linalg.norm(template)
    if magnitude < 1e-5 * np.sqrt(template.size):
        return None
    numerator = correlate(search, template, mode="valid", method="fft")
    denom = magnitude * np.sqrt(energy)
    scores = np.zeros_like(numerator)
    np.divide(np.abs(numerator), denom, out=scores, where=denom > magnitude * 1e-5 * np.sqrt(template.size))
    win = int(np.argmax(scores))
    peak = min(1.0, float(scores[win]))
    # Ignore equivalent neighboring samples but not repeated events (beats, room tone).
    neighborhood = max(1, sample_rate // 100)
    alternate = max(float(np.max(scores[:max(0, win-neighborhood)], initial=0)),
                    float(np.max(scores[win+neighborhood+1:], initial=0)))
    if peak < 0.60 or alternate >= peak - 0.10:
        return None
    return win, peak, alternate


def solve_recording_waveform(
    recording_samples: np.ndarray,
    references: Sequence[WaveformReference],
    sample_rate: int,
) -> dict[str, Any]:
    """Return placement evidence only, from 4–120s of an original mono recording.

    Require 2–4 distinct camera identities, independently timed by the caller.
    Each contiguous reference is at most 180s and must cover the entire recording
    at the solved position. Caller checks camera identity/decode clocks, master
    gaps, and target range. Existing media offsets are never edited here.
    """

    def failed(reason: str) -> dict[str, Any]:
        return {"status": "unresolved", "reason": reason, "method": "waveform_alignment"}

    if sample_rate not in (8000, 16000):
        return failed("unsupported_sample_rate")
    if not 2 <= len(references) <= 4:
        return failed("insufficient_or_excess_references")
    if any(not isinstance(ref.camera, str) or not ref.camera.strip()
           or type(ref.timeline_start_samples) is not int for ref in references):
        return failed("invalid_reference")
    if len({ref.camera.strip().casefold() for ref in references}) != len(references):
        return failed("duplicate_camera")
    if not _signal(recording_samples, 4 * sample_rate, 120 * sample_rate):
        return failed("unsupported_recording")
    if any(not _signal(ref.samples, recording_samples.size, 180 * sample_rate) for ref in references):
        return failed("unsupported_reference_or_insufficient_coverage")

    sample_count = recording_samples.size
    width = sample_rate - 1
    starts = [i * (sample_count - sample_rate) // 3 for i in range(4)]
    # Build one template at each end and two in the interior without overlapping.
    windows = [_emphasize(recording_samples[start:start + sample_rate]) for start in starts]
    evidence: list[dict[str, Any]] = []
    estimates: list[int] = []
    bound = sample_rate // 200  # <=5ms within each camera; no inferred retiming.
    for ref in references:
        search = _emphasize(ref.samples)
        sums = np.r_[0.0, np.cumsum(search)]
        squares = np.r_[0.0, np.cumsum(search ** 2)]
        means = sums[width:] - sums[:-width]
        energy = np.maximum(0.0, squares[width:] - squares[:-width] - means ** 2 / width)
        local_offsets, observed = [], []
        for start, window in zip(starts, windows):
            match = _match(search, window, energy, sample_rate)
            if match is None:
                return failed("weak_or_ambiguous_waveform")
            index, peak, alternate = match
            local_offset = index - start
            if local_offset < 0 or local_offset + sample_count > ref.samples.size:
                return failed("insufficient_coverage")
            local_offsets.append(local_offset)
            observed.append({
                "recording_offset_samples": start, "reference_offset_samples": index,
                "correlation": round(peak, 6), "alternate_correlation": round(alternate, 6),
            })
        if max(local_offsets) - min(local_offsets) > bound:
            return failed("time_varying_lag")
        middle = sorted(local_offsets)
        local = (middle[1] + middle[2]) // 2
        estimates.append(ref.timeline_start_samples + local)
        evidence.append({"camera": ref.camera, "windows": observed, "timeline_start_samples": estimates[-1]})

    if max(estimates) - min(estimates) > sample_rate // 100:
        return failed("cameras_disagree")
    target = (min(estimates) + max(estimates)) // 2
    if any(target < ref.timeline_start_samples
           or target + sample_count > ref.timeline_start_samples + ref.samples.size for ref in references):
        return failed("insufficient_common_coverage")

    seconds = Fraction(target, sample_rate)
    return {"status": "aligned", "reason": "", "method": "waveform_alignment",
            "sample_rate": sample_rate, "timeline_start_samples": target,
            "timeline_start_seconds": [seconds.numerator, seconds.denominator],
            "recording_samples": sample_count, "evidence": evidence}


def solve_long_recording(
    windows: Sequence[tuple[int, np.ndarray]],
    original_sample_count: int,
    references: Sequence[WaveformReference],
    sample_rate: int,
    check_cancelled=lambda: None,
) -> dict[str, Any]:
    """Infer one 1:1 offset from dispersed anchors on a continuous original PCM file (20s minimum).

    This only validates anchor evidence. The caller must independently establish
    original file continuity and exact decode/clock/placement coordinates. The
    inference is neither exhaustive sample verification nor audiovisual proof.
    """
    method = "waveform_alignment"
    scope = "dispersed_anchors_continuous_pcm"

    def failed(reason: str) -> dict[str, Any]:
        return {"status": "unresolved", "reason": reason, "method": method, "scope": scope}

    if sample_rate not in (8000, 16000):
        return failed("unsupported_sample_rate")
    if type(original_sample_count) is not int or original_sample_count < 20 * sample_rate:
        return failed("unsupported_recording")
    if len(references) > 64 or len(windows) > 9:
        return failed("budget_incomplete")
    if not 5 <= len(windows):
        return failed("insufficient_dispersed_anchors")
    if any(type(start) is not int or start < 0
           or not _signal(signal, 4 * sample_rate, 8 * sample_rate)
           or start + signal.size > original_sample_count
           for start, signal in windows):
        return failed("invalid_original_window")
    ordered = sorted(windows, key=lambda entry: entry[0])
    ends = [start + signal.size for start, signal in ordered]
    if (ordered[0][0] > sample_rate or ends[-1] < original_sample_count - sample_rate
            or any(right[0] < end or (right[0] - end) * 3 > original_sample_count
                   for right, end in zip(ordered[1:], ends))
            or not any(original_sample_count * 2 <= 5 * start <= original_sample_count * 3
                       for start, _ in ordered)):
        return failed("insufficient_dispersed_anchors")

    if any(not isinstance(ref.camera, str) or not ref.camera.strip()
           or type(ref.timeline_start_samples) is not int for ref in references):
        return failed("invalid_reference")
    if len({ref.camera.strip().casefold() for ref in references}) < 2:
        return failed("insufficient_references")
    if any(not _signal(ref.samples, 4 * sample_rate, 180 * sample_rate) for ref in references):
        return failed("unsupported_reference")
    # Work units approximate the sum of FFT input sizes, rather than sample
    # coverage. The wall limit is checked between bounded individual calls.
    work = 0
    work_limit = 192_000_000
    deadline = monotonic() + 45
    spread_limit = max(1, sample_rate // 200)
    width = sample_rate - 1
    estimates: list[int] = []
    evidence: list[dict[str, Any]] = []
    for start, signal in ordered:
        check_cancelled()
        positions = [i * (signal.size - sample_rate) // 3 for i in range(4)]
        templates = [_emphasize(signal[index:index + sample_rate]) for index in positions]
        candidates: dict[str, list[dict[str, Any]]] = {}
        for ref in references:
            check_cancelled()
            if ref.samples.size < signal.size:
                continue
            if work + ref.samples.size * 4 > work_limit or monotonic() >= deadline:
                return failed("budget_incomplete")
            work += ref.samples.size * 4
            search = _emphasize(ref.samples)
            sums = np.r_[0.0, np.cumsum(search)]
            squares = np.r_[0.0, np.cumsum(search ** 2)]
            totals = sums[width:] - sums[:-width]
            energy = np.maximum(0.0, squares[width:] - squares[:-width] - totals ** 2 / width)
            local_offsets, observed = [], []
            for position, pattern in zip(positions, templates):
                if monotonic() >= deadline:
                    return failed("budget_incomplete")
                match = _match(search, pattern, energy, sample_rate)
                if match is None:
                    break
                index, peak, alternate = match
                local_offsets.append(index - position)
                observed.append({
                    "recording_offset_samples": start + position,
                    "reference_offset_samples": index,
                    "correlation": round(peak, 6),
                    "alternate_correlation": round(alternate, 6),
                })
            if len(local_offsets) != 4:
                continue
            if any(offset < 0 or offset + signal.size > ref.samples.size for offset in local_offsets):
                continue
            if max(local_offsets) - min(local_offsets) > spread_limit:
                return failed("time_varying_lag")
            canonical = ref.camera.strip().casefold()
            camera_candidates = candidates.setdefault(canonical, [])
            implied = [ref.timeline_start_samples + offset - start for offset in local_offsets]
            if camera_candidates:
                # Overlapping input references may repeat the same physical evidence.
                # Distinct plausible positions from the same camera are not equivalent.
                prior = [v for item in camera_candidates for v in item["implied_start_samples"]]
                if max(prior + implied) - min(prior + implied) > spread_limit:
                    return failed("ambiguous_camera_position")
            camera_candidates.append({"camera": ref.camera, "reference_start_samples": ref.timeline_start_samples,
                                      "implied_start_samples": implied, "windows": observed})

        if len(candidates) < 2:
            return failed("insufficient_anchor_corroboration")
        anchor_evidence = [candidate for group in candidates.values() for candidate in group]
        position_estimates = [value for item in anchor_evidence for value in item["implied_start_samples"]]
        if max(position_estimates) - min(position_estimates) > spread_limit:
            return failed("cameras_disagree")
        estimates.extend(position_estimates)
        if max(estimates) - min(estimates) > spread_limit:
            return failed("time_varying_lag")
        evidence.append({"recording_window_start_samples": start, "recording_window_samples": signal.size,
                         "independent_camera_count": len(candidates), "references": anchor_evidence})

    if monotonic() >= deadline:
        return failed("budget_incomplete")
    target = (min(estimates) + max(estimates)) // 2
    seconds = Fraction(target, sample_rate)
    return {"status": "aligned", "reason": "", "method": method, "scope": scope, "sample_rate": sample_rate,
            "timeline_start_samples": target, "timeline_start_seconds": [seconds.numerator, seconds.denominator],
            "recording_samples": original_sample_count, "anchor_count": len(evidence),
            "observed_offset_spread_samples": max(estimates) - min(estimates), "evidence": evidence}
