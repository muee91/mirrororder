from __future__ import annotations

import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "script_organizer"


def _function_source(path: Path, name: str) -> str:
    text = path.read_text(encoding="utf-8")
    tree = ast.parse(text)
    lines = text.splitlines()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            assert node.end_lineno is not None
            return "\n".join(lines[node.lineno - 1 : node.end_lineno])
    raise AssertionError(f"missing function: {path.name}:{name}")


def test_runtime_diagnostics_get_checks_do_not_write_probe_files() -> None:
    source = _function_source(SRC / "runtime_diagnostics.py", "_writable")
    assert "mkdir" not in source
    assert "write_" not in source
    assert "unlink" not in source
    assert "os.access" in source


def test_local_vision_public_status_does_not_probe_or_scan() -> None:
    source = _function_source(SRC / "local_vision_runtime.py", "public")
    assert "_healthy" not in source
    assert "cache_bytes()" not in source
    assert "rglob" not in source
    assert "urlopen" not in source
    assert "_cache_bytes_snapshot" in source


def test_identity_public_status_does_not_hash_or_import_native_runtime() -> None:
    source = _function_source(SRC / "identity_runtime_v3.py", "public_kind")
    assert "_valid_artifact" not in source
    assert "_sha256" not in source
    assert "_importable" not in source
    assert "import_module" not in source
    assert "status_dependency" in source


def test_assistant_get_reads_persisted_snapshot_only() -> None:
    runtime = (SRC / "assistant_runtime.py").read_text(encoding="utf-8")
    snapshot = _function_source(SRC / "assistant_runtime.py", "_assistant_snapshot")
    assert "AssistantStore" in snapshot
    assert ".load()" in snapshot
    assert ".cycle(" not in snapshot
    assert "payload = _assistant_snapshot(service, project_id)" in runtime
    assert "_safe_assistant(_assistant_snapshot(service, project_id))" in runtime


def test_desktop_media_scan_has_no_synchronous_fallback() -> None:
    runtime = (SRC / "desktop_runtime.py").read_text(encoding="utf-8")
    assert "store.scan(" not in runtime
    assert "store.probe_roots(" not in runtime
    assert 'action in {"scan", "replace_and_scan"}' in runtime
    assert "禁止退回同步扫描" in runtime


def test_media_role_runtime_does_not_own_media_inventory() -> None:
    runtime = (SRC / "media_role_runtime.py").read_text(encoding="utf-8")
    assert 'parts[4] == "media-inventory"' not in runtime
    assert "_media_files(" not in runtime
    assert "media_id_for_path" not in runtime
    assert "infer_camera_label" not in runtime
    assert "media_inventory_task_runtime" in runtime


def test_automation_runtime_has_no_legacy_local_runtime_surface() -> None:
    runtime = (SRC / "automation_runtime.py").read_text(encoding="utf-8")
    assert '["api", "v1", "local-runtime"]' not in runtime
    assert "_runtime_payload" not in runtime
    assert "LocalVisionRuntime" not in runtime
    assert "IdentityRuntime" not in runtime
