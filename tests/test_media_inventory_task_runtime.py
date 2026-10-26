from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from script_organizer import media_identity, media_inventory_task_runtime, tasks_v2
from script_organizer.media_identity import DeviceMediaStore
from script_organizer.media_role_store import MediaRoleStore


def _project(tmp_path: Path) -> SimpleNamespace:
    output = tmp_path / "output"
    output.mkdir(exist_ok=True)
    return SimpleNamespace(
        project_id="demo",
        workspace_id="ws_demo",
        index={"clips": [], "groups": []},
        config=SimpleNamespace(output_dir=output, camera_patterns={}),
    )


def test_inventory_projection_includes_indexed_duration_without_touching_media(tmp_path: Path, monkeypatch) -> None:
    """素材库行的决策字段：material_index 已有的扫描期秒数直接投影，读路径不碰媒体。"""
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device-state"))
    project = _project(tmp_path)
    project.index = {
        "clips": [
            {"media_id": "M_dur", "clip_id": "C_dur", "duration": 68.16, "camera": "B"},
            {"media_id": "M_bad", "clip_id": "C_bad", "duration": "not-a-number"},
            {"media_id": "M_zero", "clip_id": "C_zero", "duration": 0},
        ],
        "groups": [],
    }

    payload = media_inventory_task_runtime.inventory_payload(
        project,
        DeviceMediaStore(),
        MediaRoleStore(project.config.output_dir),
    )

    rows = {row["media_id"]: row for row in payload["items"]}
    assert rows["M_dur"]["duration_seconds"] == 68.16
    assert rows["M_bad"]["duration_seconds"] is None
    assert rows["M_zero"]["duration_seconds"] is None


