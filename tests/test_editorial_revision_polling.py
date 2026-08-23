from __future__ import annotations

from pathlib import Path


def test_review_web_polls_editorial_revision_through_state_projection() -> None:
    root = Path(__file__).resolve().parents[1]
    adapter = (root / "web" / "review_model.js").read_text(encoding="utf-8")
    runtime = (root / "src" / "script_organizer" / "editorial_runtime.py").read_text(encoding="utf-8")

    assert 'payload["editorial_revision"]' in runtime
    assert "editorialChanged" in adapter
    assert "analysisChanged || reviewChanged || editorialChanged" in adapter
