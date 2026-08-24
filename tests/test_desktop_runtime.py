from __future__ import annotations

from pathlib import Path

import pytest

from script_organizer.desktop_runtime import _normalize_roots, _workspace_root


def test_normalize_roots_deduplicates_and_resolves(tmp_path: Path) -> None:
    first = tmp_path / "A"
    second = tmp_path / "B"
    first.mkdir()
    second.mkdir()
    roots = _normalize_roots([str(first), str(first), str(second)])
    assert roots == [str(first.resolve()), str(second.resolve())]


def test_normalize_roots_requires_existing_directory(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="媒体目录不存在"):
        _normalize_roots([str(tmp_path / "missing")])
    with pytest.raises(ValueError, match="至少选择一个"):
        _normalize_roots([])


def test_workspace_root_uses_workspace_config_parent(tmp_path: Path) -> None:
    class Workspace:
        config_path = tmp_path / "workspace.toml"

    class Service:
        workspace = Workspace()

    assert _workspace_root(Service()) == tmp_path
