from __future__ import annotations

import json
import struct
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from script_organizer import waveform_runtime
from script_organizer.resource_scheduler import ResourceCancelled
from script_organizer.waveform_runtime import (
    _cache_path,
    _cached_payload,
    _decode_timeout,
    _peaks_from_pcm,
    _run_process,
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


def _project(tmp_path: Path) -> SimpleNamespace:
    clip = {
        "clip_id": "clip_a",
        "media_id": "M_abc",
        "media_path": "/Volumes/PROJECT/A001.mov",
        "name": "A001.mov",
    }
    return SimpleNamespace(
        clips={"clip_a": clip},
        config=SimpleNamespace(output_dir=tmp_path),
    )


def test_cached_waveform_get_reads_only_cache_and_never_probes_media(tmp_path: Path, monkeypatch) -> None:
    project = _project(tmp_path)
    payload = {
        "contract": "waveform.v1",
        "clip_id": "clip_a",
        "samples": 2,
        "requested_samples": 640,
        "sample_rate": 100,
        "duration": 5.0,
        "decode_timeout_seconds": 60,
        "peaks": [0.1, 0.2],
        "derived": True,
        "editorial_authority": False,
        "source_fingerprint": "abc",
    }
    cache = _cache_path(tmp_path, "clip_a", project.clips["clip_a"], 640)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(payload), encoding="utf-8")

    def fail(*_args, **_kwargs):
        raise AssertionError("waveform GET must not touch media or launch FFmpeg")

    monkeypatch.setattr(waveform_runtime, "_probe_duration", fail)
    monkeypatch.setattr(waveform_runtime, "_decode_pcm", fail)
    monkeypatch.setattr(waveform_runtime.DeviceMediaStore, "resolve", fail)

    assert _cached_payload(project, "clip_a", 640) == payload


def test_waveform_cache_miss_is_read_only(tmp_path: Path, monkeypatch) -> None:
    project = _project(tmp_path)

    def fail(*_args, **_kwargs):
        raise AssertionError("cache miss must stay read-only")

    monkeypatch.setattr(waveform_runtime, "_probe_duration", fail)
    monkeypatch.setattr(waveform_runtime, "_decode_pcm", fail)
    monkeypatch.setattr(waveform_runtime.DeviceMediaStore, "resolve", fail)

    assert _cached_payload(project, "clip_a", 640) is None


def test_waveform_worker_process_observes_durable_task_cancellation(monkeypatch) -> None:
    class FakeProcess:
        returncode = None
        terminated = False
        killed = False

        def poll(self):
            return None if not self.terminated and not self.killed else -15

        def communicate(self, timeout=None):
            if self.terminated or self.killed:
                self.returncode = -15
                return b"", b""
            raise subprocess.TimeoutExpired(["ffmpeg"], timeout or 0)

        def terminate(self):
            self.terminated = True

        def kill(self):
            self.killed = True

    process = FakeProcess()
    monkeypatch.setattr(subprocess, "Popen", lambda *_args, **_kwargs: process)

    with pytest.raises(ResourceCancelled):
        _run_process(["ffmpeg", "-version"], timeout=60, cancel_check=lambda: True)
    assert process.terminated is True


def test_waveform_runtime_contract_keeps_get_read_only_and_build_durable() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "src" / "script_organizer" / "waveform_runtime.py").read_text(encoding="utf-8")

    assert "subprocess.run(" not in runtime
    assert "cached = _cached_payload(project, clip_id, samples)" in runtime
    assert 'raise web_server.ApiError(web_server.HTTPStatus.NOT_FOUND, "waveform 尚未生成")' in runtime
    assert 'task_runtime.TASK_TYPES.add(_TASK_TYPE)' in runtime
    assert 'manager._resource(config, task, "cpu", "waveform", "波形生成")' in runtime
    assert 'cancel_check=lambda: manager._cancel_requested(config, task_id)' in runtime
    assert '{"clip_id": clip_id, "samples": samples}' in runtime
    assert '"contract": "waveform_build.v1"' in runtime
    assert 'web_server.HTTPStatus.ACCEPTED' in runtime
