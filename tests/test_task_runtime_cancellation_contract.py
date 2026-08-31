from __future__ import annotations

import json
import os
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from script_organizer.multicam_sync_engine import _run
from script_organizer.resource_scheduler import ResourceCancelled
from script_organizer.tasks_v2 import PROCESS_RUNNER_ID, TaskManager


ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


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
    payload = {
        "version": 2,
        "tasks": [
            {
                "task_id": "task-message",
                "project_id": "project-1",
                "type": "multicam_sync",
                "targets": {},
                "affected_group_ids": [],
                "idempotency_key": "sync",
                "runner_id": PROCESS_RUNNER_ID,
                "status": "running",
                "stage": "sync",
                "progress": {},
                "actor": "desktop",
                "created_at": "2026-09-01T00:00:00+00:00",
                "started_at": "2026-09-01T00:00:00+00:00",
                "completed_at": "",
                "error": "",
                "message": "任务开始",
                "result": {},
                "logs": [],
            }
        ],
    }
    (tmp_path / "tasks.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    manager = TaskManager(lambda _project_id: config)

    manager._update(config, "task-message", message="音频互相关同步 day1")

    saved = manager.list("project-1")[0]
    assert saved["message"] == "音频互相关同步 day1"
    assert saved["logs"][-1].endswith("音频互相关同步 day1")


def test_cancelled_task_message_is_not_reported_as_completed() -> None:
    base_tasks = read("src/script_organizer/tasks_v2.py")
    compat_tasks = read("src/script_organizer/tasks.py")

    assert 'except ResourceCancelled as error:' in base_tasks
    assert 'status="cancelled"' in base_tasks
    assert 'if result.get("cancelled"):' in base_tasks
    assert 'except ResourceCancelled as error:' in compat_tasks
    assert 'status="cancelled"' in compat_tasks
