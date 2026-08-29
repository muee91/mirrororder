from __future__ import annotations

import json
from pathlib import Path

import pytest

from script_organizer import device_tasks
from script_organizer.device_tasks import DeviceTaskManager, _targets


class _NoStartThread:
    def __init__(self, target=None, args=(), daemon=None, name=None) -> None:
        self.target = target
        self.args = args
        self.daemon = daemon
        self.name = name

    def start(self) -> None:
        return None


def test_manager_construction_does_not_touch_disk(tmp_path: Path) -> None:
    path = tmp_path / "device-tasks.json"
    DeviceTaskManager(path)
    assert path.exists() is False


def test_device_task_targets_reject_absolute_paths() -> None:
    with pytest.raises(ValueError, match="逻辑模型 ID"):
        _targets("local_vision_prepare", {"model": "/Volumes/Models/qwen.gguf"})
    with pytest.raises(ValueError, match="逻辑模型 ID"):
        _targets("local_vision_prepare", {"model": r"C:\\Models\\qwen.gguf"})
    assert _targets("local_vision_prepare", {"model": "Qwen/Qwen3-VL-4B-Instruct-GGUF:Q4_K_M"}) == {
        "model": "Qwen/Qwen3-VL-4B-Instruct-GGUF:Q4_K_M"
    }
    assert _targets("identity_runtime_prepare", {"kind": "FACE"}) == {"kind": "face"}


def test_submit_persists_device_scope_without_project_or_device_path(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(device_tasks, "Thread", _NoStartThread)
    path = tmp_path / "device-tasks.json"
    manager = DeviceTaskManager(path)
    task = manager.submit(
        "local_vision_prepare",
        {"model": "Qwen/Qwen3-VL-4B-Instruct-GGUF:Q4_K_M"},
        actor="desktop",
    )

    assert task["scope"] == "device"
    assert task["project_id"] == ""
    assert task["targets"] == {"model": "Qwen/Qwen3-VL-4B-Instruct-GGUF:Q4_K_M"}
    encoded = path.read_text(encoding="utf-8")
    assert "/Volumes/" not in encoded
    assert "/Users/" not in encoded
    assert "project.toml" not in encoded


def test_active_device_submit_is_idempotent(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(device_tasks, "Thread", _NoStartThread)
    manager = DeviceTaskManager(tmp_path / "device-tasks.json")
    first = manager.submit("identity_runtime_prepare", {"kind": "speaker"})
    second = manager.submit("identity_runtime_prepare", {"kind": "speaker"})
    assert second["task_id"] == first["task_id"]
    assert len(manager.list()) == 1


def test_recovery_marks_foreign_active_task_interrupted(tmp_path: Path) -> None:
    path = tmp_path / "device-tasks.json"
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "tasks": [
                    {
                        "task_id": "device_task_old",
                        "type": "identity_runtime_prepare",
                        "targets": {"kind": "face"},
                        "runner_id": "old-host",
                        "status": "running",
                        "stage": "identity_prepare",
                        "logs": [],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    manager = DeviceTaskManager(path)
    manager.recover_interrupted()
    task = manager.list()[0]
    assert task["status"] == "interrupted"
    assert task["stage"] == "interrupted"
    assert task["completed_at"]


def test_list_is_snapshot_only(monkeypatch, tmp_path: Path) -> None:
    path = tmp_path / "device-tasks.json"
    path.write_text(json.dumps({"version": 1, "tasks": []}), encoding="utf-8")
    manager = DeviceTaskManager(path)
    monkeypatch.setattr(manager, "_save", lambda _payload: (_ for _ in ()).throw(AssertionError("list must not write")))
    assert manager.list() == []
