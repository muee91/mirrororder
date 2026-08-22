from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from threading import Condition
from time import monotonic
from typing import Callable, Iterator
from uuid import uuid4


class ResourceCancelled(RuntimeError):
    """Raised when a queued task is cancelled before acquiring a resource."""


@dataclass(frozen=True)
class _Waiter:
    ticket: str
    resource: str
    project_id: str
    task_id: str
    priority: int
    sequence: int
    created_at: float


class ResourceScheduler:
    """Process-wide fair scheduler for expensive Host resources.

    Projects are independent and may be created or queued at any time. Only
    scarce compute resources are serialized. Priority is supported for future
    UI/API use; equal-priority work is FIFO.
    """

    def __init__(self, limits: dict[str, int] | None = None):
        defaults = {
            "sync": 1,
            "mlx": 1,
            "vision": 1,
            "cpu": 2,
        }
        self._limits = {
            key: max(1, int(value))
            for key, value in (limits or defaults).items()
        }
        self._active = {key: 0 for key in self._limits}
        self._waiting: dict[str, list[_Waiter]] = {key: [] for key in self._limits}
        self._condition = Condition()
        self._sequence = 0

    def _ensure_resource(self, resource: str) -> None:
        if resource in self._limits:
            return
        self._limits[resource] = 1
        self._active[resource] = 0
        self._waiting[resource] = []

    @staticmethod
    def _ordered(waiters: list[_Waiter]) -> list[_Waiter]:
        return sorted(waiters, key=lambda item: (-item.priority, item.sequence))

    def acquire(
        self,
        resource: str,
        project_id: str,
        task_id: str,
        *,
        priority: int = 0,
        cancelled: Callable[[], bool] | None = None,
        poll_seconds: float = 0.25,
    ) -> str:
        with self._condition:
            self._ensure_resource(resource)
            self._sequence += 1
            waiter = _Waiter(
                ticket="lease_" + uuid4().hex,
                resource=resource,
                project_id=project_id,
                task_id=task_id,
                priority=int(priority),
                sequence=self._sequence,
                created_at=monotonic(),
            )
            self._waiting[resource].append(waiter)
            try:
                while True:
                    if cancelled and cancelled():
                        raise ResourceCancelled(f"等待 {resource} 资源时任务已取消")
                    ordered = self._ordered(self._waiting[resource])
                    first = ordered[0] if ordered else None
                    if (
                        first is not None
                        and first.ticket == waiter.ticket
                        and self._active[resource] < self._limits[resource]
                    ):
                        self._waiting[resource] = [
                            item for item in self._waiting[resource]
                            if item.ticket != waiter.ticket
                        ]
                        self._active[resource] += 1
                        return waiter.ticket
                    self._condition.wait(timeout=max(0.05, float(poll_seconds)))
            except BaseException:
                self._waiting[resource] = [
                    item for item in self._waiting[resource]
                    if item.ticket != waiter.ticket
                ]
                self._condition.notify_all()
                raise

    def release(self, resource: str, ticket: str) -> None:
        del ticket  # ticket is primarily an audit/debug identifier for callers.
        with self._condition:
            self._ensure_resource(resource)
            self._active[resource] = max(0, self._active[resource] - 1)
            self._condition.notify_all()

    @contextmanager
    def slot(
        self,
        resource: str,
        project_id: str,
        task_id: str,
        *,
        priority: int = 0,
        cancelled: Callable[[], bool] | None = None,
    ) -> Iterator[None]:
        ticket = self.acquire(
            resource,
            project_id,
            task_id,
            priority=priority,
            cancelled=cancelled,
        )
        try:
            yield
        finally:
            self.release(resource, ticket)

    def snapshot(self) -> dict[str, dict[str, int]]:
        with self._condition:
            result: dict[str, dict[str, int]] = {}
            for resource in sorted(self._limits):
                result[resource] = {
                    "limit": self._limits[resource],
                    "active": self._active[resource],
                    "waiting": len(self._waiting[resource]),
                }
            return result


GLOBAL_RESOURCE_SCHEDULER = ResourceScheduler()
