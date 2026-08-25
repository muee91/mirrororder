from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

from script_organizer.agent_tools import AgentToolRegistry
from script_organizer.assistant_orchestrator import AssistantOrchestrator
from script_organizer.assistant_runtime import _refresh_after_review
from script_organizer.audit_engine import _analysis_revision, _mapping_for_group
from script_organizer.audit_store import AuditStore
from script_organizer.automation_store import AutomationStore
from script_organizer.config import ProjectConfig
from script_organizer.device_runtime_settings import save_runtime_settings
from script_organizer.model_connections import load_model_connections, save_model_connections
from script_organizer.model_registry import ModelRegistry
from script_organizer.review_store import ReviewStore
from script_organizer.vision_provider import VisionProviderConfig


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


class FakeLanguagePlan:
    enabled = True

    def complete_json(self, **_kwargs):
        return {
            "briefing": "只补这一组视觉证据。",
            "actions": [
                {"tool": "extract_visual_evidence", "arguments": {"group_ids": ["G1"]}},
                {"tool": "noop", "arguments": {}},
            ],
            "questions": [],
        }


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


def _clear_model_env(monkeypatch) -> None:
    for name in (
        "MIRRORORDER_ASSISTANT_MODEL_PROVIDER",
        "MIRRORORDER_ASSISTANT_MODEL_BASE_URL",
        "MIRRORORDER_ASSISTANT_MODEL_API_KEY",
        "MIRRORORDER_ASSISTANT_MODEL_NAME",
        "MIRRORORDER_MODEL_PROVIDER",
        "MIRRORORDER_MODEL_BASE_URL",
        "MIRRORORDER_MODEL_API_KEY",
        "MIRRORORDER_MODEL_NAME",
        "MIRRORORDER_VISION_PROVIDER",
        "MIRRORORDER_VISION_BASE_URL",
        "MIRRORORDER_VISION_API_KEY",
        "MIRRORORDER_VISION_MODEL",
    ):
        monkeypatch.delenv(name, raising=False)


def _save_current_audit(config: ProjectConfig) -> None:
    index = json.loads((config.output_dir / "material_index.json").read_text(encoding="utf-8"))
    group = index["groups"][0]
    review = ReviewStore(config.output_dir / "review.json").load()
    automatic = AutomationStore(config.output_dir).load()["groups"]["G1"]
    mapping = _mapping_for_group(review, automatic, group)
    analysis_revision = _analysis_revision(config.output_dir)
    AuditStore(config.output_dir).save(
        {
            "analysis_revision": analysis_revision,
            "review_revision": review["revision"],
            "summary": {"current_groups": 1},
            "groups": {
                "G1": {
                    "group_id": "G1",
                    "analysis_revision": analysis_revision,
                    "evidence_fingerprint": "demo",
                    "priority": 82,
                    "mapping": mapping,
                    "judge": {"verdict": "agree", "confidence": 0.8, "reason": "demo"},
                    "issues": [],
                    "algorithm_feedback": {},
                    "role_suggestions": [],
                    "shot_intelligence": {
                        "angles": {
                            "CA": {
                                "clip_id": "CA",
                                "camera": "A",
                                "shot_type": "closeup",
                                "coverage_role": "dialogue",
                                "visible_people": [],
                                "technical_issues": [],
                            }
                        }
                    },
                    "rough_cut": {},
                }
            },
        }
    )


