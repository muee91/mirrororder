from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_python_package_migration_is_explicitly_deferred_during_product_recovery() -> None:
    invariants = (ROOT / "docs" / "engineering" / "INVARIANTS.md").read_text(encoding="utf-8")
    agents = (ROOT / "AGENTS.md").read_text(encoding="utf-8")

    assert "src/script_organizer/" in invariants
    assert "flat namespace" in invariants
    assert "runtime_stack.py" in invariants
    assert "Product Recovery 期间不进行与五步主链无关的大规模 package migration" in invariants
    assert "Product Recovery 期间不启动与主链无关的大规模 package migration" in agents


def test_python_build_contract_uses_setuptools_src_layout() -> None:
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert 'build-backend = "setuptools.build_meta"' in pyproject
    assert 'pythonpath = ["src"]' in pyproject
    assert 'script-organizer = "script_organizer.cli:main"' in pyproject


def test_desktop_runtime_staging_recursively_copies_script_organizer() -> None:
    staging = (ROOT / "desktop" / "scripts" / "stage-runtime.mjs").read_text(encoding="utf-8")
    assert 'const organizerSource = path.join(repoRoot, "src", "script_organizer")' in staging
    assert 'copyDirectory(organizerSource, path.join(coreTarget, "src", "script_organizer"))' in staging
    assert "recursive: true" in staging


def test_runtime_stack_remains_the_explicit_composition_root() -> None:
    stack = (ROOT / "src" / "script_organizer" / "runtime_stack.py").read_text(encoding="utf-8")
    assert "RUNTIME_INSTALL_ORDER" in stack
    assert "def install_production_runtime()" in stack
    assert "from .delivery_runtime import install_delivery_runtime" in stack
    assert "from .media_inventory_task_runtime import install_media_inventory_task_runtime" in stack
