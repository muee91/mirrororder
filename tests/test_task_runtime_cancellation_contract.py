from __future__ import annotations

import json
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from script_organizer.device_tasks import DeviceTaskManager
from script_organizer.multicam_sync_engine import _run
from script_organizer.resource_scheduler import ResourceCancelled
from script_organizer import tasks as compat_tasks
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
    assert 'cancel_requested=lambda: self._cancel_requested(config, task_id)' in base_tasks
    assert 'cancel_requested=lambda: self._cancel_requested(config, task["task_id"])' in base_tasks
    assert 'pkill' not in engine
    assert 'killall' not in engine



def test_silent_vendor_worker_reports_liveness_without_inventing_progress(tmp_path: Path) -> None:
    script = tmp_path / "quiet_stage.py"
    script.write_text("import time\ntime.sleep(0.4)\n", encoding="utf-8")
    reports: list[str] = []

    output = _run(
        tmp_path, script.name, [], log=reports.append,
        timeout=3, idle_heartbeat_interval=0.12,
    )
    assert output == ""
    assert any("子进程仍在运行" in message and "心跳，不代表处理进度" in message for message in reports)


def test_verbose_vendor_output_does_not_reread_durable_state_for_every_line(tmp_path: Path) -> None:
    script = tmp_path / "verbose.py"
    script.write_text("for n in range(10000): print(n)\n", encoding="utf-8")
    reads = []

    def cancellation_state():
        reads.append(time.monotonic())
        return False

    output = _run(tmp_path, script.name, [], timeout=10, cancel_requested=cancellation_state)

    assert len(output.splitlines()) == 10000
    assert output.endswith("9999")
    # The production callback loads the durable task JSON. Output volume must
    # not multiply disk reads; silent-worker cancellation remains covered above.
    assert len(reads) < 1000


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


def test_multicam_sync_publishes_analysis_index_before_task_completes(tmp_path: Path, monkeypatch) -> None:
    """A direct sync must not finish while the project still has no media index."""
    config = SimpleNamespace(output_dir=tmp_path)
    row = task_payload("task-sync-analysis", "queued")
    write_task(tmp_path, row)
    manager = TaskManager(lambda _project_id: config, workspace_id="ws_demo")
    calls: list[str] = []

    def fake_sync(*_args, **_kwargs):
        calls.append("sync")
        return {"status": "completed", "positions": ["positions_day1_compressed.tsv"]}

    def fake_analyze(*_args, **_kwargs):
        calls.append("analysis")
        return {"index": {"stats": {"clips": 2, "groups": 1}}}

    monkeypatch.setattr("script_organizer.tasks_v2.run_multicam_sync", fake_sync)
    monkeypatch.setattr("script_organizer.tasks_v2._analysis_inputs_available", lambda _config: True)
    monkeypatch.setattr("script_organizer.tasks_v2.analyze", fake_analyze)
    manager._run("project-1", row["task_id"])

    saved = manager.list("project-1")[0]
    assert saved["status"] == "completed"
    assert calls == ["sync", "analysis"]
    assert saved["result"]["analysis"] == {"clips": 2, "groups": 1}



def test_direct_sync_persists_worker_checkpoints_for_desktop(tmp_path: Path, monkeypatch) -> None:
    config = SimpleNamespace(output_dir=tmp_path)
    row = task_payload("sync-checkpoints", "queued")
    write_task(tmp_path, row)
    manager = TaskManager(lambda _project_id: config)

    def fake_sync(*_args, **kwargs):
        progress = kwargs["progress"]
        progress(2, 8)
        during_sync = manager.list("project-1")[0]
        assert during_sync["progress"] == {"done": 2, "total": 8}
        assert during_sync["updated_at"]
        return {"status": "completed"}

    monkeypatch.setattr("script_organizer.tasks_v2.run_multicam_sync", fake_sync)
    monkeypatch.setattr("script_organizer.tasks_v2._analysis_inputs_available", lambda _config: True)
    monkeypatch.setattr(
        "script_organizer.tasks_v2.analyze",
        lambda *_args, **_kwargs: {"index": {"stats": {"clips": 1}}},
    )

    manager._run("project-1", row["task_id"])

    saved = manager.list("project-1")[0]
    assert saved["status"] == "completed"
    assert saved["progress"] == {"done": 2, "total": 8}
    assert saved["updated_at"]



