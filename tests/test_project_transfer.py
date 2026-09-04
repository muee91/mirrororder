from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from script_organizer.project_package import load_project_package_manifest
from script_organizer.project_transfer.operations import (
    ProjectTransferError,
    collect_project_archive,
    copy_project_package,
    inspect_project_package,
)
from script_organizer.project_transfer.request_store import (
    ProjectTransferRequestError,
    ProjectTransferRequestStore,
)


def _project(root: Path, *, legacy: bool = False) -> Path:
    package = root / "demo.mirrorproj"
    (package / "inputs").mkdir(parents=True)
    (package / "output").mkdir()
    (package / "cache").mkdir()
    (package / "inputs" / "script.txt").write_text("script", encoding="utf-8")
    (package / "inputs" / "source.fcpxml").write_text("<fcpxml/>", encoding="utf-8")
    (package / "output" / "review.json").write_text('{"revision": 3}', encoding="utf-8")
    (package / "output" / "tasks.json").write_text('{"version": 2, "tasks": [{"project_id": "demo"}]}', encoding="utf-8")
    (package / "cache" / "big.tmp").write_bytes(b"x" * 32)
    project = ["[project]"]
    if not legacy:
        project += ['format = "mirrororder-project"', "schema_version = 1"]
    project += [
        'id = "demo"',
        'name = "Demo"',
        "",
        "[input]",
        'kind = "fcpxml"',
        'script = "./inputs/script.txt"',
        'fcpxml = "./inputs/source.fcpxml"',
        "",
        "[output]",
        'directory = "./output"',
        "",
        "[asr]",
        'transcript_dir = "./cache/transcripts"',
    ]
    (package / "project.toml").write_text("\n".join(project) + "\n", encoding="utf-8")
    return package


def test_inspect_external_requires_mirrorproj_suffix(tmp_path):
    package = _project(tmp_path)
    result = inspect_project_package(package, require_external_suffix=True)
    assert result.manifest.project_id == "demo"

    plain = tmp_path / "plain"
    package.rename(plain)
    with pytest.raises(ProjectTransferError, match="mirrorproj"):
        inspect_project_package(plain, require_external_suffix=True)


def test_copy_project_package_migrates_identity_and_can_drop_cache(tmp_path):
    source = _project(tmp_path, legacy=True)
    result = copy_project_package(
        source,
        tmp_path / "Saved Copy",
        include_cache=False,
        new_project_id="saved-copy",
        new_name='Saved "Copy"',
        require_external_source=True,
    )

    target = tmp_path / "Saved Copy.mirrorproj"
    manifest = load_project_package_manifest(target)
    assert result["project_id"] == "saved-copy"
    assert manifest.legacy is False
    assert manifest.project_id == "saved-copy"
    assert manifest.name == 'Saved "Copy"'
    assert (target / "output" / "review.json").is_file()
    assert not (target / "output" / "tasks.json").exists()
    assert not (target / "cache").exists()


def test_copy_rejects_symlink_escape(tmp_path):
    source = _project(tmp_path)
    (source / "evil").symlink_to(tmp_path)
    with pytest.raises(ProjectTransferError, match="符号链接"):
        copy_project_package(source, tmp_path / "copy")



def test_copy_refuses_to_publish_if_source_changes_during_transfer(tmp_path, monkeypatch):
    from script_organizer.project_transfer import operations

    source = _project(tmp_path)
    original_copy = operations._copy_one
    changed = {"done": False}

    def copy_and_mutate(source_file, destination, *, cancelled=None):
        original_copy(source_file, destination, cancelled=cancelled)
        if not changed["done"]:
            changed["done"] = True
            source_file.write_bytes(source_file.read_bytes() + b"changed")

    monkeypatch.setattr(operations, "_copy_one", copy_and_mutate)
    with pytest.raises(ProjectTransferError, match="传输过程中发生变化"):
        operations.copy_project_package(source, tmp_path / "unstable")
    assert not (tmp_path / "unstable.mirrorproj").exists()

def test_collect_archive_keeps_device_binding_paths_out_of_metadata(tmp_path):
    source = _project(tmp_path)
    media = tmp_path / "A001.mov"
    media.write_bytes(b"media")

    result = collect_project_archive(
        source,
        tmp_path / "Archive",
        include_cache=False,
        media_files=[("M_abc", media)],
    )

    archive_path = tmp_path / "Archive.mirrorpkg"
    assert result["media_files"] == 1
    with zipfile.ZipFile(archive_path) as archive:
        names = set(archive.namelist())
        assert "project/project.toml" in names
        assert "project/output/review.json" in names
        assert "project/output/tasks.json" not in names
        assert "project/cache/big.tmp" not in names
        assert "media/M_abc/A001.mov" in names
        meta = json.loads(archive.read("mirrorpkg.json"))
        assert meta["device_binding_paths_included"] is False
        assert str(media) not in json.dumps(meta, ensure_ascii=False)


def test_collect_rejects_unsafe_media_identity(tmp_path):
    source = _project(tmp_path)
    media = tmp_path / "A001.mov"
    media.write_bytes(b"media")
    with pytest.raises(ProjectTransferError, match="身份无效"):
        collect_project_archive(source, tmp_path / "Archive", media_files=[("../escape", media)])


def test_cancel_does_not_publish_partial_target(tmp_path):
    source = _project(tmp_path)
    calls = {"count": 0}

    def cancelled() -> bool:
        calls["count"] += 1
        return calls["count"] > 2

    with pytest.raises(Exception, match="取消"):
        copy_project_package(source, tmp_path / "cancelled", cancelled=cancelled)
    assert not (tmp_path / "cancelled.mirrorproj").exists()


