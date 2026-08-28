from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_semantic_search_and_assistant_reads_never_refresh_inline() -> None:
    runtime = (ROOT / "src/script_organizer/semantic_runtime.py").read_text(encoding="utf-8")

    assert "refresh=True" not in runtime
    assert runtime.count("refresh=False") >= 4
    assert 'tasks_module.TASK_TYPES.add("semantic_index")' in runtime
    assert 'manager.submit(\n                project_id,\n                "semantic_index"' in runtime
