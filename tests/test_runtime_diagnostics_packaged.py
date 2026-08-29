from __future__ import annotations

from pathlib import Path

from script_organizer import runtime_diagnostics


def test_packaged_runtime_reports_bundled_multicam_provenance(
    monkeypatch,
    tmp_path: Path,
) -> None:
    engine = tmp_path / "multicam-audio-sync"
    engine.mkdir()

    monkeypatch.setattr(runtime_diagnostics, "_engine_candidates", lambda: [engine])
    monkeypatch.setattr(runtime_diagnostics, "_valid_engine", lambda candidate: candidate == engine)
    monkeypatch.setenv("MIRRORORDER_MULTICAM_SYNC_ROOT", str(engine))
    monkeypatch.setenv("MIRRORORDER_PACKAGED_RUNTIME", "1")

    status = runtime_diagnostics._engine_status()
    payload = runtime_diagnostics.environment_payload([])

    assert status["origin"] == "app-bundled"
    assert payload["multicam_engine"]["origin"] == "app-bundled"
    assert payload["packaged_runtime"] is True
