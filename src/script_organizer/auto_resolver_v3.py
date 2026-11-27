from __future__ import annotations

from typing import Any, Callable

from .auto_resolver_v2 import resolve_project as _resolve_project_v2
from .config import ProjectConfig
from .identity_rescue import apply_identity_rescue
from .model_provider import ModelProvider
from .vision_provider import VisionProvider


def resolve_project(
    config: ProjectConfig,
    provider: ModelProvider | None = None,
    vision_provider: VisionProvider | None = None,
    *,
    workspace_id: str = "",
    project_id: str = "",
    visual_group_ids: set[str] | None = None,
    progress: Callable[[int, int], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> dict[str, Any]:
    """Run deterministic/model rescue, then add safe device-local role evidence.

    The local layer never changes matches.json and only upgrades or annotates
    decisions that remain ambiguous/unresolved after the shared resolver.
    """
    result = _resolve_project_v2(
        config, provider=provider, vision_provider=vision_provider,
        workspace_id=workspace_id, project_id=project_id, visual_group_ids=visual_group_ids,
        progress=progress, cancelled=cancelled,
    )
    try:
        return apply_identity_rescue(config, result)
    except Exception:
        # Device-local intelligence is rebuildable enhancement only.
        return result
