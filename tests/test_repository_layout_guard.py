from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]

ARCHITECTURE_DOCS = (
    "docs/architecture/README.md",
    "docs/architecture/repository-layout.md",
    "docs/architecture/desktop-bridge.md",
    "docs/architecture/sync-model.md",
    "docs/architecture/automation-pipeline.md",
    "docs/architecture/local-intelligence.md",
)

ENGINEERING_DOCS = (
    "docs/engineering/README.md",
    "docs/engineering/STATUS.md",
    "docs/engineering/BACKLOG.md",
    "docs/engineering/DECISIONS.md",
    "docs/engineering/INVARIANTS.md",
    "docs/engineering/PYTHON_PACKAGE_PLAN.md",
    "docs/engineering/INTEGRATION_PLAN.md",
)

LOCAL_GATES = (
    "scripts/check_python.py",
    "scripts/check_fast.py",
    "scripts/check_full.py",
)

LEGACY_ROOT_ARCHITECTURE_DOCS = (
    "AUTOMATION_PIPELINE.md",
    "DESKTOP_BRIDGE.md",
    "LOCAL_INTELLIGENCE.md",
    "SYNC_MODEL.md",
)

SHARED_STRUCTURED_SUFFIXES = {".json", ".toml", ".yaml", ".yml", ".csv", ".tsv"}
DEVICE_PATH_PATTERNS = (
    re.compile(r"(?<![A-Za-z0-9])/(?:Users|Volumes|home)/[^\s\"']+"),
    re.compile(r"(?i)file:///(?:Users|Volumes|home)/[^\s\"']+"),
    re.compile(r"(?i)(?<![A-Za-z0-9])[A-Z]:\\[^\s\"']+"),
)


def _git_available() -> bool:
    return (ROOT / ".git").exists() and shutil.which("git") is not None


def _git_ls_files(path: str = ".") -> list[str]:
    if not _git_available():
        return []
    result = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "--", path],
        capture_output=True,
        text=True,
        check=True,
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def _shared_structured_tracked_files() -> list[str]:
    tracked = _git_ls_files(".")
    if not tracked:
        return []
    result: list[str] = []
    for relative in tracked:
        path = Path(relative)
        if relative == "workspace.toml":
            result.append(relative)
            continue
        if path.parts[:2] == ("tests", "fixtures") and path.suffix.lower() in SHARED_STRUCTURED_SUFFIXES:
            result.append(relative)
    return sorted(result)


def _device_path_matches(text: str) -> list[str]:
    matches: list[str] = []
    for pattern in DEVICE_PATH_PATTERNS:
        matches.extend(match.group(0) for match in pattern.finditer(text))
    return matches


def test_cross_layer_architecture_docs_have_one_home() -> None:
    for relative in ARCHITECTURE_DOCS:
        assert (ROOT / relative).is_file(), relative
    for relative in LEGACY_ROOT_ARCHITECTURE_DOCS:
        assert not (ROOT / relative).exists(), relative


def test_engineering_control_layer_is_present() -> None:
    for relative in ENGINEERING_DOCS:
        assert (ROOT / relative).is_file(), relative
    for relative in LOCAL_GATES:
        assert (ROOT / relative).is_file(), relative


def test_live_workspace_projects_are_not_source_repository_files() -> None:
    ignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    assert any(line.strip() == "projects/*" for line in ignore.splitlines())
    assert any(line.strip() == "!projects/.gitkeep" for line in ignore.splitlines())
    assert (ROOT / "projects" / ".gitkeep").is_file()
    if _git_available():
        assert _git_ls_files("projects") == ["projects/.gitkeep"]


def test_repository_workspace_descriptor_is_path_neutral() -> None:
    workspace = (ROOT / "workspace.toml").read_text(encoding="utf-8")
    assert 'registry = "./projects/registry.json"' in workspace
    assert 'web_directory = "./web"' in workspace
    assert _device_path_matches(workspace) == []


def test_tracked_shared_structured_data_has_no_device_absolute_paths() -> None:
    if not _git_available():
        pytest.skip("tracked-file leakage guard requires a Git checkout")

    violations: list[str] = []
    for relative in _shared_structured_tracked_files():
        path = ROOT / relative
        text = path.read_text(encoding="utf-8")
        matches = _device_path_matches(text)
        if matches:
            violations.append(f"{relative}: {', '.join(sorted(set(matches)))}")

    assert violations == [], "tracked shared data leaked device-local absolute paths:\n" + "\n".join(violations)


def test_repository_entry_docs_point_to_normalized_paths() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    docs_readme = (ROOT / "docs" / "README.md").read_text(encoding="utf-8")

    assert "docs/architecture/repository-layout.md" in readme
    assert "docs/architecture/sync-model.md" in agents
    assert "docs/engineering/README.md" in readme
    assert "docs/engineering/README.md" in agents
    assert "engineering/README.md" in docs_readme

    for legacy in LEGACY_ROOT_ARCHITECTURE_DOCS:
        assert f"]({legacy})" not in readme
        assert f"`{legacy}`" not in agents