def test_inventory_projection_never_enumerates_or_hashes_media_on_read(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device-state"))
    media_root = tmp_path / "media"
    media_root.mkdir()
    (media_root / "A001.mov").write_bytes(b"media")

    project = _project(tmp_path)
    device = DeviceMediaStore()
    device.add_roots(project.workspace_id, project.project_id, [str(media_root)])

    def fail(*_args, **_kwargs):
        raise AssertionError("read projection must not enumerate or hash media")

    monkeypatch.setattr(device, "_media_files", fail)
    monkeypatch.setattr(media_inventory_task_runtime, "media_id_for_path", fail)

    payload = media_inventory_task_runtime.inventory_payload(
        project,
        device,
        MediaRoleStore(project.config.output_dir),
    )

    assert payload["contract"] == "media_inventory.v1"
    assert payload["scan_required"] is True
    assert payload["inventory_updated_at"] == ""
    assert payload["summary"]["files"] == 0
    assert payload["semantics"]["read_path_scans_media"] is False
    assert payload["semantics"]["paths_exposed"] is False


def test_inventory_exposes_canonical_clip_identity_without_exposing_media_path(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device-state"))
    project = _project(tmp_path)
    source_path = "/Volumes/PRIVATE_CAMERA_CARD/A001.mov"
    project.index = {
        "clips": [
            {
                "media_id": "M_same",
                "clip_id": "clip-canonical",
                "media_path": source_path,
                "camera": "A",
            }
        ],
        "groups": [
            {
                "group_id": "take-1",
                "members": [
                    {
                        "media_id": "M_same",
                        "clip_id": "clip-group-copy",
                        "media_path": "/Volumes/OTHER/A001.mov",
                        "camera": "B",
                    }
                ],
            }
        ],
    }

    payload = media_inventory_task_runtime.inventory_payload(
        project,
        DeviceMediaStore(),
        MediaRoleStore(project.config.output_dir),
    )

    assert payload["summary"]["indexed"] == 1
    assert payload["items"] == [
        {
            "media_id": "M_same",
            "clip_id": "clip-canonical",
            "display_name": "A001.mov",
            "folder_label": "",
            "inferred_camera": "A",
            "duration_seconds": None,
            "indexed": True,
            "label": {},
        }
    ]
    assert payload["semantics"]["clip_id_is_opaque_playback_identity"] is True
    serialized = json.dumps(payload, ensure_ascii=False)
    assert source_path not in serialized
    assert "/Volumes/OTHER" not in serialized
    assert "media_path" not in serialized


def test_scan_fingerprint_capture_builds_snapshot_without_second_media_hash(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device-state"))
    media_root = tmp_path / "media"
    media_root.mkdir()
    media_file = media_root / "A001.mov"
    media_file.write_bytes(b"A" * 4096)

    device = DeviceMediaStore()
    real_media_id_for_path = media_identity.media_id_for_path
    calls = 0

    def tracked(path: str | Path) -> str:
        nonlocal calls
        calls += 1
        return real_media_id_for_path(path)

    monkeypatch.setattr(media_identity, "media_id_for_path", tracked)
    captured: list[tuple[str, str]] = []
    device.scan("ws_demo", "demo", {"clips": [], "groups": []}, [str(media_root)], media_rows=captured)

    assert calls == 1
    assert len(captured) == 1
    snapshot = media_inventory_task_runtime._write_inventory_snapshot(
        device,
        "ws_demo",
        "demo",
        [str(media_root)],
        media_rows=captured,
    )
    assert calls == 1
    assert snapshot["items"] == [{"media_id": captured[0][0], "path": str(media_file)}]
    assert snapshot["truncated"] is False


def test_explicit_rescans_get_unique_requests_and_project_tasks_stay_path_free(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device-state"))
    media_root = (tmp_path / "media").resolve()
    media_root.mkdir()
    project = _project(tmp_path)
    device = DeviceMediaStore()

    first = media_inventory_task_runtime._store_scan_request(
        device,
        workspace_id=project.workspace_id,
        project_id=project.project_id,
        roots=[str(media_root)],
        replace=False,
    )
    second = media_inventory_task_runtime._store_scan_request(
        device,
        workspace_id=project.workspace_id,
        project_id=project.project_id,
        roots=[str(media_root)],
        replace=False,
    )
    assert first != second
    assert media_inventory_task_runtime._load_scan_request(device, first)["roots"] == [str(media_root)]

    monkeypatch.setattr(tasks_v2, "TASK_TYPES", set(tasks_v2.TASK_TYPES) | {"media_inventory_scan"})
    manager = tasks_v2.TaskManager(lambda _project_id: project.config, workspace_id=project.workspace_id)
    monkeypatch.setattr(manager, "_run", lambda _project_id, _task_id: None)
    task = manager.submit(
        project.project_id,
        "media_inventory_scan",
        {"request_id": first},
        idempotency_key=f"media_inventory_scan:{project.project_id}:{first}",
        actor="desktop",
    )
    manager._threads[task["task_id"]].join(timeout=1)

    task_text = (project.config.output_dir / "tasks.json").read_text(encoding="utf-8")
    assert str(media_root) not in task_text
    assert json.loads(task_text)["tasks"][0]["targets"] == {"request_id": first}

    request_path = media_inventory_task_runtime._request_path(device, first)
    assert request_path.is_relative_to(device.path.parent)
    assert str(media_root) in request_path.read_text(encoding="utf-8")


def test_media_inventory_runtime_installs_after_desktop_and_uses_durable_contract() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime_stack = (root / "src" / "script_organizer" / "runtime_stack.py").read_text(encoding="utf-8")
    runtime = (root / "src" / "script_organizer" / "media_inventory_task_runtime.py").read_text(encoding="utf-8")

    assert runtime_stack.index("install_desktop_runtime()") < runtime_stack.index("install_media_inventory_task_runtime()")
    assert 'task_runtime.TASK_TYPES.add(_TASK_TYPE)' in runtime
    assert 'manager._resource(config, task, "cpu", "media_inventory", "素材扫描")' in runtime
    assert 'except ResourceCancelled:' in runtime
    assert 'except MediaScanCancelled:' in runtime
    assert '{"request_id": request_id}' in runtime
    assert '"contract": "media_inventory_scan.v1"' in runtime
    assert 'web_server.HTTPStatus.ACCEPTED' in runtime
    assert 'media_rows=captured_rows' in runtime
    assert 'media_files=captured_files' in runtime
    assert 'replace=replace' in runtime
    assert 'cancelled=cancelled' in runtime
    assert '"clip_id": indexed_row.get("clip_id", "")' in runtime
    assert '"clip_id_is_opaque_playback_identity": True' in runtime
    assert "原有本机素材绑定保持不变" in runtime
