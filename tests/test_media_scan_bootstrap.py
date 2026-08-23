from __future__ import annotations

import json
from pathlib import Path

from script_organizer.cli import main
from script_organizer.media_identity import DeviceMediaStore


def test_media_scan_bootstraps_new_project_before_material_index(tmp_path: Path, monkeypatch, capsys) -> None:
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device-state"))

    workspace = tmp_path / "workspace.toml"
    projects = tmp_path / "projects"
    project_dir = projects / "demo"
    inputs = project_dir / "inputs"
    media = tmp_path / "shoot"
    (media / "A").mkdir(parents=True)
    (media / "B").mkdir(parents=True)
    inputs.mkdir(parents=True)

    (media / "A" / "A001.mov").write_bytes(b"a")
    (media / "B" / "B001.mp4").write_bytes(b"b")
    (media / "notes.txt").write_text("not media", encoding="utf-8")
    (inputs / "script.md").write_text("第1集\n1-1 室内\n小王：你好\n", encoding="utf-8")

    workspace.write_text(
        "[workspace]\n"
        'id = "ws_bootstrap"\n'
        'name = "测试工作区"\n'
        'registry = "./projects/registry.json"\n'
        'web_directory = "./web"\n',
        encoding="utf-8",
    )
    (projects / "registry.json").write_text(
        json.dumps(
            {
                "version": 1,
                "projects": [
                    {
                        "project_id": "demo",
                        "name": "Demo",
                        "config_path": "projects/demo/project.toml",
                        "input_kind": "media-directory",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    (project_dir / "project.toml").write_text(
        "[project]\n"
        'id = "demo"\n'
        'name = "Demo"\n\n'
        "[input]\n"
        'kind = "media-directory"\n'
        'script = "./inputs/script.md"\n\n'
        "[output]\n"
        'directory = "./output"\n\n'
        "[asr]\n"
        'transcript_dir = "./cache/transcripts"\n',
        encoding="utf-8",
    )

    assert not (project_dir / "output" / "material_index.json").exists()
    assert main(["media-scan", str(workspace), "demo", str(media)]) == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload["pending_analysis"] is True
    assert payload["scan"]["files_seen"] == 2
    assert payload["total"] == 2
    assert payload["resolved"] == 2
    assert payload["missing"] == 0

    snapshot = DeviceMediaStore().project_snapshot("ws_bootstrap", "demo")
    assert snapshot["roots"] == [str(media.resolve())]
    assert snapshot["bindings"] == {}
