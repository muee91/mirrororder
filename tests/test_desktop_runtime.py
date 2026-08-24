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


def test_runtime_set_maps_legacy_identity_fields_to_device_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    saved: list[dict[str, object]] = []
    monkeypatch.setattr(desktop_runtime, "load_runtime_settings", lambda: {
        "local_vision_enabled": True,
        "local_vision_model": "old-model",
        "local_face_identity_enabled": True,
        "local_speaker_identity_enabled": True,
    })

    def save(values: dict[str, object]) -> dict[str, object]:
        saved.append(dict(values))
        return {
            "local_vision_enabled": values.get("local_vision_enabled", True),
            "local_vision_model": values.get("local_vision_model", "old-model"),
            "local_face_identity_enabled": values.get("local_face_identity_enabled", True),
            "local_speaker_identity_enabled": values.get("local_speaker_identity_enabled", True),
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
        "local_face_identity_enabled": False,
        "local_speaker_identity_enabled": True,
    }]


def test_runtime_prepare_identity_rejects_unknown_kind() -> None:
    with pytest.raises(ValueError, match="face 或 speaker"):
        _apply_runtime_action(object(), {"action": "prepare_identity", "kind": "voice"})
