from __future__ import annotations

from pathlib import Path
from typing import Any

from .device_runtime_settings import load_runtime_settings
from .device_tasks import initialize_device_tasks
from .identity_runtime import IdentityRuntime
from .local_vision_runtime import LocalVisionRuntime, LocalVisionRuntimeConfig
from .model_connections import load_model_connections, save_model_connections
from .model_registry import ModelRegistry


_INSTALLED = False
_LAST_RESTORE_ERROR = ""


def device_models_payload() -> dict[str, Any]:
    registry = ModelRegistry()
    return {
        "contract": "device_models.v1",
        "models": registry.public(),
        "routing": registry.routing(),
        "connections": load_model_connections(include_secrets=False),
        "restore_error": _LAST_RESTORE_ERROR,
    }


def restore_enabled_device_runtimes() -> list[dict[str, Any]]:
    """Restore enabled device capabilities after a Host restart.

    Runtime settings describe the desired state of this device. Model caches and
    native identity runtimes are not project-owned, so opening a different
    project must never require another manual activation step.
    """
    settings = load_runtime_settings()
    manager = initialize_device_tasks()
    submitted: list[dict[str, Any]] = []

    if bool(settings.get("local_vision_enabled", False)):
        model = str(settings.get("local_vision_model", "") or "").strip()
        vision = LocalVisionRuntime(LocalVisionRuntimeConfig.from_env(model)).public()
        if model and not bool(vision.get("running", False)) and not bool(vision.get("preparing", False)):
            submitted.append(
                manager.submit(
                    "local_vision_prepare",
                    {"model": model},
                    idempotency_key=f"local-vision:{model}",
                    actor="desktop-auto-restore",
                )
            )

    identity = IdentityRuntime.public()
    for kind, setting_key in (("face", "face_identity_enabled"), ("speaker", "speaker_identity_enabled")):
        if not bool(settings.get(setting_key, False)):
            continue
        state = identity.get(kind, {}) if isinstance(identity, dict) else {}
        if str(state.get("status", "") or "") in {"ready", "preparing"}:
            continue
        submitted.append(
            manager.submit(
                "identity_runtime_prepare",
                {"kind": kind},
                idempotency_key=f"identity-runtime:{kind}",
                actor="desktop-auto-restore",
            )
        )
    return submitted


def _restore_enabled_device_runtimes_best_effort() -> None:
    global _LAST_RESTORE_ERROR
    try:
        restore_enabled_device_runtimes()
    except Exception as error:
        # Optional local intelligence must never prevent the production Host
        # from opening. Keep the device preference enabled and expose the
        # failure through the model settings payload so the user can recover.
        _LAST_RESTORE_ERROR = f"{type(error).__name__}: {error}"[:2000]
    else:
        _LAST_RESTORE_ERROR = ""


def install_device_model_runtime() -> None:
    global _INSTALLED
    if _INSTALLED:
        return

    from . import web_server

    # Re-establish every capability whose persisted device preference is still
    # enabled, but never make optional model recovery a Host-startup dependency.
    _restore_enabled_device_runtimes_best_effort()
    original_make_handler = web_server.make_handler

    def make_handler_with_device_models(service: Any, web_root: Path):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if parts == ["api", "v1", "assistant", "models"]:
                    self._local_only()
                    self._send_json(device_models_payload())
                    return
                return super()._app_get(parsed)

            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if parts == ["api", "v1", "assistant", "models"]:
                    self._local_only()
                    saved = save_model_connections(web_server._body(self))
                    payload = device_models_payload()
                    payload["connections"] = saved
                    self._send_json(payload)
                    return
                return super()._app_post(parsed)

        return Handler

    web_server.make_handler = make_handler_with_device_models
    _INSTALLED = True


__all__ = [
    "device_models_payload",
    "install_device_model_runtime",
    "restore_enabled_device_runtimes",
]
