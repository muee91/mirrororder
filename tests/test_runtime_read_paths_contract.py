from __future__ import annotations

import ast
import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock


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


def test_desktop_runtime_preparation_uses_device_tasks_not_unmanaged_threads() -> None:
    runtime = (SRC / "desktop_runtime.py").read_text(encoding="utf-8")
    assert '["api", "v1", "device-tasks"]' in runtime
    assert '"local_vision_prepare"' in runtime
    assert '"identity_runtime_prepare"' in runtime
    assert ".prepare_async(" not in runtime
    assert "initialize_device_tasks()" in runtime


def test_device_task_module_has_no_import_time_manager_side_effect() -> None:
    runtime = (SRC / "device_tasks.py").read_text(encoding="utf-8")
    assert "DEVICE_TASKS = DeviceTaskManager()" not in runtime
    assert "def initialize_device_tasks" in runtime
    assert "manager.recover_interrupted()" in runtime
    assert "scope\": \"device" in runtime


def test_identity_durable_prepare_has_cooperative_cancel_points() -> None:
    runtime = (SRC / "identity_runtime_v3.py").read_text(encoding="utf-8")
    assert "def prepare_cancellable" in runtime
    assert "subprocess.Popen(" in runtime
    assert "IdentityPreparationCancelled" in runtime
    assert "_raise_if_cancelled(cancel_requested)" in runtime
    assert "response.read(1024 * 1024)" in runtime


def test_snapshot_validation_is_shared_by_revision_and_project_polling(tmp_path, monkeypatch) -> None:
    from script_organizer import audit_engine, web_server

    project = object.__new__(web_server.ProjectService)
    project.config = SimpleNamespace(output_dir=tmp_path)
    snapshot = tmp_path / "analysis_snapshot.json"
    snapshot.write_text('{"index": {}, "script": {}, "matches": {}}')
    parse = Mock(wraps=json.loads)
    monkeypatch.setattr(json, "loads", parse)

    with ThreadPoolExecutor(max_workers=6) as workers:
        revisions = list(workers.map(audit_engine._analysis_revision, [tmp_path] * 12))
    signature = project._signature()
    assert signature[0][0] == snapshot.name
    assert set(revisions) == {hashlib.sha1(repr(signature).encode()).hexdigest()[:16]}
    assert parse.call_count == 1

    snapshot.write_text('{"index": {"clips": []}, "script": {}, "matches": {}}')
    assert project._signature() != signature
    assert audit_engine._analysis_revision(tmp_path) != revisions[0]
    assert parse.call_count == 2

    snapshot.write_text("{broken")
    legacy = project._signature()
    assert [item[0] for item in legacy] == ["material_index.json", "script.json", "matches.json"]
    legacy_revision = audit_engine._analysis_revision(tmp_path)
    (tmp_path / "material_index.json").write_text("{}")
    assert audit_engine._analysis_revision(tmp_path) != legacy_revision
    assert parse.call_count == 3


def test_coverage_revision_reads_only_changed_stores(tmp_path, monkeypatch) -> None:
    from script_organizer import coverage_graph

    project = SimpleNamespace(config=SimpleNamespace(output_dir=tmp_path), reload_if_changed=lambda: None)
    (tmp_path / "review.json").write_text('{"revision": 1}')
    automation = tmp_path / "auto_decisions.json"
    automation.write_text('{"updated_at": "first"}')
    parse = Mock(wraps=json.loads)
    monkeypatch.setattr(json, "loads", parse)
    first = coverage_graph.coverage_revision(project)
    assert coverage_graph.coverage_revision(project) == first
    assert parse.call_count == 2
    automation.write_text('{"updated_at": "second"}')
    assert coverage_graph.coverage_revision(project) != first
    assert parse.call_count == 3


def test_project_reload_after_timestamp_preserving_replacements(tmp_path) -> None:
    from script_organizer import audit_engine, web_server

    def replace_preserving_stat(path, old, new):
        stat = path.stat()
        replacement = path.with_suffix(".incoming")
        replacement.write_text(path.read_text().replace(old, new))
        assert replacement.stat().st_size == stat.st_size
        os.utime(replacement, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        replacement.replace(path)
        assert path.stat().st_mtime_ns == stat.st_mtime_ns

    index = tmp_path / "material_index.json"
    index.write_text('{"clips": [{"clip_id": "old"}]}')
    project = web_server.ProjectService("demo", SimpleNamespace(output_dir=tmp_path))
    legacy_revision = project.analysis_revision
    replace_preserving_stat(index, '"old"', '"new"')
    assert project.reload_if_changed()
    assert set(project.clips) == {"new"}
    assert project.analysis_revision == legacy_revision
    assert not project.reload_if_changed()

    snapshot = tmp_path / "analysis_snapshot.json"
    snapshot.write_text('{"index": {"clips": [{"clip_id": "one"}]}, "script": {}, "matches": {}}')
    assert project.reload_if_changed()
    snapshot_revision = audit_engine._analysis_revision(tmp_path)
    replace_preserving_stat(snapshot, '"one"', '"two"')
    assert project.reload_if_changed()
    assert set(project.clips) == {"two"}
    assert project.analysis_revision == snapshot_revision
    replace_preserving_stat(snapshot, '"index"', '"other"')
    assert audit_engine._analysis_revision(tmp_path) == legacy_revision
    assert project.reload_if_changed()
    assert set(project.clips) == {"new"}
    replace_preserving_stat(snapshot, '"other"', '"index"')
    assert project.reload_if_changed()
    assert set(project.clips) == {"two"}
    assert project.analysis_revision == snapshot_revision


def test_project_reload_observes_snapshot_published_during_read(tmp_path, monkeypatch) -> None:
    from script_organizer import web_server

    snapshot = tmp_path / "analysis_snapshot.json"
    snapshot.write_text('{"index": {}, "script": {}, "matches": {}}')
    read = web_server._read_json

    def publish_after_read(path, fallback):
        value = read(path, fallback)
        if path == snapshot:
            snapshot.write_text('{"index": {"clips": [{"clip_id": "new"}]}, "script": {}, "matches": {}}')
        return value

    with monkeypatch.context() as patch:
        patch.setattr(web_server, "_read_json", publish_after_read)
        project = web_server.ProjectService("demo", SimpleNamespace(output_dir=tmp_path))
    assert project.reload_if_changed()
    assert "new" in project.clips
    assert not project.reload_if_changed()


def test_byte_cache_skips_publication_when_inputs_change_during_build() -> None:
    from script_organizer.web_server import _JsonResponseCache

    cache = _JsonResponseCache()
    revision = 0

    def write_during_build():
        nonlocal revision
        revision = 1
        return "first read"

    assert json.loads(cache.render(lambda: revision, write_during_build)) == "first read"
    for revision in (1, 0):
        assert json.loads(cache.render(lambda: revision, lambda: revision)) == revision