def test_model_connections_are_device_local_and_secrets_are_not_public(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path / "app-support"))
    _clear_model_env(monkeypatch)
    saved = save_model_connections(
        {
            "text": {
                "enabled": True,
                "provider": "openai-compatible",
                "base_url": "http://127.0.0.1:1234/v1",
                "model": "local-text",
                "api_key": "secret-text-key",
            },
            "vision": {
                "enabled": True,
                "provider": "openai-compatible",
                "base_url": "https://vision.example/v1",
                "model": "vision-judge",
                "api_key": "secret-vision-key",
            },
        }
    )
    assert saved["text"]["has_api_key"] is True
    assert saved["vision"]["has_api_key"] is True
    assert "api_key" not in saved["text"]
    assert "api_key" not in saved["vision"]
    private = load_model_connections(include_secrets=True)
    assert private["text"]["api_key"] == "secret-text-key"
    assert private["vision"]["api_key"] == "secret-vision-key"
    registry = ModelRegistry().public()
    assert registry["assistant_language"]["enabled"] is True
    assert registry["assistant_language"]["source"] == "device-model-connection"
    assert registry["multimodal_audit"]["enabled"] is True
    assert registry["multimodal_audit"]["model"] == "vision-judge"
    assert "secret-text-key" not in json.dumps(registry)
    assert "secret-vision-key" not in json.dumps(registry)
    assert not (tmp_path / "project" / "output" / "model-secrets.json").exists()
    if os.name != "nt":
        mode = (tmp_path / "app-support" / "model-secrets.json").stat().st_mode & 0o777
        assert mode == 0o600


def test_vision_model_env_override_keeps_existing_local_semantics(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path / "app-support"))
    _clear_model_env(monkeypatch)
    save_runtime_settings({"local_vision_enabled": True, "local_vision_model": "default-local.gguf"})
    monkeypatch.setenv("MIRRORORDER_VISION_MODEL", "override-local.gguf")
    config = VisionProviderConfig.from_env()
    assert config.provider == "local"
    assert config.model == "override-local.gguf"
    assert config.is_local is True


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
    review = ReviewStore(config.output_dir / "review.json").load()
    assert review["placements"]["G1"]["script_segment_ids"] == ["S2"]


def test_enabled_local_vision_triggers_one_bounded_priority_audit(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path / "app-support"))
    _clear_model_env(monkeypatch)
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
    assert ":G1" in task["idempotency_key"]
    assert first["orchestration"]["last_action"]["results"][0]["tool"] == "run_priority_audit"

    assistant.cycle(trigger="poll", allow_actions=True)
    assert len(manager.submitted) == 1


def test_explicit_model_plan_does_not_stack_hidden_priority_audit(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path / "app-support"))
    _clear_model_env(monkeypatch)
    save_runtime_settings({"local_vision_enabled": True, "local_vision_model": "local-test.gguf"})
    config = _config(tmp_path)
    manager = FakeTaskManager()
    assistant = AssistantOrchestrator("ws", "demo", config, task_manager=manager)
    assistant.language = FakeLanguagePlan()
    payload = assistant.cycle(trigger="app", allow_actions=True, force_plan=True)
    assert [row["type"] for row in manager.submitted] == ["evidence_extract"]
    assert all(row["type"] != "audit" for row in manager.submitted)
    results = payload["orchestration"]["last_action"]["results"]
    assert [row["tool"] for row in results] == ["extract_visual_evidence", "noop"]


def test_mapping_change_makes_old_audit_non_current_without_changing_analysis(tmp_path: Path) -> None:
    config = _config(tmp_path)
    _save_current_audit(config)
    assistant = AssistantOrchestrator("ws", "demo", config)
    assert assistant._current_audit_groups() == {"G1"}

    ReviewStore(config.output_dir / "review.json").apply_action(
        {
            "action": "set_group_placement",
            "group_id": "G1",
            "episode_ids": [1],
            "script_segment_ids": ["S2"],
            "actor": "editor",
        }
    )
    assert _analysis_revision(config.output_dir) == AuditStore(config.output_dir).load()["analysis_revision"]
    assert assistant._current_audit_groups() == set()


