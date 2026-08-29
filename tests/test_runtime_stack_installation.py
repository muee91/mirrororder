from __future__ import annotations

import ast
from pathlib import Path

import pytest

import script_organizer.runtime_stack as runtime_stack


def _reset_stack(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime_stack, "_INSTALLED", False)
    monkeypatch.setattr(runtime_stack, "_INSTALLING", False)
    monkeypatch.setattr(runtime_stack, "_LAST_ERROR", "")


def test_runtime_stack_retries_after_failed_install(monkeypatch: pytest.MonkeyPatch) -> None:
    _reset_stack(monkeypatch)
    calls = []

    def flaky() -> None:
        calls.append("attempt")
        if len(calls) == 1:
            raise RuntimeError("boom")

    monkeypatch.setattr(runtime_stack, "_install_stack_once", flaky)

    with pytest.raises(RuntimeError, match="boom"):
        runtime_stack.install_production_runtime()

    failed = runtime_stack.runtime_stack_state()
    assert failed["installed"] is False
    assert failed["installing"] is False
    assert "RuntimeError: boom" in failed["last_error"]

    runtime_stack.install_production_runtime()
    recovered = runtime_stack.runtime_stack_state()
    assert calls == ["attempt", "attempt"]
    assert recovered["installed"] is True
    assert recovered["installing"] is False
    assert recovered["last_error"] == ""


def test_runtime_stack_rejects_reentrant_install(monkeypatch: pytest.MonkeyPatch) -> None:
    _reset_stack(monkeypatch)

    def nested() -> None:
        runtime_stack.install_production_runtime()

    monkeypatch.setattr(runtime_stack, "_install_stack_once", nested)
    with pytest.raises(RuntimeError, match="禁止重入"):
        runtime_stack.install_production_runtime()
    assert runtime_stack.runtime_stack_state()["installed"] is False


def test_runtime_install_order_preserves_projection_dependencies() -> None:
    order = runtime_stack.RUNTIME_INSTALL_ORDER
    assert order[:4] == ("device_media", "automation", "review_read_model", "editorial")
    assert order.index("media_role") < order.index("coverage")
    assert order.index("media_role") < order.index("rough_cut")
    assert order.index("desktop") < order.index("media_inventory_task")
    assert len(order) == len(set(order))


def test_cli_host_bootstrap_uses_single_production_runtime_entrypoint() -> None:
    root = Path(__file__).resolve().parents[1]
    source = (root / "src" / "script_organizer" / "cli.py").read_text(encoding="utf-8")
    assert "from .runtime_stack import install_production_runtime" in source
    # One call for gateway and one for serve/run. The agent-context command keeps
    # its intentionally minimal, non-Host device-media + automation setup.
    assert source.count("install_production_runtime()") == 2
    assert source.count("install_device_media_runtime()") == 1
    assert source.count("install_automation_runtime()") == 1


def test_modules_do_not_run_runtime_installers_at_import_time() -> None:
    root = Path(__file__).resolve().parents[1] / "src" / "script_organizer"
    offenders: list[str] = []
    for path in root.glob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in tree.body:
            if not isinstance(node, ast.Expr) or not isinstance(node.value, ast.Call):
                continue
            function = node.value.func
            name = function.id if isinstance(function, ast.Name) else function.attr if isinstance(function, ast.Attribute) else ""
            if name.startswith("install_"):
                offenders.append(f"{path.name}:{name}")
    assert offenders == []


def test_identity_runtime_compatibility_import_is_side_effect_free() -> None:
    root = Path(__file__).resolve().parents[1]
    source = (root / "src" / "script_organizer" / "identity_runtime.py").read_text(encoding="utf-8")
    assert "install_identity_role_inference" not in source
