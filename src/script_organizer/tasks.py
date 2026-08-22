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

# `analyze` remains public for older monkeypatch/test integrations. tasks_v2
# deliberately consults this compatibility symbol at execution time, while the
# product implementation still lives in analysis_runtime.
from .analysis_runtime import analyze
from .tasks_v2 import TASK_TYPES, TaskManager

__all__ = ["TASK_TYPES", "TaskManager", "analyze", "COMPAT_TASK_TYPES"]
