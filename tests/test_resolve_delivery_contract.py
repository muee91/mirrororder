from pathlib import Path
from types import SimpleNamespace

from script_organizer.nle_delivery import resolve_delivery as delivery


def test_legacy_nested_receipt_is_not_advertised_as_new_export(tmp_path, monkeypatch):
    project = SimpleNamespace(workspace_id="test", project_id="test")
    scope = delivery._scope("test", "test")
    old = {"task_id": "device_task_" + "a" * 32, "type": "resolve_delivery", "status": "completed",
           "targets": {"request_id": "a" * 32}, "result": {"version": "old", "audio_segments": 29}}
    monkeypatch.setattr(delivery, "get_device_task_manager", lambda: SimpleNamespace(list=lambda: [old]))
    monkeypatch.setattr(delivery, "_read_request", lambda _: {"scope": scope, "sync_task_id": "sync"})
    path = tmp_path / delivery.FILENAME
    path.write_bytes(b"not an actual DRP")
    monkeypatch.setattr(delivery, "_deliverable", lambda *_: path)
    result = delivery.resolve_artifact(project, {"task_id": "sync"}, True)
    assert not result["available"]
    assert "待手动" in result["format"] and "原生多机位" not in result["format"]
    assert path.read_bytes() == b"not an actual DRP"  # no deleting old deliverables


def test_direct_receipt_exposes_handoff_and_original_dependencies(tmp_path, monkeypatch):
    project = SimpleNamespace(workspace_id="test", project_id="test")
    details = {"delivery_kind": "direct_sync_timeline", "native_multicam": False,
               "conversion_required": True, "media_dependencies": [{"media_id": "M_original", "path": "original.wav"}]}
    task = {"task_id": "device_task_" + "b" * 32, "type": "resolve_delivery", "status": "completed",
            "targets": {"request_id": "b" * 32}, "result": details}
    monkeypatch.setattr(delivery, "get_device_task_manager", lambda: SimpleNamespace(list=lambda: [task]))
    monkeypatch.setattr(delivery, "_read_request", lambda _: {"scope": delivery._scope("test", "test"), "sync_task_id": "sync"})
    path = tmp_path / delivery.FILENAME
    path.write_bytes(b"synthetic")
    monkeypatch.setattr(delivery, "_deliverable", lambda *_: path)
    result = delivery.resolve_artifact(project, {"task_id": "sync"}, True)
    assert result["available"] and result["details"] == details
    assert result["filename"] == delivery.FILENAME
