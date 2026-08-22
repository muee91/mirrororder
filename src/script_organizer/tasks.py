from __future__ import annotations

# Compatibility module. The durable implementation lives in tasks_v2 so old
# imports used by the Host, MCP gateway, tests and local scripts keep working.
# Keep these literal names here as a cheap capability breadcrumb for older
# tooling that inspected this module as text.
COMPAT_TASK_TYPES = {
    "prepare_project",
    "multicam_sync",
    "incremental_analyze",
    "auto_resolve",
    "transcribe",
    "evidence_extract",
}

from .analysis_runtime import analyze as _default_analyze
from . import tasks_v2 as _impl

# Public compatibility symbol. Older tests/tools monkeypatch this name.
analyze = _default_analyze
TASK_TYPES = _impl.TASK_TYPES


class TaskManager(_impl.TaskManager):
    """Compatibility facade over the durable v2 task manager.

    Normal product execution goes straight through the v2 implementation. If
    an older integration monkeypatches `script_organizer.tasks.analyze`, mirror
    that override only for the lifetime of that compatibility task run.
    """

    def _run(self, project_id: str, task_id: str) -> None:
        if analyze is _default_analyze:
            return super()._run(project_id, task_id)
        previous = _impl.analyze
        _impl.analyze = analyze
        try:
            return super()._run(project_id, task_id)
        finally:
            _impl.analyze = previous


__all__ = ["TASK_TYPES", "TaskManager", "analyze", "COMPAT_TASK_TYPES"]
