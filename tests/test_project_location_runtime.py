from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from script_organizer.project_location_runtime import UnsafeProjectLocation, project_local_location


class _Registry:
    def __init__(self, workspace_path: Path, config_path: Path, *, entry_path: str | None = None) -> None:
        self.config = SimpleNamespace(
            config_path=workspace_path,
            registry_path=workspace_path.parent / "projects" / "registry.json",
        )
        self._config_path = config_path
        self._entry_path = entry_path

    def get(self, project_id: str):
        assert project_id == "p1"
        if self._entry_path is not None:
            value = self._entry_path
        else:
            value = str(self._config_path.relative_to(self.config.config_path.parent))
        return {"project_id": project_id, "config_path": value}

    def project_config(self, _project_id: str):
        raise AssertionError("local-location must not load device media bindings")


def _project(tmp_path: Path, *, make_output: bool, output_value: str = "./output") -> tuple[Path, Path, Path]:
    workspace_path = tmp_path / "workspace.toml"
    workspace_path.write_text('[workspace]\nid = "ws-test"\n', encoding="utf-8")
    project_dir = tmp_path / "projects" / "p1"
    output_dir = project_dir / "output"
    project_dir.mkdir(parents=True)
    if make_output:
        output_dir.mkdir()
    config_path = project_dir / "project.toml"
    config_path.write_text(
        "\n".join([
            "[project]",
            'name = "Test"',
            "",
            "[input]",
            'kind = "media-directory"',
            'script = "./inputs/script.txt"',
            "",
            "[output]",
            f'directory = "{output_value}"',
            "",
            "[asr]",
            'transcript_dir = "./cache/transcripts"',
        ]) + "\n",
        encoding="utf-8",
    )
    return workspace_path, config_path, output_dir


def test_project_location_is_device_local_response_only(tmp_path: Path) -> None:
    workspace_path, config_path, output_dir = _project(tmp_path, make_output=True)
    project_dir = config_path.parent
    service = SimpleNamespace(registry=_Registry(workspace_path, config_path))

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


def test_project_location_uses_gateway_current_service_without_media_binding_lookup(tmp_path: Path) -> None:
    workspace_path, config_path, output_dir = _project(tmp_path, make_output=False)
    current = SimpleNamespace(registry=_Registry(workspace_path, config_path))
    gateway = SimpleNamespace(current=current)

    payload = project_local_location(gateway, "p1")
    assert payload["project_dir"] == str(config_path.parent.resolve())
    assert payload["output_dir"] == str(output_dir.resolve())
    assert payload["output_exists"] is False


def test_project_location_rejects_registry_path_escape(tmp_path: Path) -> None:
    workspace_path, config_path, _output_dir = _project(tmp_path, make_output=False)
    outside = tmp_path / "outside" / "project.toml"
    outside.parent.mkdir()
    outside.write_text(config_path.read_text(encoding="utf-8"), encoding="utf-8")
    service = SimpleNamespace(
        registry=_Registry(workspace_path, config_path, entry_path="../outside/project.toml")
    )

    with pytest.raises(UnsafeProjectLocation, match="项目配置路径不在"):
        project_local_location(service, "p1")


def test_project_location_rejects_output_escape(tmp_path: Path) -> None:
    workspace_path, config_path, _output_dir = _project(
        tmp_path,
        make_output=False,
        output_value="../../outside-output",
    )
    service = SimpleNamespace(registry=_Registry(workspace_path, config_path))

    with pytest.raises(UnsafeProjectLocation, match="项目输出目录不在"):
        project_local_location(service, "p1")