def test_production_task_facade_runs_post_sync_analysis(tmp_path: Path, monkeypatch) -> None:
    config = SimpleNamespace(output_dir=tmp_path)
    row = task_payload("task-sync-analysis-facade", "queued")
    write_task(tmp_path, row)
    manager = compat_tasks.TaskManager(lambda _project_id: config, workspace_id="ws_demo")
    calls: list[str] = []

    monkeypatch.setattr(compat_tasks._impl, "run_multicam_sync", lambda *_args, **_kwargs: (calls.append("sync") or {"status": "completed"}))
    monkeypatch.setattr(compat_tasks._impl, "_analysis_inputs_available", lambda _config: True)
    monkeypatch.setattr(compat_tasks, "analyze", lambda *_args, **_kwargs: (calls.append("analysis") or {"index": {"stats": {"clips": 1}}}))
    manager._run("project-1", row["task_id"])

    saved = manager.list("project-1")[0]
    assert saved["status"] == "completed"
    assert calls == ["sync", "analysis"]
    assert saved["result"]["analysis"] == {"clips": 1}


def test_task_worker_output_is_rate_limited_before_durable_write(tmp_path: Path, monkeypatch) -> None:
    config = SimpleNamespace(output_dir=tmp_path)
    manager = TaskManager(lambda _project_id: config)
    writes: list[str] = []
    monkeypatch.setattr(manager, "_update", lambda _config, _task_id, **kwargs: writes.append(str(kwargs.get("message", ""))))

    report = manager._task_message_reporter(config, "task-log", interval=60.0)
    report("first")
    report("second")

    assert writes == ["first"]



def test_sync_stage_transitions_are_not_lost_to_verbose_log_throttle(tmp_path: Path, monkeypatch) -> None:
    config = SimpleNamespace(output_dir=tmp_path)
    manager = TaskManager(lambda _project_id: config)
    writes: list[str] = []
    monkeypatch.setattr(manager, "_update", lambda _config, _task_id, **kwargs: writes.append(str(kwargs.get("message", ""))))

    report = manager._task_message_reporter(config, "task-log", interval=60.0)
    report("普通日志")
    report("另一行普通日志")
    report("提取同步音频缓存")
    report("第三行普通日志")
    report("音频互相关同步 day1")

    assert writes == ["普通日志", "提取同步音频缓存", "音频互相关同步 day1"]



def test_task_log_history_is_bounded(tmp_path: Path) -> None:
    config = SimpleNamespace(output_dir=tmp_path)
    row = task_payload("task-log-bound", "running")
    row["logs"] = [f"old-{index}" for index in range(2100)]
    write_task(tmp_path, row)
    manager = TaskManager(lambda _project_id: config)

    manager._update(config, "task-log-bound", message="latest")

    saved = manager.list("project-1")[0]
    assert len(saved["logs"]) == 2000
    assert saved["logs"][-1].endswith("latest")


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


def test_running_cancel_cannot_be_published_as_completed(tmp_path: Path) -> None:
    config = SimpleNamespace(output_dir=tmp_path)
    row = task_payload("task-terminal", "running")
    row["cancel_requested"] = False
    row["stage"] = "analysis"
    write_task(tmp_path, row)
    manager = TaskManager(lambda _project_id: config)

    manager.cancel("project-1", "task-terminal")
    manager._update(
        config,
        "task-terminal",
        status="completed",
        stage="completed",
        result={"published": True},
        message="任务完成",
    )

    saved = manager.list("project-1")[0]
    assert saved["status"] == "cancelled"
    assert saved["stage"] == "cancelled"
    assert saved["message"] == "任务已取消"
    assert saved["result"] == {}


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


def test_running_device_cancel_cannot_publish_result(tmp_path: Path) -> None:
    path = tmp_path / "device-tasks.json"
    row = {
        "task_id": "device-terminal",
        "scope": "device",
        "project_id": "",
        "type": "identity_runtime_prepare",
        "targets": {"kind": "face"},
        "status": "running",
        "stage": "identity_prepare",
        "runner_id": "device-test",
        "cancel_requested": False,
        "result": {},
        "logs": [],
    }
    path.write_text(json.dumps({"version": 1, "tasks": [row]}, ensure_ascii=False), encoding="utf-8")
    manager = DeviceTaskManager(path)

    manager.cancel("device-terminal")
    manager._update(
        "device-terminal",
        status="completed",
        stage="completed",
        result={"ready": True},
        message="设备运行时准备完成",
    )

    saved = manager.list()[0]
    assert saved["status"] == "cancelled"
    assert saved["stage"] == "cancelled"
    assert saved["result"] == {}


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
