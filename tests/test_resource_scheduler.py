from __future__ import annotations

import threading
import time

import pytest

from script_organizer.resource_scheduler import ResourceCancelled, ResourceScheduler


def test_scheduler_serializes_same_resource_fifo() -> None:
    scheduler = ResourceScheduler({"mlx": 1})
    order: list[str] = []
    first_entered = threading.Event()
    release_first = threading.Event()

    def first() -> None:
        with scheduler.slot("mlx", "project-a", "task-a"):
            order.append("a:start")
            first_entered.set()
            release_first.wait(timeout=2)
            order.append("a:end")

    def second() -> None:
        first_entered.wait(timeout=2)
        with scheduler.slot("mlx", "project-b", "task-b"):
            order.append("b:start")
            order.append("b:end")

    left = threading.Thread(target=first)
    right = threading.Thread(target=second)
    left.start()
    right.start()
    assert first_entered.wait(timeout=2)
    time.sleep(0.05)
    assert order == ["a:start"]
    snapshot = scheduler.snapshot()["mlx"]
    assert snapshot == {"limit": 1, "active": 1, "waiting": 1}
    release_first.set()
    left.join(timeout=2)
    right.join(timeout=2)
    assert order == ["a:start", "a:end", "b:start", "b:end"]


def test_scheduler_allows_different_resources_in_parallel() -> None:
    scheduler = ResourceScheduler({"sync": 1, "mlx": 1})
    sync_ready = threading.Event()
    mlx_ready = threading.Event()
    release = threading.Event()

    def run(resource: str, ready: threading.Event) -> None:
        with scheduler.slot(resource, "project", resource):
            ready.set()
            release.wait(timeout=2)

    left = threading.Thread(target=run, args=("sync", sync_ready))
    right = threading.Thread(target=run, args=("mlx", mlx_ready))
    left.start()
    right.start()
    assert sync_ready.wait(timeout=2)
    assert mlx_ready.wait(timeout=2)
    assert scheduler.snapshot()["sync"]["active"] == 1
    assert scheduler.snapshot()["mlx"]["active"] == 1
    release.set()
    left.join(timeout=2)
    right.join(timeout=2)


def test_waiting_resource_can_be_cancelled() -> None:
    scheduler = ResourceScheduler({"mlx": 1})
    first_ticket = scheduler.acquire("mlx", "project-a", "task-a")
    cancelled = threading.Event()
    result: list[str] = []

    def waiter() -> None:
        try:
            scheduler.acquire(
                "mlx",
                "project-b",
                "task-b",
                cancelled=cancelled.is_set,
                poll_seconds=0.02,
            )
        except ResourceCancelled:
            result.append("cancelled")

    thread = threading.Thread(target=waiter)
    thread.start()
    time.sleep(0.05)
    cancelled.set()
    thread.join(timeout=2)
    scheduler.release("mlx", first_ticket)
    assert result == ["cancelled"]
    assert scheduler.snapshot()["mlx"]["waiting"] == 0


def test_task_facade_declares_global_heavy_resource_gates() -> None:
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    tasks = (root / "src" / "script_organizer" / "tasks.py").read_text(encoding="utf-8")
    assert '"sync"' in tasks
    assert '"mlx"' in tasks
    assert '"vision"' in tasks
    assert "GLOBAL_RESOURCE_SCHEDULER.slot" in tasks
