from __future__ import annotations

# Compatibility module. The durable implementation lives in tasks_v2 so old
# imports used by the Host, MCP gateway and tests keep working.
# Supported task types include: prepare_project, multicam_sync,
# incremental_analyze, auto_resolve, transcribe, evidence_extract.
from .tasks_v2 import TASK_TYPES, TaskManager

__all__ = ["TASK_TYPES", "TaskManager"]