def test_review_refresh_rebuilds_learning_cases_from_latest_human_truth(tmp_path: Path) -> None:
    config = _config(tmp_path)
    _save_current_audit(config)
    ReviewStore(config.output_dir / "review.json").apply_action(
        {
            "action": "set_group_placement",
            "group_id": "G1",
            "episode_ids": [1],
            "script_segment_ids": ["S2"],
            "actor": "editor",
        }
    )
    fake_service = SimpleNamespace(
        workspace=SimpleNamespace(workspace_id="ws"),
        tasks=FakeTaskManager(),
        project=lambda _project_id: SimpleNamespace(config=config),
    )
    _refresh_after_review(fake_service, "demo")
    rows = [
        json.loads(line)
        for line in (config.output_dir / "learning_cases.jsonl").read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert rows
    assert rows[0]["group_id"] == "G1"
    assert rows[0]["human_expected"]["script_segment_ids"] == ["S2"]
    assert rows[0]["matcher_prediction"]["conflicts_with_human"] is True


def test_bounded_evidence_and_identity_tools_submit_scoped_tasks(tmp_path: Path) -> None:
    config = _config(tmp_path)
    manager = FakeTaskManager()
    tools = AgentToolRegistry("ws", "demo", config, manager)
    evidence = tools.extract_visual_evidence(["G1"] * 30)
    identities = tools.index_unknown_identities(["G1"] * 30, kind="both")
    assert evidence["status"] == "submitted"
    assert identities["status"] == "submitted"
    assert manager.submitted[0]["type"] == "evidence_extract"
    assert manager.submitted[0]["targets"]["group_ids"] == ["G1"]
    assert manager.submitted[1]["type"] == "identity_index"
    assert manager.submitted[1]["targets"]["group_ids"] == ["G1"]
    assert manager.submitted[1]["targets"]["kind"] == "both"


def test_disabled_models_do_not_create_expensive_task(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path / "app-support"))
    _clear_model_env(monkeypatch)
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
    audit_runtime = (root / "src" / "script_organizer" / "audit_runtime.py").read_text(encoding="utf-8")
    orchestrator = (root / "src" / "script_organizer" / "assistant_orchestrator.py").read_text(encoding="utf-8")
    tools = (root / "src" / "script_organizer" / "agent_tools.py").read_text(encoding="utf-8")
    index = (root / "web" / "index.html").read_text(encoding="utf-8")
    release = (root / "web" / "startup_release.js").read_text(encoding="utf-8")
    control = (root / "web" / "assistant_control_ui.js").read_text(encoding="utf-8")
    css = (root / "web" / "assistant.css").read_text(encoding="utf-8")
    editorial = (root / "src" / "script_organizer" / "editorial_runtime.py").read_text(encoding="utf-8")

    assert "install_assistant_runtime" in editorial
    assert "assistant/models" not in runtime
    assert 'parts[4] == "assistant"' in runtime
    assert 'parts[5] == "models"' in runtime
    assert 'parts[5] == "message"' in runtime
    assert 'parts[5:] == ["assistant", "cycle"]' in runtime
    assert "_refresh_after_review" in runtime
    assert "write_learning_dataset" in runtime
    assert "self._local_only()" in runtime
    assert '"direct_review_write": False' in runtime
    assert '"messages"' not in runtime.split("def _safe_assistant", 1)[1].split("def install_assistant_runtime", 1)[0]
    for tool in (
        "run_priority_audit",
        "extract_visual_evidence",
        "index_unknown_identities",
        "collect_learning_cases",
        "noop",
    ):
        assert f'"{tool}"' in tools
    assert "review.json" not in "\n".join(
        line for line in tools.splitlines() if "write" in line.lower() or "save(" in line
    )
    assert "不得写review.json或editorial.json" in orchestrator
    assert "已人工确认的人物或声纹不得要求重复计算" in orchestrator
    assert "if allow_actions and plan is None" in orchestrator
    assert "_mapping_for_group" in orchestrator
    assert '"audit_split_freshness": True' in audit_runtime
    assert '"mapping_stale": True' in audit_runtime
    assert '"visual_current": True' in audit_runtime
    assert "_apply_shot_intelligence(take, row)" in audit_runtime
    assert '/assistant.css' in index
    assert '/assistant_control.css' in index
    assert "loadScript('/assistant_ui.js')" in release
    assert "loadScript('/assistant_control_ui.js')" in release
    assert release.index("loadScript('/assistant_ui.js')") < release.index("loadScript('/assistant_control_ui.js')")
    assert '/assistant/models' in control
    assert '/assistant/message' in control
    assert '/assistant/cycle' in control
    assert 'Agent API 已启用' in control
    assert '多模态模型地址' in control
    assert 'data:image/webp;base64,' in css
