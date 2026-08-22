from __future__ import annotations

# Compatibility import: mapping automation is intentionally separate from
# editorial Best/Keep/Reject decisions in review.json.
from .auto_resolver_v2 import resolve_project

__all__ = ["resolve_project"]
