from __future__ import annotations

from threading import RLock
from typing import Any


RUNTIME_INSTALL_ORDER = (
    "device_media",
    "media_playback",
    "automation",
    "review_read_model",
    "editorial",
    "audit",
    "script_supervisor",
    "identity_api",
    "media_role",
    "waveform",
    "rough_placement",
    "coverage",
    "rough_cut",
    "assembly",
    "assistant",
    "semantic",
    "delivery",
    "desktop",
    "device_model",
    "media_inventory_task",
    "slate_media",
    "project_transfer",
    "project_location",
)

_LOCK = RLock()
_INSTALLED = False
_INSTALLING = False
_LAST_ERROR = ""


def _install_stack_once() -> None:
    """Install the Host runtime in dependency order using lazy imports.

    Device-media identity installs first, then the media-playback adapter binds
    standards-compliant byte-range responses before later handlers wrap the
    Host. Media-role projections must be installed before Coverage/Rough Cut
    modules bind their module-level projection functions. Desktop installs
    before device-model restoration so the durable device task manager and
    local runtime management surface exist first. The durable media-inventory
    adapter then owns scan submission while Desktop retains only lightweight
    binding/status surfaces. Explicit Slate file-drop resolution installs after
    device-media identity. Project transfer installs after Desktop/project task
    infrastructure so import/save/collect can reuse Status Center without a
    parallel job system. Project-location installs last because it only adds a
    local, lightweight path resolver for explicit Desktop reveal actions.
    """

    from .device_media_runtime import install_device_media_runtime
    install_device_media_runtime()

    from .media_playback_runtime import install_media_playback_runtime
    install_media_playback_runtime()

    from .automation_runtime import install_automation_runtime
    install_automation_runtime()

    from .review_read_model import install_review_read_model_runtime
    install_review_read_model_runtime()

    from .editorial_runtime import install_editorial_runtime
    install_editorial_runtime()

    from .audit_runtime import install_audit_runtime
    install_audit_runtime()

    from .script_supervisor_runtime import install_script_supervisor_runtime
    install_script_supervisor_runtime()

    from .identity_api_runtime import install_identity_api_runtime
    install_identity_api_runtime()

    from .media_role_runtime import install_media_role_runtime
    install_media_role_runtime()

    from .waveform_runtime import install_waveform_runtime
    install_waveform_runtime()

    from .rough_placement_runtime import install_rough_placement_runtime
    install_rough_placement_runtime()

    # These imports intentionally happen only after media-role projection
    # patching above has completed.
    from .coverage_runtime import install_coverage_runtime
    install_coverage_runtime()

    from .rough_cut_runtime import install_rough_cut_runtime
    install_rough_cut_runtime()

    from .assembly_runtime import install_assembly_runtime
    install_assembly_runtime()

    from .assistant_runtime import install_assistant_runtime
    install_assistant_runtime()

    from .semantic_runtime import install_semantic_runtime
    install_semantic_runtime()

    from .delivery_runtime import install_delivery_runtime
    install_delivery_runtime()

    from .desktop_runtime import install_desktop_runtime
    install_desktop_runtime()

    from .device_model_runtime import install_device_model_runtime
    install_device_model_runtime()

    from .media_inventory_task_runtime import install_media_inventory_task_runtime
    install_media_inventory_task_runtime()

    from .slate_media_runtime import install_slate_media_runtime
    install_slate_media_runtime()

    from .project_transfer.runtime import install_project_transfer_runtime
    install_project_transfer_runtime()

    from .project_location_runtime import install_project_location_runtime
    install_project_location_runtime()


def install_production_runtime() -> None:
    """Install all first-party Host runtime adapters exactly once.

    The stack-level installed flag flips only after every installer returns.
    Individual installers remain independently idempotent, so a failed stack
    install can be retried safely: already-completed layers no-op and the failed
    or not-yet-reached layers run again. Re-entrant installation is rejected
    rather than silently creating duplicate wrapper chains.
    """

    global _INSTALLED, _INSTALLING, _LAST_ERROR
    with _LOCK:
        if _INSTALLED:
            return
        if _INSTALLING:
            raise RuntimeError("Production runtime 正在安装，禁止重入")
        _INSTALLING = True
        _LAST_ERROR = ""
        try:
            _install_stack_once()
        except Exception as error:
            _LAST_ERROR = f"{type(error).__name__}: {error}"[:2000]
            raise
        else:
            _INSTALLED = True
        finally:
            _INSTALLING = False


def runtime_stack_state() -> dict[str, Any]:
    with _LOCK:
        return {
            "installed": _INSTALLED,
            "installing": _INSTALLING,
            "last_error": _LAST_ERROR,
            "order": list(RUNTIME_INSTALL_ORDER),
        }


__all__ = ["RUNTIME_INSTALL_ORDER", "install_production_runtime", "runtime_stack_state"]
