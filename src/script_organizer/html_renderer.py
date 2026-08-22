from __future__ import annotations

from pathlib import Path


def web_root() -> Path:
    """Return the static review UI root; business data stays in JSON APIs."""
    return Path(__file__).resolve().parents[2] / "web"
