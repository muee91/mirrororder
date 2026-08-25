from __future__ import annotations

from pathlib import Path


def test_material_card_projection_is_team_web_safe_and_idempotent() -> None:
    root = Path(__file__).resolve().parents[1]
    source = (root / "web" / "material_card_ui.js").read_text(encoding="utf-8")

    # Team Web must consume the already-loaded review.v1 projection instead of
    # calling the Host-only Script Supervisor API.
    assert "state?.groups" in source
    assert "/script-supervisor" not in source
    assert "fetchJson(" not in source

    # MutationObserver decoration must not recursively mutate the same chip on
    # every callback. Both the write guard and mutation-target guard are part of
    # the runtime safety contract because this previously froze first paint.
    assert "if (chip.textContent !== label) chip.textContent = label" in source
    assert "target.closest('.shot-type-chip')" in source
    assert "records.some(mutationNeedsDecoration)" in source


def test_review_model_exposes_shot_type_to_material_projection() -> None:
    root = Path(__file__).resolve().parents[1]
    adapter = (root / "web" / "review_model.js").read_text(encoding="utf-8")
    assert "shot_type: angle.shot_type || 'unknown'" in adapter
    assert "state.groups = (model.take_groups || []).map" in adapter
