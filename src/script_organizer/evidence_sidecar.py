"""Atomic persistence for provider evidence sidecars."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any, Iterable

from .evidence_contract import CONTRACT, EvidenceSidecar

SIDECAR_FILENAME = "evidence.sidecar.json"


def write_sidecar_manifest(
    output_dir: str | Path,
    sidecars: Iterable[EvidenceSidecar],
    *,
    diagnostics: Iterable[dict[str, Any]] = (),
    revision: str = "",
) -> Path:
    """Write provider evidence atomically without changing authority stores."""
    payload = {
        "schema": CONTRACT,
        "version": 1,
        "revision": str(revision or ""),
        "sidecars": [item.to_dict() for item in sidecars],
        "diagnostics": [dict(item) for item in diagnostics],
    }
    path = Path(output_dir) / SIDECAR_FILENAME
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return path
