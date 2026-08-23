from __future__ import annotations


def test_editorial_runtime_imports_without_install_side_effects() -> None:
    from script_organizer.editorial_runtime import install_editorial_runtime
    from script_organizer.editorial_store import EditorialConflictError, EditorialStore

    assert callable(install_editorial_runtime)
    assert EditorialStore.__name__ == "EditorialStore"
    assert issubclass(EditorialConflictError, RuntimeError)
