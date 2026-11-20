from fractions import Fraction

import numpy as np
import pytest

from script_organizer.recording_waveform_solver import WaveformReference, solve_recording_waveform

SR = 8000


def noise(seconds, seed=42):
    return np.random.default_rng(seed).uniform(-0.4, 0.4, SR * seconds).astype(np.float32)


def test_different_cameras_agree_on_exact_timeline_placement():
    common = noise(9)
    beginning = 3 * SR + 123
    original = common[beginning:beginning + 4 * SR]
    references = [
        WaveformReference("A", 100, common),
        WaveformReference("B", SR + 100, -0.6 * common[SR:] + noise(8, 55) * 0.02),
    ]

    result = solve_recording_waveform(original, references, SR)

    assert result["status"] == "aligned"
    assert result["method"] == "waveform_alignment"
    assert result["timeline_start_samples"] == beginning + 100
    assert Fraction(*result["timeline_start_seconds"]) == Fraction(beginning + 100, SR)
    assert result["recording_samples"] == original.size
    assert [len(item["windows"]) for item in result["evidence"]] == [4, 4]


@pytest.mark.parametrize("ambiguous", ["silent", "repeated"])
def test_rejects_silence_and_repeated_events(ambiguous):
    original = np.zeros(4 * SR, dtype=np.float32) if ambiguous == "silent" else np.tile(noise(1), 4)
    source = np.tile(original, 2)
    result = solve_recording_waveform(original, [WaveformReference("A", 0, source), WaveformReference("B", 0, source)], SR)
    assert result["status"] == "unresolved"
    assert "timeline_start_samples" not in result


def test_rejects_inconsistent_camera_coordinates():
    common = noise(8)
    original = common[SR:5 * SR]
    result = solve_recording_waveform(original, [WaveformReference("A", 0, common), WaveformReference("B", 82, common)], SR)
    assert result["reason"] == "cameras_disagree"


def test_rejects_time_varying_lag_even_with_high_local_correlations():
    common = noise(9)
    original = common[SR:5 * SR]
    # Add 8ms delay halfway through one camera waveform without perturbing edge windows.
    split = 3 * SR
    slipped = np.concatenate([common[:split], np.zeros(64, dtype=np.float32), common[split:]])
    result = solve_recording_waveform(original, [WaveformReference("A", 0, common), WaveformReference("B", 0, slipped)], SR)
    assert result["reason"] == "time_varying_lag"


def test_rejects_no_full_common_coverage_and_duplicate_camera():
    common = noise(9)
    original = common[SR:5 * SR]
    refs = [WaveformReference("A", 0, common), WaveformReference("B", 2 * SR, common[2 * SR:])]
    assert solve_recording_waveform(original, refs, SR)["status"] == "unresolved"
    refs[1] = WaveformReference("a ", 0, common)
    assert solve_recording_waveform(original, refs, SR)["reason"] == "duplicate_camera"


def test_rejects_unbounded_input_and_nan():
    ref = noise(5)
    refs = [WaveformReference("A", 0, ref), WaveformReference("B", 0, ref)]
    assert solve_recording_waveform(np.zeros(121 * SR, dtype=np.float32), refs, SR)["reason"] == "unsupported_recording"
    ref[10] = np.nan
    assert solve_recording_waveform(noise(4), refs, SR)["reason"] == "unsupported_reference_or_insufficient_coverage"


def long_fixture():
    # Reference clips are much shorter than the continuous 148s WAV and staggered
    # both across anchor positions and between cameras.
    common = noise(148, 61)
    head = 9 * SR + 202
    anchors = [0, 34, 72, 106, 144]
    windows = [(start * SR, common[start * SR:(start + 4) * SR]) for start in anchors]
    refs = []
    for index, (start, audio) in enumerate(windows):
        refs.append(WaveformReference("A", head + start - 600, np.r_[noise(1, index)[:600], audio, noise(1, index + 200)]))
        refs.append(WaveformReference("B", head + start - 1100, np.r_[noise(1, index + 20)[:1100], audio, noise(1, index + 220)]))
    return windows, common.size, refs, head


def test_long_distributed_anchors_align_without_full_source_or_camera_decode():
    from script_organizer.recording_waveform_solver import solve_long_recording

    windows, count, refs, head = long_fixture()
    result = solve_long_recording(windows, count, refs, SR)
    assert result["status"] == "aligned"
    assert result["scope"] == "dispersed_anchors_continuous_pcm"
    assert result["timeline_start_samples"] == head
    assert result["timeline_start_seconds"] == [36101, 4000]
    assert result["anchor_count"] == 5
    assert all(anchor["independent_camera_count"] == 2 for anchor in result["evidence"])


@pytest.mark.parametrize("problem,reason", [
    ("head", "insufficient_dispersed_anchors"),
    ("tail", "insufficient_dispersed_anchors"),
    ("silence", "insufficient_anchor_corroboration"),
    ("repeated", "ambiguous_camera_position"),
    ("drift", "time_varying_lag"),
    ("missing_camera", "insufficient_anchor_corroboration"),
    ("budget", "budget_incomplete"),
])
def test_long_solver_rejects_unproven_global_alignment(problem, reason, monkeypatch):
    from script_organizer import recording_waveform_solver as solver

    windows, count, refs, _ = long_fixture()
    if problem == "head":
        windows[0] = (2 * SR, windows[0][1])
    elif problem == "tail":
        windows[-1] = (windows[-1][0] - 2 * SR, windows[-1][1])
    elif problem == "silence":
        windows[2] = (windows[2][0], np.zeros(4 * SR, dtype=np.float32))
    elif problem == "repeated":
        first = refs[0]
        refs.append(WaveformReference(first.camera, first.timeline_start_samples + 18 * SR, first.samples))
    elif problem == "drift":
        for index in [-2, -1]:
            ref = refs[index]
            refs[index] = WaveformReference(ref.camera, ref.timeline_start_samples + SR // 100, ref.samples)
    elif problem == "missing_camera":
        refs.pop(-1)
    else:
        clock = iter([0.0, 46.0])
        monkeypatch.setattr(solver, "monotonic", lambda: next(clock))

    result = solver.solve_long_recording(windows, count, refs, SR)
    assert result["reason"] == reason
    assert "timeline_start_samples" not in result


def test_distributed_solver_accepts_exactly_twenty_seconds_in_five_windows():
    from script_organizer.recording_waveform_solver import solve_long_recording

    source = noise(20)
    windows = [(start, source[start:start + 4 * SR]) for start in range(0, source.size, 4 * SR)]
    result = solve_long_recording(
        windows, source.size, [WaveformReference("A", 5, source), WaveformReference("B", 5, -source)], SR,
    )
    assert result["status"] == "aligned"
    assert result["anchor_count"] == 5 and result["timeline_start_samples"] == 5
    assert solve_long_recording(windows, source.size - 1, [], SR)["reason"] == "unsupported_recording"
