from __future__ import annotations

import json
from pathlib import Path

import pytest

from script_organizer.project_package import load_project_package_manifest
from script_organizer.project_transfer.operations import (
    ProjectTransferError,
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

def test_export_does_not_overwrite_empty_directory_created_after_preflight(tmp_path, monkeypatch):
    from script_organizer.project_transfer import operations

    source = _project(tmp_path)
    target = tmp_path / "剪辑副本.mirrorproj"
    verify = operations._assert_staged_portability

    def create_competing_directory(staging):
        verify(staging)
        target.mkdir()

    monkeypatch.setattr(operations, "_assert_staged_portability", create_competing_directory)
    with pytest.raises(ProjectTransferError, match="目标已存在"):
        copy_project_package(source, target)
    assert target.is_dir() and list(target.iterdir()) == []
    assert not list(tmp_path.glob(".mirrororder-transfer-*"))


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
    request_id = store.create("save_project_as", {"destination": "/private/Copy.mirrorproj"})

    assert len(request_id) == 32
    assert store.load(request_id, expected_kind="save_project_as")["destination"].endswith(".mirrorproj")
    path = tmp_path / "requests" / f"{request_id}.json"
    assert "/private/Copy.mirrorproj" in path.read_text(encoding="utf-8")

    store.remove(request_id)
    assert not path.exists()
    with pytest.raises(ProjectTransferRequestError):
        store.load(request_id)



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


def _transfer_project(root: Path) -> Path:
    """带真实设备绑定的项目：material_index + FCPXML 都引用 /Volumes 媒体。"""
    from urllib.parse import quote

    package = root / "device-project.mirrorproj"
    (package / "inputs").mkdir(parents=True)
    (package / "output").mkdir()
    media_paths = {
        "M_aaa": "/Volumes/TESTVOL/《剧》/素材/A1/A001.mp4",
        "M_bbb": "/Volumes/TESTVOL/《剧》/素材/B1/B001.mov",
        "M_ccc": "/Users/tester/Desktop/A002.mov",
        "M_ddd": "C:\\Users\\tester\\Media\\A003.mov",
    }
    index = {
        "version": 3,
        "source": {
            "kind": "fcpxml",
            "fcpxml": "./inputs/source.fcpxml",
            "fcpxml_sha256": "stale-digest",
            "script": "./inputs/script.md",
            "script_sha256": "script-digest",
            "media_root": "",
            "media_binding": "not-required",
        },
        "clips": [
            {"clip_id": "C1", "name": "A001.mp4", "camera": "A", "media_path": media_paths["M_aaa"], "exists": True, "media_id": "M_aaa"},
            {"clip_id": "C2", "name": "B001.mov", "camera": "B", "media_path": media_paths["M_bbb"], "exists": True, "media_id": "M_bbb"},
            {"clip_id": "C3", "name": "A002.mov", "camera": "A", "media_path": media_paths["M_ccc"], "exists": True, "media_id": "M_ccc"},
            {"clip_id": "C4", "name": "A003.mov", "camera": "A", "media_path": media_paths["M_ddd"], "exists": True, "media_id": "M_ddd"},
        ],
        "groups": [
            {"group_id": "G1", "members": [{"clip_id": "C1", "media_path": media_paths["M_aaa"], "exists": True, "media_id": "M_aaa"}]}
        ],
        "stats": {"clips": 4, "groups": 1},
    }
    (package / "output" / "material_index.json").write_text(
        json.dumps(index, ensure_ascii=False), encoding="utf-8"
    )
    (package / "output" / "review.json").write_text(
        json.dumps(
            {"revision": 1, "groups": {"G1": {"legacy_source": "/Volumes/TESTVOL/codex/人工核对.json"}}},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    fcpxml = "\n".join(
        [
            '<?xml version="1.0" encoding="UTF-8"?>',
            "<fcpxml>",
            f'  <ff:asset id="a1" src="file://{quote(media_paths["M_aaa"])}"/>',
            f'  <ff:asset id="b1" src="file://{quote(media_paths["M_bbb"])}"/>',
            f'  <ff:asset id="c1" src="file://{quote(media_paths["M_ccc"])}"/>',
            '  <ff:asset id="d1" src="file:///C:/Users/tester/Media/A003.mov"/>',
            "</fcpxml>",
        ]
    )
    (package / "inputs" / "source.fcpxml").write_text(fcpxml, encoding="utf-8")
    (package / "inputs" / "script.md").write_text("# 第1集\n", encoding="utf-8")
    project = [
        "[project]",
        'format = "mirrororder-project"',
        "schema_version = 1",
        'id = "device-project"',
        'name = "Device Project"',
        "",
        "[input]",
        'kind = "fcpxml"',
        'script = "./inputs/script.md"',
        'fcpxml = "./inputs/source.fcpxml"',
        "",
        "[output]",
        'directory = "./output"',
    ]
    (package / "project.toml").write_text("\n".join(project) + "\n", encoding="utf-8")
    return package


def test_copy_project_package_rebinds_device_bindings_for_portability(tmp_path):
    import hashlib

    from script_organizer.project_transfer.operations import _DEVICE_PATH_PATTERN

    source = _transfer_project(tmp_path)
    live_index_before = (source / "output" / "material_index.json").read_bytes()
    live_document_before = (source / "inputs" / "source.fcpxml").read_bytes()
    result = copy_project_package(source, tmp_path / "Export", include_cache=False)

    target = tmp_path / "Export.mirrorproj"
    assert result["projected_artifacts"] >= 3
    # live 源项目未被原地修改：导出只发生在 staging/目标里。
    assert (source / "output" / "material_index.json").read_bytes() == live_index_before
    assert (source / "inputs" / "source.fcpxml").read_bytes() == live_document_before
    for path in target.rglob("*"):
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        assert not _DEVICE_PATH_PATTERN.search(text), path

    index = json.loads((target / "output" / "material_index.json").read_text(encoding="utf-8"))
    assert [clip["media_id"] for clip in index["clips"]] == ["M_aaa", "M_bbb", "M_ccc", "M_ddd"]
    assert all(clip["media_path"] == "" for clip in index["clips"])
    assert all(clip["exists"] is False for clip in index["clips"])
    serialized = (target / "output" / "material_index.json").read_text(encoding="utf-8")
    assert "/Volumes/" not in serialized
    assert "/Users/tester" not in serialized
    assert "C:/Users" not in serialized
    clip_a = index["clips"][0]
    assert clip_a["media_id"] == "M_aaa"
    member = index["groups"][0]["members"][0]
    assert member["media_id"] == "M_aaa"
    assert member["media_path"] == ""

    document = (target / "inputs" / "source.fcpxml").read_text(encoding="utf-8")
    # 设备 locator 剥除为空 src（fcpxml_reader 认可的无 locator 状态），
    # 不发明新的伪 relative locator；media_id 只留在 material_index 里。
    assert document.count('src=""') == 4
    assert "file://" not in document
    assert "/Volumes/" not in document
    assert "/Users/tester" not in document
    assert "C:/Users" not in document
    assert index["source"]["fcpxml_sha256"] == hashlib.sha256(document.encode("utf-8")).hexdigest()

    review = json.loads((target / "output" / "review.json").read_text(encoding="utf-8"))
    assert review["revision"] == 1
    assert review["groups"]["G1"]["legacy_source"] == ""


def test_import_copy_round_trip_stays_portable(tmp_path):
    from script_organizer.project_transfer.operations import _DEVICE_PATH_PATTERN

    source = _transfer_project(tmp_path)
    copy_project_package(source, tmp_path / "Export")
    target = tmp_path / "Export.mirrorproj"

    # runtime._device_import_run 的导入复制走同一条 copy_project_package 边界。
    imported = tmp_path / "workspace" / "imported"
    imported.parent.mkdir(parents=True)
    copy_project_package(target, imported, require_external_source=True, destination_extension=None)

    manifest = load_project_package_manifest(imported)
    assert manifest.project_id == "device-project"
    index = json.loads((imported / "output" / "material_index.json").read_text(encoding="utf-8"))
    assert [clip["media_id"] for clip in index["clips"]] == ["M_aaa", "M_bbb", "M_ccc", "M_ddd"]
    assert all(clip["media_path"] == "" for clip in index["clips"])
    for path in imported.rglob("*"):
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        assert not _DEVICE_PATH_PATTERN.search(text), path


def test_export_strips_device_locator_without_requiring_media_map(tmp_path):
    source = _transfer_project(tmp_path)
    document = (source / "inputs" / "source.fcpxml").read_text(encoding="utf-8")
    document = document.replace(
        "</fcpxml>",
        '  <ff:asset id="zz" src="file:///Volumes/Unknown/zzz.mp4"/>\n</fcpxml>',
    )
    (source / "inputs" / "source.fcpxml").write_text(document, encoding="utf-8")

    # 剥除不依赖 media map：任何设备 locator 都直接移除，不产生伪绑定。
    result = copy_project_package(source, tmp_path / "Export")
    exported = ((tmp_path / "Export.mirrorproj") / "inputs" / "source.fcpxml").read_text(encoding="utf-8")
    assert exported.count('src=""') == 5
    assert "/Volumes/" not in exported
    assert result["projected_artifacts"] >= 3

def test_copy_materializes_only_checked_sync_master_and_omits_device_layout(tmp_path):
    import hashlib

    source = _project(tmp_path)
    built = tmp_path / "media" / "交付" / ("同步-" + "b" * 32) / "synchronized.fcpxml"
    built.parent.mkdir(parents=True)
    original_xml = b'<fcpxml><resources><asset src="file:///tmp/ABC/A001.mp4" /></resources></fcpxml>'
    built.write_bytes(original_xml)
    output = source / "output"
    sync = output / "sync"
    sync.mkdir()
    (sync / "synchronized.fcpxml").symlink_to(built)
    (sync / "sync_report.json").write_text(json.dumps({
        "status": "completed", "sync_task_id": "saved-task", "fcpxml": str(built),
        "camera_detection": {"contract_version": "camera_detection.v2"},
    }), encoding="utf-8")
    (output / "material_index.json").write_text(json.dumps({
        "analysis_source": {"fcpxml_sha256": hashlib.sha256(original_xml).hexdigest()},
        "clips": [],
    }), encoding="utf-8")
    runtime = output / ".multicam-sync"
    work = runtime / "work"
    work.mkdir(parents=True)
    (runtime / "media-layout").symlink_to(built.parent)
    (runtime / "config.json").write_text(json.dumps({"input_dir": str(built.parent)}), encoding="utf-8")
    (work / "fingerprint.f32").write_bytes(b"cached")
    (work / "positions_day1_compressed.tsv").write_text("track-pos", encoding="utf-8")

    target = tmp_path / "交接 剪辑.mirrorproj"
    copy_project_package(source, target, include_cache=False)
    published = target / "output/sync/synchronized.fcpxml"
    assert published.is_file() and not published.is_symlink()
    assert b'/tmp/ABC' not in published.read_bytes()
    assert not (target / "output/.multicam-sync/media-layout").exists()
    assert not (target / "output/.multicam-sync/config.json").exists()
    assert not (target / "output/.multicam-sync/work/fingerprint.f32").exists()
    assert (target / "output/.multicam-sync/work/positions_day1_compressed.tsv").is_file()
    assert built.read_bytes() == original_xml

    # Importing an external project never gets the trusted engine-link exception.
    with pytest.raises(ProjectTransferError, match="符号链接"):
        copy_project_package(source, tmp_path / "unsafe-import", require_external_source=True)
    built.write_bytes(b"<fcpxml>changed</fcpxml>")
    bad = tmp_path / "changed.mirrorproj"
    with pytest.raises(ProjectTransferError, match="同步 XML 指纹不匹配"):
        copy_project_package(source, bad, include_cache=False)
    assert not bad.exists()
