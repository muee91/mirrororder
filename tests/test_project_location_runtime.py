from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from script_organizer.project_location_runtime import project_local_location


class _Registry:
    def __init__(self, config) -> None:
        self.config = config

    def project_config(self, project_id: str):
        assert project_id == "p1"
        return self.config


def test_project_location_is_device_local_response_only(tmp_path: Path) -> None:
    project_dir = tmp_path / "projects" / "p1"
    output_dir = project_dir / "output"
    output_dir.mkdir(parents=True)
    config = SimpleNamespace(project_dir=project_dir, output_dir=output_dir)
    service = SimpleNamespace(registry=_Registry(config))

    payload = project_local_location(service, "p1")

    assert payload == {
        "contract": "project_local_location.v1",
        "project_id": "p1",
        "project_dir": str(project_dir.resolve()),
        "output_dir": str(output_dir.resolve()),
        "project_exists": True,
        "output_exists": True,
        "device_paths_exposed": True,
        "scope": "device_local_response",
    }


def test_project_location_uses_gateway_current_service(tmp_path: Path) -> None:
    project_dir = tmp_path / "p1"
    output_dir = project_dir / "output"
    project_dir.mkdir()
    config = SimpleNamespace(project_dir=project_dir, output_dir=output_dir)
    current = SimpleNamespace(registry=_Registry(config))
    gateway = SimpleNamespace(current=current)

    payload = project_local_location(gateway, "p1")
    assert payload["project_dir"] == str(project_dir.resolve())
    assert payload["output_exists"] is False
