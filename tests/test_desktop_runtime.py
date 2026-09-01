from __future__ import annotations

from pathlib import Path

import pytest

from script_organizer import desktop_runtime
from script_organizer.desktop_runtime import (
    _apply_runtime_action,
    _current_service,
    _normalize_roots,
    _workspace_root,
)


class _FakeDeviceTasks:
    def __init__(self) -> None:
        self.submitted: list[tuple[str, dict[str, object], str, str]] = []
        self.tasks: list[dict[str, object]] = []
        self.superseded: list[tuple[str, dict[str, object]]] = []

    def submit(self, task_type, targets=None, idempotency_key="", actor="desktop"):
        normalized = dict(targets or {})
        self.submitted.append((task_type, normalized, idempotency_key, actor))
        task = {
            "task_id": "device_task_1",
            "scope": "device",
            "type": task_type,
            "targets": normalized,
            "status": "queued",
        }
        self.tasks.insert(0, task)
        return task

    def list(self):
        return list(self.tasks)

    def cancel(self, task_id):
        return {"task_id": task_id, "status": "cancelled"}

    def supersede(self, task_type, **kwargs):
        self.superseded.append((task_type, dict(kwargs)))
        return 0


def test_normalize_roots_deduplicates_and_resolves(tmp_path: Path) -> None:
    first = tmp_path / "A"
    second = tmp_path / "B"
    first.mkdir()
    second.mkdir()
    roots = _normalize_roots([str(first), str(first), str(second)])
    assert roots == [str(first.resolve()), str(second.resolve())]


def test_normalize_roots_requires_existing_directory(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="媒体目录不存在"):
        _normalize_roots([str(tmp_path / "missing")])
    with pytest.raises(ValueError, match="至少选择一个"):
        _normalize_roots([])


def test_workspace_root_uses_workspace_config_parent(tmp_path: Path) -> None:
    class Workspace:
        config_path = tmp_path / "workspace.toml"

    class Service:
        workspace = Workspace()

    assert _workspace_root(Service()) == tmp_path


def test_current_service_uses_gateway_current_workspace() -> None:
    current = object()

    class Gateway:
        pass

    gateway = Gateway()
    gateway.current = current
    assert _current_service(gateway) is current
    assert _current_service(current) is current


def test_runtime_set_maps_identity_fields_to_device_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    saved: list[dict[str, object]] = []
    monkeypatch.setattr(desktop_runtime, "get_device_task_manager", lambda: _FakeDeviceTasks())
    monkeypatch.setattr(desktop_runtime, "load_runtime_settings", lambda: {
        "local_vision_enabled": True,
        "local_vision_model": "old-model",
        "face_identity_enabled": True,
        "speaker_identity_enabled": True,
    })

    def save(values: dict[str, object]) -> dict[str, object]:
        saved.append(dict(values))
        return {
            "local_vision_enabled": values.get("local_vision_enabled", True),
            "local_vision_model": values.get("local_vision_model", "old-model"),
            "face_identity_enabled": values.get("face_identity_enabled", True),
            "speaker_identity_enabled": values.get("speaker_identity_enabled", True),
        }

    monkeypatch.setattr(desktop_runtime, "save_runtime_settings", save)
    monkeypatch.setattr(desktop_runtime.LocalVisionRuntime, "stop", lambda: None)
    monkeypatch.setattr(desktop_runtime, "_local_runtime_payload", lambda _service: {"contract": "local_runtime.v1"})

    result = _apply_runtime_action(
        object(),
        {
            "action": "set",
            "local_vision_enabled": False,
            "face_identity_enabled": False,
            "speaker_identity_enabled": True,
        },
    )
    assert result == {"contract": "local_runtime.v1"}
    assert saved == [{
        "local_vision_enabled": False,
        "face_identity_enabled": False,
        "speaker_identity_enabled": True,
    }]


def test_runtime_prepare_submits_path_free_device_task(monkeypatch: pytest.MonkeyPatch) -> None:
    tasks = _FakeDeviceTasks()
    monkeypatch.setattr(desktop_runtime, "get_device_task_manager", lambda: tasks)
    monkeypatch.setattr(desktop_runtime, "load_runtime_settings", lambda: {
        "local_vision_enabled": True,
        "local_vision_model": "Qwen/Qwen3-VL-4B-Instruct-GGUF:Q4_K_M",
        "face_identity_enabled": True,
        "speaker_identity_enabled": True,
    })
    monkeypatch.setattr(desktop_runtime, "_local_runtime_payload", lambda _service: {"contract": "local_runtime.v1"})

    result = _apply_runtime_action(object(), {"action": "prepare"})

    assert tasks.submitted == [(
        "local_vision_prepare",
        {"model": "Qwen/Qwen3-VL-4B-Instruct-GGUF:Q4_K_M"},
        "local-vision:Qwen/Qwen3-VL-4B-Instruct-GGUF:Q4_K_M",
        "desktop",
    )]
    assert result["device_task"]["scope"] == "device"
    assert result["device_task"]["targets"] == {"model": "Qwen/Qwen3-VL-4B-Instruct-GGUF:Q4_K_M"}


def test_runtime_prepare_identity_submits_device_task(monkeypatch: pytest.MonkeyPatch) -> None:
    tasks = _FakeDeviceTasks()
    monkeypatch.setattr(desktop_runtime, "get_device_task_manager", lambda: tasks)
    monkeypatch.setattr(desktop_runtime, "load_runtime_settings", lambda: {
        "local_vision_enabled": False,
        "local_vision_model": "model",
        "face_identity_enabled": True,
        "speaker_identity_enabled": True,
    })
    monkeypatch.setattr(desktop_runtime, "_local_runtime_payload", lambda _service: {"contract": "local_runtime.v1"})

    result = _apply_runtime_action(object(), {"action": "prepare_identity", "kind": "speaker"})

    assert tasks.submitted == [(
        "identity_runtime_prepare",
        {"kind": "speaker"},
        "identity-runtime:speaker",
        "desktop",
    )]
    assert result["device_task"]["type"] == "identity_runtime_prepare"


def test_runtime_prepare_identity_rejects_unknown_kind(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(desktop_runtime, "get_device_task_manager", lambda: _FakeDeviceTasks())
    monkeypatch.setattr(desktop_runtime, "load_runtime_settings", lambda: {})
    with pytest.raises(ValueError, match="face 或 speaker"):
        _apply_runtime_action(object(), {"action": "prepare_identity", "kind": "voice"})
