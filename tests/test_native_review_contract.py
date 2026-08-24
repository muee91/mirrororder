from __future__ import annotations

from script_organizer.script_supervisor_runtime import _safe_automatic_state


def test_sparse_automatic_state_is_safe_for_atomic_native_decode() -> None:
    row = _safe_automatic_state({"available": False})
    assert row == {
        "available": False,
        "status": "",
        "reason": "",
        "confidence": 0.0,
        "episode_ids": [],
    }


def test_automatic_state_preserves_valid_values_and_sanitizes_episode_ids() -> None:
    row = _safe_automatic_state(
        {
            "available": True,
            "status": "auto_confirmed",
            "reason": "对白和顺序一致",
            "confidence": "0.96",
            "episode_ids": [24, "24", "bad", 0, 25],
            "mapping_source": "deterministic",
        }
    )
    assert row["available"] is True
    assert row["status"] == "auto_confirmed"
    assert row["confidence"] == 0.96
    assert row["episode_ids"] == [24, 25]
    assert row["mapping_source"] == "deterministic"
