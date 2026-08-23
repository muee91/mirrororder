from __future__ import annotations

import json
import os
from pathlib import Path

from script_organizer.assistant_orchestrator import AssistantOrchestrator
from script_organizer.device_runtime_settings import save_runtime_settings
from script_organizer.model_connections import load_model_connections, save_model_connections
from script_organizer.model_registry import ModelRegistry
from script_organizer.review_store import ReviewStore
from script_organizer.automation_store import AutomationStore
from script_organizer.config import ProjectConfig


class FakeTaskManager:
    def __init__(self):
        self.submitted = []

    def list(self, _project_id: str):
        return []

    def submit(self, project_id, task_type, targets, idempotency_key="", actor="human"):
        row = {
            "task_id": f"task_{len(self.submitted) + 1}",
            "project_id": project_id,
            "type": task_type,
            "targets": targets,
            "idempotency_key": idempotency_key,
            "actor": actor,
            "status": "queued",
        }
        self.submitted.append(row)
        return row


def _config(tmp_path: Path) -> ProjectConfig:
    project = tmp_path / "project"
    output = project / "output"
    transcripts = project / "cache" / "transcripts"
    script = project / "script.txt"
    config_path = project / "project.toml"
    output.mkdir(parents=True)
    transcripts.mkdir(parents=True)
    script.write_text("第1集\n1-1 客厅\n王强：你好\n李雪：你回来了\n", encoding="utf-8")
    config_path.write_text("[project]\nname='demo'\n", encoding="utf-8")
    material = {
        "stats": {"groups": 1, "clips": 2},
        "clips": [],
        "groups": [
            {
                "group_id": "G1",
                "kind": "multicam",
                "start": 0.0,
                "end": 4.0,
                "duration": 4.0,
                "cameras": ["A", "B"],
                "members": [
                    {"clip_id": "CA", "camera": "A", "name": "A001.mov", "duration": 4.0},
                    {"clip_id": "CB", "camera": "B", "name": "B001.mov", "duration": 4.0},
                ],
            }
        ],
    }
    matches = {
        "groups": {
            "G1": {
                "candidates": [
                    {"candidate_id": "C1", "script_segment_ids": ["S1"], "confidence": "possible_dialogue", "total_score": 0.61},
                    {"candidate_id": "C2", "script_segment_ids": ["S2"], "confidence": "possible_dialogue", "total_score": 0.58},
                ]
            }
        },
        "script_gaps": [],
    }
    (output / "material_index.json").write_text(json.dumps(material), encoding="utf-8")
    (output / "matches.json").write_text(json.dumps(matches), encoding="utf-8")
    (output / "script.json").write_text(
        json.dumps({"segments": [
            {"segment_id": "S1", "episode": 1, "order": 1, "speaker": "王强", "text": "你好"},
            {"segment_id": "S2", "episode": 1, "order": 2, "speaker": "李雪", "text": "你回来了"},
        ]}),
        encoding="utf-8",
    )
    AutomationStore(output).save(
        "rev1",
        {
            "G1": {
                "status": "needs_review",
                "mapping_status": "ambiguous",
                "confidence": 0.61,
                "script_segment_ids": ["S1"],
            }
        },
        {},
    )
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


def test_model_connection_is_device_local_and_secret_is_not_public(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path / "app-support"))
    for name in (
        "MIRRORORDER_ASSISTANT_MODEL_PROVIDER",
        "MIRRORORDER_ASSISTANT_MODEL_BASE_URL",
        "MIRRORORDER_ASSISTANT_MODEL_API_KEY",
        "MIRRORORDER_ASSISTANT_MODEL_NAME",
        "MIRRORORDER_MODEL_PROVIDER",
        "MIRRORORDER_MODEL_BASE_URL",
        "MIRRORORDER_MODEL_API_KEY",
        "MIRRORORDER_MODEL_NAME",
    ):
        monkeypatch.delenv(name, raising=False)
    saved = save_model_connections(
        {
            "text": {
                "enabled": True,
                "provider": "openai-compatible",
                "base_url": "http://127.0.0.1:1234/v1",
                "model": "local-text",
                "api_key": "secret-demo-key",
            }
        }
    )
    assert saved["text"]["has_api_key"] is True
    assert "api_key" not in saved["text"]
    private = load_model_connections(include_secrets=True)
    assert private["text"]["api_key"] == "secret-demo-key"
    registry = ModelRegistry().public()
    assert registry["assistant_language"]["enabled"] is True
    assert registry["assistant_language"]["source"] == "device-model-connection"
    assert "secret-demo-key" not in json.dumps(registry)
    assert not (tmp_path / "project" / "output" / "model-secrets.json").exists()
    if os.name != "nt":
        mode = (tmp_path / "app-support" / "model-secrets.json").stat().st_mode & 0o777
        assert mode == 0o600