def test_internal_import_copy_keeps_managed_workspace_layout(tmp_path):
    source = _project(tmp_path)
    projects = tmp_path / "workspace" / "projects"
    projects.mkdir(parents=True)

    result = copy_project_package(
        source,
        projects / "demo",
        require_external_source=True,
        destination_extension=None,
    )

    assert result["project_id"] == "demo"
    assert (projects / "demo" / "project.toml").is_file()
    assert not (projects / "demo" / "output" / "tasks.json").exists()
    assert not (projects / "demo.mirrorproj").exists()


def test_request_store_keeps_absolute_paths_device_local(tmp_path):
    store = ProjectTransferRequestStore(tmp_path / "requests")
    request_id = store.create("collect_project", {"destination": "/private/archive.mirrorpkg"})

    assert len(request_id) == 32
    assert store.load(request_id, expected_kind="collect_project")["destination"].endswith(".mirrorpkg")
    path = tmp_path / "requests" / f"{request_id}.json"
    assert "/private/archive.mirrorpkg" in path.read_text(encoding="utf-8")

    store.remove(request_id)
    assert not path.exists()
    with pytest.raises(ProjectTransferRequestError):
        store.load(request_id)



def test_collect_media_files_uses_device_media_authority_without_path_fallback(tmp_path, monkeypatch):
    import sys
    from types import ModuleType, SimpleNamespace
    from script_organizer.project_transfer import runtime

    project = tmp_path / "project"
    output = project / "output"
    output.mkdir(parents=True)
    stale = tmp_path / "stale.mov"
    stale.write_bytes(b"wrong bytes")
    (output / "material_index.json").write_text(
        json.dumps({"clips": [{"media_id": "MP_provisional", "source_media_path": str(stale)}]}),
        encoding="utf-8",
    )

    fake = ModuleType("script_organizer.media_identity")

    class DeviceMediaStore:
        def project_snapshot(self, workspace_id, project_id):
            return {"bindings": {}, "confirmed_provisional": {}}

        @staticmethod
        def resolve_from_snapshot(snapshot, item):
            return ""

    fake.DeviceMediaStore = DeviceMediaStore
    monkeypatch.setitem(sys.modules, "script_organizer.media_identity", fake)

    with pytest.raises(ProjectTransferError, match="未定位全部收集媒体"):
        runtime._collect_media_files(SimpleNamespace(output_dir=output), "ws", "demo")


def test_request_store_restricts_directory_permissions_when_supported(tmp_path):
    root = tmp_path / "requests"
    ProjectTransferRequestStore(root)
    assert root.is_dir()
    if hasattr(root.stat(), "st_mode"):
        assert root.stat().st_mode & 0o077 == 0

def test_project_transfer_runtime_save_as_removes_request_after_success(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from script_organizer.project_transfer import runtime

    source = _project(tmp_path)
    request_store = ProjectTransferRequestStore(tmp_path / "requests")
    request_id = request_store.create(
        "save_project_as",
        {
            "project_id": "demo",
            "destination": str(tmp_path / "Runtime Copy.mirrorproj"),
            "new_project_id": "runtime-copy",
            "new_name": "Runtime Copy",
            "include_cache": False,
        },
    )
    monkeypatch.setattr(runtime, "_request_store", lambda: request_store)

    class Manager:
        def __init__(self):
            self._threads = {"task_1": object()}
            self.updates = []
        def project_loader(self, project_id):
            return SimpleNamespace(project_dir=source, output_dir=source / "output")
        def _cancel_requested(self, config, task_id):
            return False
        def _update(self, config, task_id, **values):
            self.updates.append(values)

    manager = Manager()
    runtime._project_transfer_run(
        manager,
        "demo",
        "task_1",
        {"type": "project_save_as", "targets": {"request_id": request_id}},
    )

    assert load_project_package_manifest(tmp_path / "Runtime Copy.mirrorproj").project_id == "runtime-copy"
    with pytest.raises(ProjectTransferRequestError):
        request_store.load(request_id)
    assert manager.updates[-1]["status"] == "completed"
    assert "task_1" not in manager._threads


def test_project_transfer_runtime_keeps_request_after_failure_for_retry(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from script_organizer.project_transfer import runtime

    source = _project(tmp_path)
    existing = tmp_path / "Exists.mirrorproj"
    existing.mkdir()
    request_store = ProjectTransferRequestStore(tmp_path / "requests")
    request_id = request_store.create(
        "save_project_as",
        {
            "project_id": "demo",
            "destination": str(existing),
            "new_project_id": "retry-copy",
            "new_name": "Retry Copy",
            "include_cache": False,
        },
    )
    monkeypatch.setattr(runtime, "_request_store", lambda: request_store)

    class Manager:
        def __init__(self):
            self._threads = {"task_2": object()}
            self.updates = []
        def project_loader(self, project_id):
            return SimpleNamespace(project_dir=source, output_dir=source / "output")
        def _cancel_requested(self, config, task_id):
            return False
        def _update(self, config, task_id, **values):
            self.updates.append(values)

    manager = Manager()
    runtime._project_transfer_run(
        manager,
        "demo",
        "task_2",
        {"type": "project_save_as", "targets": {"request_id": request_id}},
    )

    assert request_store.load(request_id, expected_kind="save_project_as")["new_project_id"] == "retry-copy"
    assert manager.updates[-1]["status"] == "failed"
    assert "目标已存在" in manager.updates[-1]["error"]
    assert "task_2" not in manager._threads
