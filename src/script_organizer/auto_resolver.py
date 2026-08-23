from __future__ import annotations

# Mapping automation remains separate from editorial Best/Keep/Reject. V3 adds
# device-local confirmed role evidence only after the shared deterministic/model
# resolver has produced its normal decisions.
from .auto_resolver_v3 import resolve_project

__all__ = ["resolve_project"]
