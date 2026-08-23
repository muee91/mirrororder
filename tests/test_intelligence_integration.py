from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

import script_organizer.tasks as task_module
from script_organizer.automation_runtime import _project_relative_script, _workspace_for_service
from script_organizer.config import ProjectConfig
from script_organizer.resource_scheduler import ResourceCancelled
from script_organizer.tasks import TaskManager


def _config(tmp_path: Path, script: Path) -> ProjectConfig:
    project = tmp_path / "project"
    project.mkdir(parents=True, exist_ok=True)
    config_path = project / "project.toml"
    config_path.write_text("[project]\nname='demo'\n", encoding="utf-8")
    output = project / "output"
    output.mkdir(exist_ok=True)
    transcripts = project / "cache" / "transcripts"
    transcripts.mkdir(parents=True, exist_ok=True)
    return ProjectConfig(
        config_path=config_path,
        name="demo",
        fcpxml=None,
        script=script,
        output_dir=output,
        transcript_dir=transcripts,
        input_kind="media-directory",
        media_root=None,
    )


def test_workspace_database_route_resolves_host_and_gateway_contexts() -> None:
    workspace = SimpleNamespace(workspace_id="ws_demo")
    host = SimpleNamespace(workspace=workspace)
    gateway = SimpleNamespace(current=SimpleNamespace(workspace=workspace))

    assert _workspace_for_service(host) is workspace
    assert _workspace_for_service(gateway) is workspace


def test_project_payload_only_exposes_project_relative_script_path(tmp_path: Path) -> None:
    internal = tmp_path / "project" / "inputs" / "script.md"
    internal.parent.mkdir(parents=True)
    internal.write_text("demo", encoding="utf-8")
    project = SimpleNamespace(config=_config(tmp_path, internal))

    assert _project_relative_script(project) == "./inputs/script.md"

    external = tmp_path / "outside.md"
    external.write_text("outside", encoding="utf-8")
    external_project = SimpleNamespace(config=_config(tmp_path / "external-case", external))
    assert _project_relative_script(external_project) == ""


def test_perception_cancel_propagates_to_parent_task(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeIndexer:
        def __init__(self, *args, **kwargs):
            pass

        def run(self, **kwargs):
            return {"status": "cancelled"}

    @contextmanager
    def resource(*args, **kwargs):
        yield

    manager = TaskManager(lambda _project_id: None, "ws_demo")
    monkeypatch.setattr(task_module, "PerceptionIndexer", FakeIndexer)
    monkeypatch.setattr(manager, "_resource", resource)
    monkeypatch.setattr(manager, "_update", lambda *args, **kwargs: None)
    monkeypatch.setattr(manager, "_cancel_requested", lambda *args, **kwargs: False)

    with pytest.raises(ResourceCancelled):
        manager._perception_best_effort(
            SimpleNamespace(),
            {"task_id": "task_demo", "project_id": "project-a"},
            mode="tier0",
        )


def test_intelligence_database_endpoint_is_local_only() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "src" / "script_organizer" / "automation_runtime.py").read_text(encoding="utf-8")
    tasks = (root / "src" / "script_organizer" / "tasks.py").read_text(encoding="utf-8")

    assert 'parts == ["api", "v1", "workspace-database"]' in runtime
    assert "self._local_only()" in runtime
    assert "PerceptionIndexer" in tasks
    assert "感知索引已延后，不影响主分析" in tasks
