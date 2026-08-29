from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

ARCHITECTURE_DOCS = (
    "docs/architecture/README.md",
    "docs/architecture/repository-layout.md",
    "docs/architecture/desktop-bridge.md",
    "docs/architecture/sync-model.md",
    "docs/architecture/automation-pipeline.md",
    "docs/architecture/local-intelligence.md",
)

LEGACY_ROOT_ARCHITECTURE_DOCS = (
    "AUTOMATION_PIPELINE.md",
    "DESKTOP_BRIDGE.md",
    "LOCAL_INTELLIGENCE.md",
    "SYNC_MODEL.md",
)


def _git_ls_files(path: str) -> list[str]:
    if not (ROOT / ".git").exists() or shutil.which("git") is None:
        return []
    result = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "--", path],
        capture_output=True,
        text=True,
        check=True,
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def test_cross_layer_architecture_docs_have_one_home() -> None:
    for relative in ARCHITECTURE_DOCS:
        assert (ROOT / relative).is_file(), relative
    for relative in LEGACY_ROOT_ARCHITECTURE_DOCS:
        assert not (ROOT / relative).exists(), relative


def test_live_workspace_projects_are_not_source_repository_files() -> None:
    ignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    assert any(line.strip() == "projects/" for line in ignore.splitlines())
    assert _git_ls_files("projects") == []


def test_repository_workspace_descriptor_is_path_neutral() -> None:
    workspace = (ROOT / "workspace.toml").read_text(encoding="utf-8")
    assert 'registry = "./projects/registry.json"' in workspace
    assert 'web_directory = "./web"' in workspace
    for device_path_marker in ("/Volumes/", "/Users/", "C:\\Users\\"):
        assert device_path_marker not in workspace


def test_repository_entry_docs_point_to_normalized_architecture_paths() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    assert "docs/architecture/repository-layout.md" in readme
    assert "docs/architecture/sync-model.md" in agents
    for legacy in LEGACY_ROOT_ARCHITECTURE_DOCS:
        assert f"]({legacy})" not in readme
        assert f"`{legacy}`" not in agents
