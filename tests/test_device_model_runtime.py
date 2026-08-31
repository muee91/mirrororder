from __future__ import annotations

from script_organizer import device_model_runtime


class _Tasks:
    def __init__(self) -> None:
        self.rows: list[dict[str, object]] = []

    def submit(self, task_type, targets, idempotency_key="", actor=""):
        row = {
            "task_id": f"task-{len(self.rows) + 1}",
            "type": task_type,
            "targets": targets,
            "idempotency_key": idempotency_key,
            "actor": actor,
        }
        self.rows.append(row)
        return row


class _Vision:
    def __init__(self, _config) -> None:
        pass

    def public(self):
        return {"running": False, "preparing": False, "status": "cached"}


class _Identity:
    @staticmethod
    def public():
        return {
            "face": {"status": "not_prepared"},
            "speaker": {"status": "ready"},
        }


def test_enabled_device_capabilities_restore_without_project_scope(monkeypatch) -> None:
    tasks = _Tasks()
    monkeypatch.setattr(
        device_model_runtime,
        "load_runtime_settings",
        lambda: {
            "local_vision_enabled": True,
            "local_vision_model": "Qwen/Qwen3-VL-4B-Instruct-GGUF:Q4_K_M",
            "face_identity_enabled": True,
            "speaker_identity_enabled": True,
        },
    )
    monkeypatch.setattr(device_model_runtime, "initialize_device_tasks", lambda: tasks)
    monkeypatch.setattr(device_model_runtime, "LocalVisionRuntime", _Vision)
    monkeypatch.setattr(device_model_runtime, "IdentityRuntime", _Identity)

    restored = device_model_runtime.restore_enabled_device_runtimes()

    assert [row["type"] for row in restored] == ["local_vision_prepare", "identity_runtime_prepare"]
    assert tasks.rows[0]["targets"] == {"model": "Qwen/Qwen3-VL-4B-Instruct-GGUF:Q4_K_M"}
    assert tasks.rows[1]["targets"] == {"kind": "face"}
    assert all(row["actor"] == "desktop-auto-restore" for row in tasks.rows)
    assert all("project" not in row["targets"] for row in tasks.rows)


def test_disabled_device_capabilities_do_not_auto_restore(monkeypatch) -> None:
    tasks = _Tasks()
    monkeypatch.setattr(
        device_model_runtime,
        "load_runtime_settings",
        lambda: {
            "local_vision_enabled": False,
            "local_vision_model": "Qwen/Qwen3-VL-4B-Instruct-GGUF:Q4_K_M",
            "face_identity_enabled": False,
            "speaker_identity_enabled": False,
        },
    )
    monkeypatch.setattr(device_model_runtime, "initialize_device_tasks", lambda: tasks)
    monkeypatch.setattr(device_model_runtime, "LocalVisionRuntime", _Vision)
    monkeypatch.setattr(device_model_runtime, "IdentityRuntime", _Identity)

    assert device_model_runtime.restore_enabled_device_runtimes() == []
    assert tasks.rows == []


def test_device_model_payload_never_requires_a_project(monkeypatch) -> None:
    class _Registry:
        def public(self):
            return {"contract": "models.v1"}

    monkeypatch.setattr(device_model_runtime, "ModelRegistry", _Registry)
    monkeypatch.setattr(
        device_model_runtime,
        "load_model_connections",
        lambda include_secrets=False: {"version": 1, "include_secrets": include_secrets},
    )

    payload = device_model_runtime.device_models_payload()
    assert payload["contract"] == "device_models.v1"
    assert payload["models"] == {"contract": "models.v1"}
    assert payload["connections"]["include_secrets"] is False
    assert "project_id" not in payload
