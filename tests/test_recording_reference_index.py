import os

import numpy as np

from script_organizer.recording_reference_index import build_recording_reference_candidates, normalize_waveform_samples

RATE = 16000


def _audio(seconds, seed):
    rng = np.random.default_rng(seed)
    # Time-varying spectral content similar in the two copies of the event.
    seconds_grid = np.arange(RATE // 4) / RATE
    return np.concatenate([0.3 * np.sin(2 * np.pi * rng.integers(80, 2400) * seconds_grid)
                           for _ in range(seconds * 4)]).astype("<f4")


def _row(root, index, camera, data):
    file = root / f"take-{index}.f32"
    data.tofile(file)
    return {"media_id": f"M_{index}", "camera": camera, "cache_path": file,
            "timeline_start_samples": index * RATE}


def test_all_sources_scanned_and_late_matches_found_with_cached_features(tmp_path):
    cache = tmp_path / "fingerprints"
    rows = [_row(tmp_path, index, "AB"[index % 2], _audio(5, index)) for index in range(68)]
    event = _audio(4, 2222)
    positive = np.r_[_audio(1, 500), event, _audio(1, 501)]
    rows += [_row(tmp_path, 68, "A", positive), _row(tmp_path, 69, "B", positive * 0.8)]
    windows = [(0, event)]
    first = build_recording_reference_candidates(rows, windows, cache, RATE)
    assert first.complete and first.metadata["files"] == 70
    assert first.metadata["cache_hits"] == 0
    assert {v.timeline_start_samples for v in first.references} >= {68 * RATE, 69 * RATE}
    assert all(len(v.samples) <= 30 * RATE for v in first.references)
    assert len(first.references) <= 64

    second = build_recording_reference_candidates(rows, windows, cache, RATE)
    assert second.complete and second.metadata["cache_hits"] == 70

    cache_file = rows[-1]["cache_path"]
    stat = cache_file.stat()
    os.utime(cache_file, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
    third = build_recording_reference_candidates(rows, windows, cache, RATE)
    assert third.complete and third.metadata["cache_hits"] == 69


def test_incomplete_scan_does_not_leak_candidates(tmp_path):
    row = _row(tmp_path, 100, "A", _audio(5, 100))
    missing = {**row, "cache_path": tmp_path / "missing.f32"}
    result = build_recording_reference_candidates([row, missing], [(0, _audio(4, 100))], tmp_path / "fp", RATE)
    assert not result.complete and not result.references
    assert result.reason == "reference_cache_unavailable"


def test_overshoot_normalization_preserves_original_shape():
    signal = np.asarray([0.3, -1.2, 0.8], dtype=np.float32)
    normalized = normalize_waveform_samples(signal)
    np.testing.assert_allclose(normalized * 1.2, signal)
    assert np.max(np.abs(normalized)) <= 1.0


def test_cancelled_scan_propagates_without_reporting_complete(tmp_path):
    import pytest
    from script_organizer.resource_scheduler import ResourceCancelled

    count = 0

    def cancel():
        nonlocal count
        count += 1
        if count >= 3:
            raise ResourceCancelled("stop")

    row = _row(tmp_path, 1, "A", _audio(5, 100))
    with pytest.raises(ResourceCancelled, match="stop"):
        build_recording_reference_candidates(
            [row], [(0, _audio(4, 100))], tmp_path / "fp", RATE, check_cancelled=cancel,
        )


def test_same_video_cannot_be_ranked_as_independent_cameras(tmp_path):
    row = _row(tmp_path, 1, "A", _audio(5, 100))
    result = build_recording_reference_candidates([row, {**row, "camera": "B"}],
                                                  [(0, _audio(4, 100))], tmp_path / "fp", RATE)
    assert not result.complete and result.reason == "conflicting_reference_identity"