def test_assistant_prioritizes_human_mapping_conflict(tmp_path: Path) -> None:
    config = _config(tmp_path)
    ReviewStore(config.output_dir / "review.json").apply_action(
        {
            "action": "set_group_placement",
            "group_id": "G1",
            "episode_ids": [1],
            "script_segment_ids": ["S2"],
            "actor": "editor",
        }
    )
    assistant = AssistantOrchestrator("ws", "demo", config)
    payload = assistant.cycle(trigger="test", allow_actions=False)
    assert payload["contract"] == "assistant.v1"
    assert payload["items"][0]["priority"] == 100
    assert payload["items"][0]["label"] == "归集冲突"
    assert payload["items"][0]["actions"] == ["focus", "placement"]
    # Assistant is derived state only; it must not mutate the human placement.
    review = ReviewStore(config.output_dir / "review.json").load()
    assert review["placements"]["G1"]["script_segment_ids"] == ["S2"]


def test_enabled_local_vision_triggers_one_bounded_priority_audit(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path / "app-support"))
    monkeypatch.delenv("MIRRORORDER_VISION_PROVIDER", raising=False)
    save_runtime_settings({"local_vision_enabled": True, "local_vision_model": "local-test.gguf"})
    config = _config(tmp_path)
    manager = FakeTaskManager()
    assistant = AssistantOrchestrator("ws", "demo", config, task_manager=manager)
    first = assistant.cycle(trigger="analysis", allow_actions=True)
    assert len(manager.submitted) == 1
    task = manager.submitted[0]
    assert task["type"] == "audit"
    assert task["targets"]["mode"] == "priority"
    assert task["targets"]["max_groups"] <= 24
    assert task["actor"] == "mirrororder-assistant"
    assert first["orchestration"]["last_action"]["results"][0]["tool"] == "run_priority_audit"

    assistant.cycle(trigger="poll", allow_actions=True)
    assert len(manager.submitted) == 1


def test_disabled_models_do_not_create_expensive_task(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path / "app-support"))
    monkeypatch.setenv("MIRRORORDER_VISION_PROVIDER", "none")
    monkeypatch.setenv("MIRRORORDER_MODEL_PROVIDER", "none")
    config = _config(tmp_path)
    manager = FakeTaskManager()
    payload = AssistantOrchestrator("ws", "demo", config, task_manager=manager).cycle(
        trigger="analysis", allow_actions=True
    )
    assert manager.submitted == []
    assert payload["items"]


def test_static_runtime_and_ui_contracts() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "src" / "script_organizer" / "assistant_runtime.py").read_text(encoding="utf-8")
    orchestrator = (root / "src" / "script_organizer" / "assistant_orchestrator.py").read_text(encoding="utf-8")
    tools = (root / "src" / "script_organizer" / "agent_tools.py").read_text(encoding="utf-8")
    index = (root / "web" / "index.html").read_text(encoding="utf-8")
    control = (root / "web" / "assistant_control_ui.js").read_text(encoding="utf-8")
    css = (root / "web" / "assistant.css").read_text(encoding="utf-8")
    editorial = (root / "src" / "script_organizer" / "editorial_runtime.py").read_text(encoding="utf-8")

    assert "install_assistant_runtime" in editorial
    assert "assistant/models" not in runtime  # routing is structured, not string-concatenated endpoint logic
    assert 'parts[4] == "assistant"' in runtime
    assert 'parts[5] == "models"' in runtime
    assert 'parts[5] == "message"' in runtime
    assert 'parts[5:] == ["assistant", "cycle"]' in runtime
    assert "self._local_only()" in runtime
    assert "direct_review_write\": False" in runtime
    assert 'SAFE_ACTIONS = {"run_priority_audit", "collect_learning_cases", "noop"}' in tools
    assert "review.json" not in "\n".join(
        line for line in tools.splitlines() if "write" in line.lower() or "save(" in line
    )
    assert "不得写review.json或editorial.json" in orchestrator
    assert '/assistant.css' in index
    assert index.index('/assistant_ui.js') < index.index('/assistant_control_ui.js')
    assert '/assistant/models' in control
    assert '/assistant/message' in control
    assert '/assistant/cycle' in control
    assert 'Agent API 已启用' in control
    assert 'data:image/webp;base64,' in css
