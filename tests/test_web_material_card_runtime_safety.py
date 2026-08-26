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

    # Human Slate evidence is carried inside review.v1 and should override only
    # the material-card shot display, not Review mapping authority.
    assert "group?.script_supervisor?.angles || {}" in source
    assert "supervisorAngles?.[clipId]?.shot_type" in source
    assert "supervisorType || member?.shot_type" in source

    # MutationObserver decoration must not recursively mutate the same chip on
    # every callback. Both the write guard and mutation-target guard are part of
    # the runtime safety contract because this previously froze first paint.
    assert "if (chip.textContent !== label) chip.textContent = label" in source
    assert "target.closest('.shot-type-chip')" in source
    assert "records.some(mutationNeedsDecoration)" in source


def test_review_model_carries_both_angle_and_script_supervisor_projection() -> None:
    root = Path(__file__).resolve().parents[1]
    adapter = (root / "web" / "review_model.js").read_text(encoding="utf-8")
    runtime = (root / "src" / "script_organizer" / "script_supervisor_runtime.py").read_text(encoding="utf-8")
    assert "shot_type: angle.shot_type || 'unknown'" in adapter
    assert "script_supervisor: supervisor" in adapter
    assert "state.groups = (model.take_groups || []).map" in adapter
    assert 'take["script_supervisor"] = _safe_entry(entries.get(group_id))' in runtime
