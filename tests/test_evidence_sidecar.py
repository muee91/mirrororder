import json
from pathlib import Path

from script_organizer.analysis_runtime import _maybe_write_shot_evidence
from script_organizer.config import ProjectConfig


def test_shot_evidence_is_opt_in_and_writes_an_atomic_manifest(tmp_path: Path, monkeypatch) -> None:
    config = ProjectConfig(
        tmp_path / "project.toml",
        "demo",
        None,
        tmp_path / "script.txt",
        tmp_path / "output",
        tmp_path / "transcripts",
        input_kind="media-directory",
        media_root=None,
    )
    monkeypatch.setenv("MIRRORORDER_SHOT_DETECTOR", "pyscenedetect")
    _maybe_write_shot_evidence(config, {"index": {"clips": []}})
    payload = json.loads((tmp_path / "output" / "evidence.sidecar.json").read_text(encoding="utf-8"))
    assert payload["schema"] == "mirrororder.evidence.v1"
    assert payload["sidecars"] == []
