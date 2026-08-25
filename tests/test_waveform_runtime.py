from __future__ import annotations

import struct

from script_organizer.waveform_runtime import (
    _decode_timeout,
    _peaks_from_pcm,
    _sample_count,
    _target_pcm_rate,
)


def test_waveform_sample_count_is_bounded() -> None:
    assert _sample_count(1) == 64
    assert _sample_count(512) == 512
    assert _sample_count(999999) == 4096
    assert _sample_count("bad") == 512


def test_waveform_peaks_are_normalized_and_bounded() -> None:
    samples = [0, 1000, -2000, 32767, -32768, 500, -500, 0]
    pcm = b"".join(struct.pack("<h", value) for value in samples)
    peaks = _peaks_from_pcm(pcm, 4)
    assert len(peaks) == 4
    assert peaks[0] == round(1000 / 32768, 5)
    assert peaks[1] == round(32767 / 32768, 5)
    assert peaks[2] == 1.0
    assert peaks[3] == round(500 / 32768, 5)


def test_waveform_empty_pcm_is_empty() -> None:
    assert _peaks_from_pcm(b"", 512) == []


def test_long_media_uses_low_decode_rate_instead_of_full_1khz_pcm() -> None:
    assert _target_pcm_rate(10.0, 512) == 615
    assert _target_pcm_rate(60.0 * 60.0 * 4.0, 512) == 4
    assert _target_pcm_rate(60.0 * 60.0 * 4.0, 4096) == 4


def test_waveform_timeout_scales_for_long_media_but_stays_bounded() -> None:
    assert _decode_timeout(0) == 60
    assert _decode_timeout(60) == 60
    assert 60 < _decode_timeout(60.0 * 60.0) <= 600
    assert _decode_timeout(60.0 * 60.0 * 24.0) == 600
