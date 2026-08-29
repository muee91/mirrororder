from __future__ import annotations

from pathlib import Path


def test_editorial_runtime_public_imports() -> None:
    from script_organizer.editorial_runtime import install_editorial_runtime
    from script_organizer.editorial_store import EditorialConflictError, EditorialStore

    assert callable(install_editorial_runtime)
    assert EditorialStore.__name__ == "EditorialStore"
    assert EditorialConflictError.__name__ == "EditorialConflictError"


def test_editorial_runtime_does_not_bootstrap_unrelated_runtime_layers() -> None:
    root = Path(__file__).resolve().parents[1]
    source = (root / "src" / "script_organizer" / "editorial_runtime.py").read_text(encoding="utf-8")
    for forbidden in (
        "install_audit_runtime",
        "install_script_supervisor_runtime",
        "install_identity_api_runtime",
        "install_media_role_runtime",
        "install_coverage_runtime",
        "install_rough_cut_runtime",
        "install_assistant_runtime",
        "install_desktop_runtime",
        "install_media_inventory_task_runtime",
    ):
        assert forbidden not in source
    assert "runtime_stack.install_production_runtime" in source
