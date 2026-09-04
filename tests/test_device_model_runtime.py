from __future__ import annotations

from types import SimpleNamespace

from script_organizer import device_model_runtime
from script_organizer.model_registry import ModelRegistry


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


def test_auto_restore_failure_is_diagnostic_not_host_startup_failure(monkeypatch) -> None:
    monkeypatch.setattr(
        device_model_runtime,
        "restore_enabled_device_runtimes",
        lambda: (_ for _ in ()).throw(RuntimeError("model cache unavailable")),
    )
    monkeypatch.setattr(device_model_runtime, "_LAST_RESTORE_ERROR", "")

    # This helper is deliberately non-raising because optional model recovery
    # must never prevent the Host and project workspace from opening.
    device_model_runtime._restore_enabled_device_runtimes_best_effort()

    assert device_model_runtime._LAST_RESTORE_ERROR == "RuntimeError: model cache unavailable"


def test_device_model_payload_never_requires_a_project(monkeypatch) -> None:
    class _Registry:
        def public(self):
            return {"contract": "models.v1"}

        def routing(self):
            return {
                "contract": "model_routing.v1",
                "mode": "fallback",
                "privacy": "local-only",
                "text": {"enabled": False, "provider": "none", "model": "", "local": False},
                "vision": {"enabled": False, "provider": "none", "model": "", "local": False},
                "embedding": {
                    "enabled": False,
                    "provider": "none",
                    "model": "",
                    "local": False,
                    "fallback": "keyword",
                },
            }

    monkeypatch.setattr(device_model_runtime, "ModelRegistry", _Registry)
    monkeypatch.setattr(device_model_runtime, "_LAST_RESTORE_ERROR", "")
    monkeypatch.setattr(
        device_model_runtime,
        "load_model_connections",
        lambda include_secrets=False: {"version": 1, "include_secrets": include_secrets},
    )

    payload = device_model_runtime.device_models_payload()
    assert payload["contract"] == "device_models.v1"
    assert payload["models"] == {"contract": "models.v1"}
    assert payload["routing"]["embedding"]["fallback"] == "keyword"
    assert payload["connections"]["include_secrets"] is False
    assert payload["restore_error"] == ""
    assert "project_id" not in payload


def _routing_registry(*, text, vision, embedding) -> ModelRegistry:
    registry = ModelRegistry.__new__(ModelRegistry)
    registry.assistant = SimpleNamespace(**text)
    registry.vision = SimpleNamespace(**vision)
    registry.embedding = SimpleNamespace(**embedding)
    return registry


def test_effective_routing_reuses_local_vlm_for_text_and_keeps_keyword_fallback() -> None:
    registry = _routing_registry(
        text={
            "enabled": True,
            "provider": "local-vision",
            "model": "Qwen3-VL",
            "is_local": True,
            "source": "local-vision-text-fallback",
        },
        vision={
            "enabled": True,
            "provider": "local",
            "model": "Qwen3-VL",
            "is_local": True,
        },
        embedding={
            "enabled": False,
            "provider": "none",
            "model": "",
            "local": False,
            "source": "none",
        },
    )

    routing = registry.routing()

    assert routing["mode"] == "local"
    assert routing["privacy"] == "local-only"
    assert routing["text"]["source"] == "local-vision-text-fallback"
    assert routing["text"]["model"] == routing["vision"]["model"] == "Qwen3-VL"
    assert routing["embedding"]["fallback"] == "keyword"


def test_effective_routing_reports_hybrid_when_external_text_and_local_vision_mix() -> None:
    registry = _routing_registry(
        text={
            "enabled": True,
            "provider": "openai-compatible",
            "model": "remote-text",
            "is_local": False,
            "source": "device-model-connection",
        },
        vision={
            "enabled": True,
            "provider": "local",
            "model": "Qwen3-VL",
            "is_local": True,
        },
        embedding={
            "enabled": False,
            "provider": "none",
            "model": "",
            "local": False,
            "source": "none",
        },
    )

    routing = registry.routing()

    assert routing["mode"] == "hybrid"
    assert routing["privacy"] == "mixed"
    assert routing["text"]["local"] is False
    assert routing["vision"]["local"] is True


def test_effective_routing_reports_foundational_fallback_when_no_models_are_enabled() -> None:
    registry = _routing_registry(
        text={"enabled": False, "provider": "none", "model": "", "is_local": False, "source": "none"},
        vision={"enabled": False, "provider": "none", "model": "", "is_local": False},
        embedding={"enabled": False, "provider": "none", "model": "", "local": False, "source": "none"},
    )

    routing = registry.routing()

    assert routing["mode"] == "fallback"
    assert routing["privacy"] == "local-only"
    assert routing["embedding"]["fallback"] == "keyword"
