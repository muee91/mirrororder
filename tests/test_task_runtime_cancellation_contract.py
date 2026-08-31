from __future__ import annotations

import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from script_organizer.device_tasks import DeviceTaskManager
from script_organizer.multicam_sync_engine import _run
from script_organizer.resource_scheduler import ResourceCancelled
from script_organizer.tasks_v2 import PROCESS_RUNNER_ID, TaskManager


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def task_payload(task_id: str, status: str) -> dict[str, object]:
    return {
        "task_id": task_id,
        "project_id": "project-1",
        "type": "multicam_sync",
        "targets": {},
        "affected_group_ids": [],
        "idempotency_key": task_id,
        "runner_id": PROCESS_RUNNER_ID,
        "status": status,
        "stage": status,
        "progress": {},
        "actor": "desktop",
        "created_at": "2026-09-01T00:00:00+00:00",
        "started_at": "",
        "completed_at": "",
        "error": "",
        "message": "任务已排队",
        "result": {},
        "logs": [],
    }


def write_task(tmp_path: Path, row: dict[str, object]) -> None:
    (tmp_path / "tasks.json").write_text(
        json.dumps({"version": 2, "tasks": [row]}, ensure_ascii=False),
        encoding="utf-8",
    )


def test_vendor_stage_can_be_cancelled_while_child_is_silent(tmp_path: Path) -> None:
    script = tmp_path / "hang.py"
    script.write_text(
        "import time\n"
        "time.sleep(60)\n",
        encoding="utf-8",
    )
    started = time.monotonic()

    with pytest.raises(ResourceCancelled, match="多机位同步已取消"):
        _run(
            tmp_path,
            script.name,
            [],
            timeout=30,
            cancel_requested=lambda: time.monotonic() - started >= 0.2,
        )

    assert time.monotonic() - started < 5.0


def test_multicam_cancel_targets_only_the_spawned_process_tree() -> None:
    engine = read("src/script_organizer/multicam_sync_engine.py")
    tasks = read("src/script_organizer/tasks.py")
    base_tasks = read("src/script_organizer/tasks_v2.py")

    assert 'start_new_session=os.name != "nt"' in engine
    assert 'CREATE_NEW_PROCESS_GROUP' in engine
    assert 'os.killpg(process.pid, signal.SIGTERM)' in engine
    assert '["taskkill", "/PID", str(process.pid), "/T", "/F"]' in engine
    assert 'cancel_requested=cancel_requested' in engine
    assert 'except ResourceCancelled:' in engine
    assert 'cancel_requested=lambda: self._cancel_requested(config, task_id)' in tasks
    assert 'cancel_requested=lambda: self._cancel_requested(config, task["task_id"])' in tasks
    assert 'cancel_requested=lambda: self._cancel_requested(config, task_id)' in base_tasks
    assert 'cancel_requested=lambda: self._cancel_requested(config, task["task_id"])' in base_tasks
    assert 'pkill' not in engine
    assert 'killall' not in engine


def test_durable_task_update_persists_user_visible_message(tmp_path: Path) -> None:
    config = SimpleNamespace(output_dir=tmp_path)
    row = task_payload("task-message", "running")
    row["stage"] = "sync"
    row["started_at"] = "2026-09-01T00:00:00+00:00"
    row["message"] = "任务开始"
    write_task(tmp_path, row)
    manager = TaskManager(lambda _project_id: config)

    manager._update(config, "task-message", message="音频互相关同步 day1")

    saved = manager.list("project-1")[0]
    assert saved["message"] == "音频互相关同步 day1"
    assert saved["logs"][-1].endswith("音频互相关同步 day1")


def test_queued_cancel_cannot_be_promoted_back_to_running(tmp_path: Path) -> None:
    config = SimpleNamespace(output_dir=tmp_path)
    write_task(tmp_path, task_payload("task-race", "queued"))
    manager = TaskManager(lambda _project_id: config)

    cancelled = manager.cancel("project-1", "task-race")
    manager._update(config, "task-race", status="running", stage="starting", message="任务开始")
    saved = manager.list("project-1")[0]

    assert cancelled["status"] == "cancelled"
    assert cancelled["cancel_requested"] is True
    assert saved["status"] == "cancelled"
    assert saved["stage"] == "cancelled"
    assert saved["message"] == "任务在启动前取消"
    assert saved["started_at"] == ""


def test_queued_device_cancel_cannot_be_promoted_back_to_running(tmp_path: Path) -> None:
    path = tmp_path / "device-tasks.json"
    row = {
        "task_id": "device-race",
        "scope": "device",
        "project_id": "",
        "type": "identity_runtime_prepare",
        "targets": {"kind": "face"},
        "affected_group_ids": [],
        "idempotency_key": "device-race",
        "runner_id": "device-test",
        "status": "queued",
        "stage": "queued",
        "progress": {},
        "actor": "desktop",
        "created_at": "2026-09-01T00:00:00+00:00",
        "started_at": "",
        "completed_at": "",
        "error": "",
        "result": {},
        "logs": [],
    }
    path.write_text(json.dumps({"version": 1, "tasks": [row]}, ensure_ascii=False), encoding="utf-8")
    manager = DeviceTaskManager(path)

    cancelled = manager.cancel("device-race")
    manager._update("device-race", status="running", stage="starting", message="设备运行时准备开始")
    saved = manager.list()[0]

    assert cancelled["status"] == "cancelled"
    assert cancelled["cancel_requested"] is True
    assert saved["status"] == "cancelled"
    assert saved["stage"] == "cancelled"
    assert saved["started_at"] == ""


def test_cancelled_task_message_is_not_reported_as_completed() -> None:
    base_tasks = read("src/script_organizer/tasks_v2.py")
    compat_tasks = read("src/script_organizer/tasks.py")
    device_tasks = read("src/script_organizer/device_tasks.py")

    assert 'except ResourceCancelled as error:' in base_tasks
    assert 'status="cancelled"' in base_tasks
    assert 'if result.get("cancelled"):' in base_tasks
    assert 'status == "running" and task.get("status") == "cancelled"' in base_tasks
    assert 'except ResourceCancelled as error:' in compat_tasks
    assert 'status="cancelled"' in compat_tasks
    assert 'status == "running" and task.get("status") == "cancelled"' in device_tasks
