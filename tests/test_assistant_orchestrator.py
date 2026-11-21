from __future__ import annotations

import io
import json
import os
import urllib.error
from http import HTTPStatus
from pathlib import Path
from types import SimpleNamespace

import pytest

from script_organizer import assistant_runtime, project_location_runtime, tasks, web_server
from script_organizer.assistant_context import resolve_question_context
from script_organizer.agent_tools import AgentToolRegistry
from script_organizer.assistant_orchestrator import AssistantOrchestrator
from script_organizer.assistant_runtime import _refresh_after_review
from script_organizer.assistant_store import AssistantStore
from script_organizer.audit_engine import _analysis_revision, _mapping_for_group
from script_organizer.audit_store import AuditStore
from script_organizer.automation_store import AutomationStore
from script_organizer.config import ProjectConfig
from script_organizer.device_runtime_settings import save_runtime_settings
from script_organizer.editorial_store import EditorialStore
from script_organizer.media_identity import DeviceMediaStore, media_id_for_path
from script_organizer.model_connections import load_model_connections, save_model_connections
from script_organizer.model_registry import AssistantLanguageModel, AssistantModelConfig, ModelRegistry
from script_organizer.models import Clip
from script_organizer.review_store import ReviewStore
from script_organizer.script_supervisor_store import ScriptSupervisorStore
from script_organizer.semantic_runtime import _parse_search_intent, answer_project_question
from script_organizer.semantic_store import SemanticStore
from script_organizer.transcript import TranscriptStore
from script_organizer.web_server import ProjectService
from script_organizer.workspace_db import WorkspaceDatabase
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


def test_question_uses_the_selected_occurrence_even_without_query_keywords(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device"))
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path / "state"))
    project = ProjectService("demo", _config(tmp_path))
    data = SemanticStore(WorkspaceDatabase("ws"))
    documents = [
        {"document_id": clip, "source": "speech", "clip_id": clip, "group_id": "G1",
         "text": text, "content_fingerprint": clip}
        for clip, text in (("CA", "走到门前"), ("CB", "转身离开"))
    ]
    data.replace_documents("demo", "speech", documents)
    data.replace_documents("demo", "visual", [
        {"document_id": "group-view", "source": "visual", "clip_id": "CA", "group_id": "G1",
         "text": "多机位全组画面", "metadata": {"member_count": 2}, "content_fingerprint": "group-view"}
    ])
    assistant = AssistantOrchestrator("ws", "demo", project.config)
    assistant.language = SimpleNamespace(enabled=False)
    for clip in ("CA", "CB"):
        raw = {"project_id": "demo", "page": "watch", "group_id": "G1", "clip_id": clip}
        context = resolve_question_context(project, [], raw)
        reply = answer_project_question(assistant, "查这条", context=context)
        assert [row["clip_id"] for row in reply["retrieval"]["results"]] == [clip]
        assert reply["context"]["label"].startswith(clip[-1] + "001.mov")
        assert reply["assistant"]["messages"][-1]["context"] == reply["context"]
    assert assistant.store.load()["messages"][1]["context"]["selection"]["clip_id"] == "CA"
    take = resolve_question_context(project, [], {"project_id": "demo", "page": "watch", "group_id": "G1"})
    take_rows = answer_project_question(assistant, "查这组", context=take)["retrieval"]["results"]
    assert any(row["source_label"] == "Take 画面" and row["snippet"] == "多机位全组画面" for row in take_rows)
    for bad in ({"project_id": "other"}, {"clip_id": "absent"}, {"group_id": "unknown"}):
        with pytest.raises(ValueError):
            resolve_question_context(project, [], {**raw, **bad})


def test_cancelled_sync_can_answer_without_model_index_or_new_tasks(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device"))
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path / "state"))
    project = ProjectService("demo", _config(tmp_path))
    manager = FakeTaskManager()
    task = {"task_id": "cancelled-sync", "type": "multicam_sync", "status": "cancelled",
            "stage": "matching", "message": "已取消", "error": "/private/device/source"}
    context = resolve_question_context(project, [task], {"project_id": "demo", "page": "sync-task"})
    assistant = AssistantOrchestrator("ws", "demo", project.config, task_manager=manager)
    assistant.language = SimpleNamespace(enabled=True)  # inference would fail this test
    reply = answer_project_question(assistant, "为什么还不能交？", context=context)
    assert "已取消" in reply["answer"] and "matching" in reply["answer"]
    assert reply["diagnosis"]["destination"] == "sync-task"
    assert "/private/" not in json.dumps(reply)
    assert reply["context"]["selection"] == {} and not manager.submitted


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
    runtime_stack = (root / "src" / "script_organizer" / "runtime_stack.py").read_text(encoding="utf-8")

    assert "install_editorial_runtime" in editorial
    assert runtime_stack.index("install_assistant_runtime()") < runtime_stack.index("install_semantic_runtime()")
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


def test_persisted_assistant_drops_device_model_runtime_paths(tmp_path: Path) -> None:
    store = AssistantStore(tmp_path)
    saved = store.save(
        {
            "orchestration": {
                "models": {
                    "vision": {
                        "runtime": {
                            "cache_dir": "/Users/operator/Library/Application Support/MirrorOrder/models"
                        }
                    }
                }
            }
        }
    )

    assert "models" not in saved["orchestration"]
    persisted = (tmp_path / "assistant.json").read_text(encoding="utf-8")
    assert "/Users/operator" not in persisted


@pytest.fixture
def question_assistant(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device"))
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path / "state"))
    _clear_model_env(monkeypatch)
    return AssistantOrchestrator("ws", "demo", _config(tmp_path), task_manager=FakeTaskManager())


@pytest.mark.parametrize("method", [AssistantOrchestrator.answer, answer_project_question])
def test_follow_up_passes_only_the_last_six_compact_messages(question_assistant, method):
    assistant = question_assistant
    prompts = []

    def complete_answer(*, context, **_kwargs):
        prompts.append(context)
        return "请先核对 B 机。"

    assistant.language = SimpleNamespace(enabled=True, complete_answer=complete_answer)
    for number in range(6):
        assistant.store.append_message(
            "user", f"旧消息 {number}" + "字" * 510, context={"label": "场记" * 65, "selection": {"group_id": "G1"}},
        )
    reply = method(assistant, "先核对哪台机位？")
    follow_up = method(assistant, "为什么？")
    assert len(prompts[0]["conversation_history"]) == 6
    history = prompts[1]["conversation_history"]
    assert len(history) == 6 and history[0]["text"].startswith("旧消息 2")
    assert len(history[0]["text"]) == 500 and len(history[0]["context_label"]) == 120
    assert set(history[0]) == {"role", "text", "context_label"}
    assert history[-2:] == [
        {"role": "user", "text": "先核对哪台机位？", "context_label": ""},
        {"role": "assistant", "text": "请先核对 B 机。", "context_label": ""},
    ]
    assert follow_up["answer_mode"] == reply["answer_mode"] == "llm"
    assert follow_up["model_info"]["fallback_reason"] == ""
    assert follow_up["assistant"]["messages"][-1]["answer_mode"] == "llm"


@pytest.mark.parametrize("provider", ["openai-compatible", "gemini"])
def test_plain_model_answer_and_strict_json_are_separate(provider, monkeypatch):
    model = AssistantLanguageModel(AssistantModelConfig(provider, "https://model.example", "demo-key", "demo-model"))

    def respond(content):
        envelope = {"output_text": content} if provider == "gemini" else {"choices": [{"message": {"content": content}}]}
        monkeypatch.setattr("urllib.request.urlopen", lambda *_args, **_kwargs: io.BytesIO(json.dumps(envelope).encode()))

    call = {"system": "回答问题", "context": {"question": "可以核对了吗？"}}
    respond("```text\n请先核对 B 机。\n```")
    assert model.complete_answer(**call) == "请先核对 B 机。"
    assert model.last_status == {"mode": "llm", "reason": ""}
    assert model.complete_json(**call) is None
    assert model.last_status == {"mode": "error", "reason": "invalid_json"}
    respond('{"answer": "  可以核对。 "}')
    assert model.complete_answer(**call) == "可以核对。"
    assert model.last_status == {"mode": "llm", "reason": ""}
    for content in ("<!DOCTYPE html>bad gateway", "<html>error", "Traceback (most recent call last):"):
        respond(content)
        assert model.complete_answer(**call) is None
        assert model.last_status == {"mode": "error", "reason": "invalid_response"}
    respond(" ")
    assert model.complete_answer(**call) is None
    assert model.last_status == {"mode": "error", "reason": "empty_response"}


@pytest.mark.parametrize(
    ("provider", "error", "reason"),
    [
        ("openai-compatible", urllib.error.HTTPError("https://model.example", 401, "demo-key", {}, None), "http_401"),
        ("gemini", urllib.error.HTTPError("https://model.example", 429, "/private/demo-key", {}, None), "http_429"),
        ("openai-compatible", TimeoutError("/Users/operator/demo-key"), "timeout"),
        ("gemini", urllib.error.URLError(TimeoutError("demo-key")), "timeout"),
        ("gemini", urllib.error.URLError("/Volumes/source/demo-key"), "network_error"),
        ("openai-compatible", OSError("C:\\source\\demo-key"), "network_error"),
    ],
)
def test_model_status_exposes_only_reason_codes(provider, error, reason, monkeypatch):
    model = AssistantLanguageModel(AssistantModelConfig(provider, "https://model.example", "demo-key", "demo-model"))

    def fail(*_args, **_kwargs):
        raise error

    monkeypatch.setattr("urllib.request.urlopen", fail)
    assert model.complete_answer(system="回答", context={}) is None
    assert model.last_status == {"mode": "error", "reason": reason}


def test_disabled_and_undownloaded_models_have_distinct_status(monkeypatch):
    model = AssistantLanguageModel(AssistantModelConfig())
    assert model.complete_answer(system="回答", context={}) is None
    assert model.last_status == {"mode": "unconfigured", "reason": "not_configured"}
    local = AssistantLanguageModel(AssistantModelConfig(provider="local", model="local.gguf"))
    monkeypatch.setattr(
        "script_organizer.model_registry.LocalVisionRuntime",
        lambda _config: SimpleNamespace(model_downloaded=lambda: False),
    )
    assert local.complete_json(system="规划", context={}) is None
    assert local.last_status == {"mode": "local_not_downloaded", "reason": "local_model_not_downloaded"}


def test_selected_take_adds_current_audit_and_read_only_human_facts(question_assistant, monkeypatch):
    assistant = question_assistant
    output = assistant.config.output_dir
    review = ReviewStore(output / "review.json")
    review.apply_actions([
        {"action": "set_group_placement", "group_id": "G1", "script_segment_ids": ["S2"], "actor": "editor"},
        {"action": "set_group_exclusion", "group_id": "G1", "actor": "editor", "source_surface": "golden-slate"},
    ])
    editorial = EditorialStore(output)
    editorial.apply_decision({
        "target_kind": "group", "group_id": "G1", "state": "keep", "actor": "editor", "expected_revision": 0,
    })
    before = {store.path: store.path.read_bytes() for store in (review, editorial)}
    matches_path = output / "matches.json"
    matches = json.loads(matches_path.read_text())
    candidates = matches["groups"]["G1"]["candidates"]
    candidates[0]["evidence"] = ["参照 /private/device/original.mov"]
    candidates[0]["media_path"] = "/Volumes/source/original.mov"
    candidates.extend([{"candidate_id": "C3"}, {"candidate_id": "C4"}])
    matches_path.write_text(json.dumps(matches))
    _save_current_audit(assistant.config)
    calls = []
    inspect_take = assistant.tools.inspect_take

    def inspect(group_id):
        calls.append(group_id)
        return inspect_take(group_id)

    monkeypatch.setattr(assistant.tools, "inspect_take", inspect)
    prompts = []

    def complete_json(*, context, **_kwargs):
        prompts.append(context)
        return {"answer": "人工备注和候选都已列出。"}

    assistant.language = SimpleNamespace(enabled=True, complete_json=complete_json)
    project = ProjectService("demo", assistant.config)
    context = resolve_question_context(project, [], {"project_id": "demo", "page": "watch", "group_id": "G1"})
    reply = answer_project_question(assistant, "这一组怎么看？", context=context)
    take = prompts[0]["selected_take"]
    assert calls == ["G1"]
    assert take["cameras"] == ["A", "B"] and take["duration"] == 4.0
    assert [row["candidate_id"] for row in take["candidates"]] == ["C1", "C2", "C3"]
    assert "media_path" not in take["candidates"][0]
    assert take["automatic"]["status"] == "needs_review"
    assert take["audit"]["judge"]["verdict"] == "agree"
    assert take["audit"]["issues"] == []
    assert take["audit"]["shot_intelligence"]["angles"]["CA"]["shot_type"] == "closeup"
    assert take["review"]["placement"]["script_segment_ids"] == ["S2"]
    assert take["review"]["exclusion"]["source_surface"] == "golden-slate"
    assert take["editorial_decision"]["state"] == "keep"
    assert "/private/" not in json.dumps(prompts[0]) and "/Volumes/" not in json.dumps(prompts[0])
    assert reply["answer_mode"] == "llm" and not assistant.task_manager.submitted
    assert all(path.read_bytes() == content for path, content in before.items())


def test_message_evidence_diagnosis_and_clear_preserve_briefing(tmp_path):
    store = AssistantStore(tmp_path)
    briefing = {
        "items": [{"key": "mapping:G1"}], "summary": "两组待核对", "source_fingerprint": "snapshot",
        "orchestration": {"last_trigger": "review", "last_action": {"tool": "noop"}},
    }
    store.save(briefing)
    evidence = [
        {
            "document_id": f"evidence-{index}", "group_id": "G1", "source": "speech",
            "start": 1.0, "end": 2.0, "snippet": "实拍 /Users/operator/raw.mov " + "字" * 330,
            "score": 0.5,
            "metadata": {
                "file_name": "C:\\source\\A001.mov", "record_id": "R1", "time_basis": "group", "camera": "A",
                "api_key": "discarded-key", "media_path": "/Volumes/source/A001.mov",
            },
        }
        for index in range(8)
    ]
    saved = store.append_message(
        "assistant", "检查 /private/device 原片", context={"label": "A 机", "base_url": "https://model.example"},
        evidence=evidence, diagnosis={
            "summary": "已取消 /private/device C:\\source\\file，已经停止", "destination": "sync-task", "other": "drop",
        }, answer_mode="diagnosis",
    )
    payload = json.loads(store.path.read_text())
    assert saved == payload == store.load()
    message = payload["messages"][-1]
    assert message["diagnosis"]["destination"] == "sync-task"
    assert "已取消" in message["diagnosis"]["summary"] and "已经停止" in message["diagnosis"]["summary"]
    assert set(message["diagnosis"]) == {"summary", "destination"}
    assert all(separator not in message["diagnosis"]["summary"] for separator in ("/", "\\"))
    assert message["answer_mode"] == "diagnosis"
    assert len(message["evidence"]) == 6
    first = message["evidence"][0]
    assert len(first["snippet"]) == 320
    assert "score" not in first and first["start"] == 1.0 and first["end"] == 2.0
    assert first["metadata"] == {"file_name": "A001.mov", "record_id": "R1", "time_basis": "group", "camera": "A"}
    for private in ("/Users/", "/private/", "/Volumes/", "C:\\", "discarded-key", "https://model.example"):
        assert private not in store.path.read_text()
    cleared = store.clear_messages()
    assert cleared["messages"] == [] and cleared["revision"] == saved["revision"] + 1
    assert all(cleared[key] == value for key, value in briefing.items())
    assert store.load() == cleared


def test_empty_semantic_index_uses_project_facts_only_for_whole_project(question_assistant):
    assistant = question_assistant
    assistant.language = SimpleNamespace(enabled=False)
    output = assistant.config.output_dir
    index_path = output / "material_index.json"
    material = json.loads(index_path.read_text())
    material["clips"] = [{"clip_id": "CA", "file_name": "/Volumes/device/A001.mov", "camera": "A"}]
    index_path.write_text(json.dumps(material))
    ScriptSupervisorStore(output).apply({
        "group_id": "G1", "expected_revision": 0, "actor": "editor", "entry": {"scene": "酒杯特写"},
    })
    query = "项目里找 A001.mov，酒杯，还有李雪的台词"
    selected = answer_project_question(assistant, query, context={"selection": {"group_id": "G1"}, "label": "Take G1"})
    assert selected["retrieval"]["results"] == [] and selected["suggested_scope_switch"] is True
    whole = answer_project_question(assistant, query, context={"selection": {}, "label": "全项目"})
    assert "suggested_scope_switch" not in whole
    assert whole["retrieval"]["summary"]["returned"] == 3
    rows = {row["source"]: row for row in whole["retrieval"]["results"]}
    assert rows["file"]["source_label"] == "文件名" and rows["file"]["snippet"] == "A001.mov"
    assert rows["slate"]["source_label"] == "场记" and rows["slate"]["snippet"] == "酒杯特写"
    assert rows["script"]["source_label"] == "剧本" and rows["script"]["metadata"] == {"segment_id": "S2"}
    assert [row["source"] for row in whole["assistant"]["messages"][-1]["evidence"]] == ["file", "slate", "script"]
    assert whole["answer_mode"] == "deterministic" and whole["model_info"]["fallback_reason"] == "not_configured"
    assert not assistant.task_manager.submitted and "/Volumes/" not in json.dumps(whole)


def test_selected_sync_diagnosis_skips_model_and_search(question_assistant, monkeypatch):
    assistant = question_assistant
    assistant.language = SimpleNamespace(enabled=True)

    def unexpected(*_args, **_kwargs):
        pytest.fail("同步诊断不应打开语义索引")

    monkeypatch.setattr("script_organizer.semantic_runtime.SemanticSearcher", unexpected)
    context = {
        "page": "sync-inspect", "selection": {"clip_id": "CA"},
        "diagnosis": {"summary": "同步已取消，最近错误 /private/source", "destination": "sync-task"},
    }
    reply = answer_project_question(assistant, "这条失败了吗？", context=context)
    assert "同步已取消" in reply["answer"] and "/private/" not in json.dumps(reply)
    assert reply["answer_mode"] == "diagnosis" and "suggested_scope_switch" not in reply
    assert reply["assistant"]["messages"][-1]["diagnosis"] == reply["diagnosis"]


def test_answer_metadata_and_payload_redact_private_model_values(question_assistant, monkeypatch):
    monkeypatch.setenv("MIRRORORDER_ASSISTANT_MODEL_PROVIDER", "openai-compatible")
    monkeypatch.setenv("MIRRORORDER_ASSISTANT_MODEL_BASE_URL", "https://model.example/v1")
    monkeypatch.setenv("MIRRORORDER_ASSISTANT_MODEL_NAME", "/Users/operator/model.gguf")
    monkeypatch.setenv("MIRRORORDER_ASSISTANT_MODEL_API_KEY", "sensitive-demo-value")
    assistant = AssistantOrchestrator("ws", "demo", question_assistant.config)
    assistant.language = SimpleNamespace(
        enabled=True, complete_answer=lambda **_kwargs: None, last_status={"mode": "error", "reason": "http_429"},
    )
    fallback = assistant.answer("需要核对什么？")
    assert fallback["answer_mode"] == "deterministic" and fallback["model_info"]["fallback_reason"] == "http_429"
    assistant.language.complete_answer = lambda **_kwargs: "场记见/private/input，sensitive-demo-value"
    assistant.language.last_status = {"mode": "llm", "reason": ""}
    reply = assistant.answer("原片在 C:\\source\\clip.mov？ sensitive-demo-value")
    assert reply["answer_mode"] == "llm" and reply["model_info"]["fallback_reason"] == ""
    assert reply["model_info"]["enabled"] and reply["model_info"]["provider"] == "openai-compatible"
    assert "model_info" not in reply["assistant"]
    for private in ("/Users/", "/private/", "clip.mov", "sensitive-demo-value", "https://model.example"):
        assert private not in json.dumps(reply) and private not in assistant.store.path.read_text()


def test_clear_through_local_only_runtime_handler(question_assistant, monkeypatch, tmp_path):
    assistant = question_assistant
    assistant.store.save({"summary": "看片待核对", "items": [{"key": "take:G1"}]})
    assistant.store.append_message("user", "查这组")
    previous = assistant.store.append_message(
        "assistant", "找到 B 机特写",
        evidence=[{
            "clip_id": "CB", "source": "speech", "snippet": "你回来了 /private/original", "start": 1.25, "end": 2.75,
            "metadata": {
                "file_name": "C:\\source\\B001.mov", "camera": "B", "shot_type": "closeup", "shot_type_label": "特写",
                "take_label": "Take 1 · 12场1镜", "time_basis": "take_relative", "slate_status": "usable",
                "segment_id": "relative\\bad", "api_key": "discarded-key",
            },
        }],
        suggested_actions=[
            {"action": "submit_task", "task_type": "evidence_extract", "label": "生成画面证据",
             "description": "缓存 /Volumes/source/movie.mov", "targets": {
                 "group_ids": ["G1", "relative/path", "bad\\id", *[f"G{n}" for n in range(2, 16)]],
                 "path": "/Users/operator/raw",
             }},
            {"action": "open_settings", "label": "设置视觉模型"},
            {"action": "submit_task", "task_type": "multicam_sync", "label": "禁止提议的任务"},
            {"action": "reject", "label": "禁止更改选片"},
        ],
    )
    message = previous["messages"][-1]
    assert message["evidence"][0]["metadata"] == {
        "file_name": "B001.mov", "camera": "B", "shot_type": "closeup", "shot_type_label": "特写",
        "take_label": "Take 1 · 12场1镜", "time_basis": "take_relative", "slate_status": "usable",
    }
    actions = message["suggested_actions"]
    assert len(actions) == 2
    assert actions[0]["targets"] == {"group_ids": [f"G{n}" for n in range(1, 13)]}
    assert actions[1] == {"action": "open_settings", "label": "设置视觉模型"}
    assert assistant.store.load() == previous
    for value in ("/private/", "/Volumes/", "/Users/", "relative/path", "relative\\", "bad\\", "discarded-key"):
        assert value not in assistant.store.path.read_text()
    service = SimpleNamespace(project=lambda _project_id: SimpleNamespace(config=assistant.config))
    # Restore wrappers after exercising the actual runtime entry point.
    for obj, name in (
        (assistant_runtime, "_INSTALLED"), (web_server, "make_handler"),
        (web_server.ProjectService, "state"), (web_server.WorkspaceService, "capabilities"),
        (tasks.TaskManager, "_update"),
    ):
        monkeypatch.setattr(obj, name, getattr(obj, name))
    assistant_runtime.install_assistant_runtime()
    handler_class = web_server.make_handler(service, tmp_path)
    handler = object.__new__(handler_class)
    handler.path = "/api/v1/projects/demo/assistant/clear"
    responses = []
    handler._send_json = lambda payload, status=HTTPStatus.OK: responses.append((status, payload))
    handler.client_address = ("192.0.2.1", 4000)
    handler.do_POST()
    assert responses[-1][0] == HTTPStatus.FORBIDDEN
    assert assistant.store.load() == previous
    handler.client_address = ("127.0.0.1", 4000)
    handler.do_POST()
    status, cleared = responses[-1]
    assert status == HTTPStatus.OK
    assert cleared["messages"] == [] and cleared["revision"] == previous["revision"] + 1
    assert cleared["items"] == previous["items"] and cleared["summary"] == previous["summary"]
    assert assistant.store.load() == cleared


@pytest.fixture
def media_location_project(tmp_path, monkeypatch):
    monkeypatch.setenv("MIRRORORDER_DEVICE_STATE_DIR", str(tmp_path / "device"))
    config = _config(tmp_path)
    project = ProjectService("demo", config)
    project.workspace_id = "ws"
    index_path = config.output_dir / "material_index.json"
    index = json.loads(index_path.read_text())
    members = index["groups"][0]["members"]
    source = tmp_path / "originals"
    source.mkdir()
    files = {}
    for member in members:
        original = source / member["name"]
        original.write_bytes(member["clip_id"].encode())
        member["media_id"] = media_id_for_path(original)
        files[member["clip_id"]] = (member["media_id"], original.resolve())
    index["clips"] = members.copy()
    DeviceMediaStore().scan("ws", "demo", index, [str(source)])
    index["clips"] = members[:1]
    index_path.write_text(json.dumps(index))
    service = SimpleNamespace(workspace=SimpleNamespace(workspace_id="ws"), project=lambda _: project)
    return service, files


@pytest.mark.parametrize(("kind", "clip_id"), [
    ("clip", "CA"), ("group_clip", "CB"), ("media", "CA"), ("media", "CB"), ("group", "CA"),
])
def test_project_media_local_location_resolves_original(media_location_project, kind, clip_id):
    service, files = media_location_project
    media_id, original = files[clip_id]
    targets = {
        "clip": {"clip_id": clip_id},
        "group_clip": {"clip_id": clip_id, "group_id": "G1"},
        "media": {"media_id": media_id},
        "group": {"group_id": "G1"},
    }

    payload = project_location_runtime.project_media_local_location(service, "demo", **targets[kind])

    assert payload == {
        "contract": "project_media_location.v1",
        "project_id": "demo",
        "clip_id": clip_id,
        "media_id": media_id,
        "file_path": str(original),
        "exists": True,
        "device_paths_exposed": True,
        "scope": "device_local_response",
    }


def test_project_media_local_location_falls_back_to_a_device_binding(media_location_project, monkeypatch):
    service, files = media_location_project
    project = service.project("demo")
    monkeypatch.setattr(project, "resolve_media_path", lambda _: "")
    media_id, original = files["CB"]
    index_path = project.config.output_dir / "material_index.json"
    index_path.write_text('{"clips": [], "groups": []}')

    payload = project_location_runtime.project_media_local_location(service, "demo", media_id=media_id)

    assert payload["clip_id"] == "" and payload["media_id"] == media_id
    assert payload["exists"] is True and payload["file_path"] == str(original)


def test_project_media_local_location_rejects_a_registry_path_outside_the_project(tmp_path):
    registry = SimpleNamespace(
        config=SimpleNamespace(config_path=tmp_path / "workspace.toml", registry_path=tmp_path / "projects" / "registry.json"),
        get=lambda _: {"config_path": "another-workspace/demo/project.toml"},
    )
    current = SimpleNamespace(registry=registry, project=lambda _: pytest.fail("project ownership must be checked first"))

    with pytest.raises(project_location_runtime.UnsafeProjectLocation):
        project_location_runtime.project_media_local_location(SimpleNamespace(current=current), "demo", clip_id="CA")


@pytest.mark.parametrize(("client_ip", "gateway", "body", "expected"), [
    ("127.0.0.1", False, b'{"clip_id":"CA"}', HTTPStatus.OK),
    ("127.0.0.1", False, b'{"clip_id":" "}', HTTPStatus.BAD_REQUEST),
    ("127.0.0.1", False, b'{"group_id":"missing"}', HTTPStatus.NOT_FOUND),
    ("192.0.2.1", False, b'{', HTTPStatus.FORBIDDEN),
    ("192.0.2.1", True, b'{', HTTPStatus.FORBIDDEN),
])
def test_media_location_http_is_loopback_only(media_location_project, monkeypatch, tmp_path, client_ip, gateway, body, expected):
    service, files = media_location_project
    output = service.project("demo").config.output_dir
    artifacts = [output / name for name in ("assistant.json", "review.json", "editorial.json")]
    before = [path.read_bytes() if path.exists() else None for path in artifacts]
    monkeypatch.setattr(project_location_runtime, "_INSTALLED", project_location_runtime._INSTALLED)
    monkeypatch.setattr(web_server, "make_handler", web_server.make_handler)
    project_location_runtime.install_project_location_runtime()
    path = "/api/v1/projects/demo/media-location"
    if gateway:
        paired = SimpleNamespace(
            current=service,
            security=SimpleNamespace(allow=lambda *_: True),
            select=lambda _: service,
        )
        handler_class = web_server.make_gateway_handler(paired, tmp_path)
        path = "/api/v1/workspaces/ws/projects/demo/media-location"
    else:
        handler_class = web_server.make_handler(service, tmp_path)
    headers = f"POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {len(body)}\r\n\r\n"
    handler = object.__new__(handler_class)
    handler.client_address = (client_ip, 4000)
    handler.rfile = io.BytesIO(headers.encode() + body)
    handler.wfile = io.BytesIO()

    handler.handle_one_request()

    response_headers, _, response_body = handler.wfile.getvalue().partition(b"\r\n\r\n")
    assert int(response_headers.split(b" ", 2)[1]) == expected
    payload = json.loads(response_body)
    assert b"Cache-Control: no-store" in response_headers
    if expected == HTTPStatus.OK:
        assert payload["scope"] == "device_local_response" and payload["device_paths_exposed"] is True
        assert payload["file_path"] == str(files["CA"][1])
    else:
        assert "file_path" not in payload
    assert [path.read_bytes() if path.exists() else None for path in artifacts] == before


@pytest.mark.parametrize("source", ["audit", "slate"])
def test_offline_search_finds_camera_b_closeup_without_semantic_index(question_assistant, source):
    assistant = question_assistant
    assistant.language = SimpleNamespace(enabled=False)
    output = assistant.config.output_dir
    path = output / "material_index.json"
    index = json.loads(path.read_text())
    index["groups"][0]["members"][1]["media_id"] = "media-b"
    path.write_text(json.dumps(index))
    if source == "audit":
        _save_current_audit(assistant.config)
        audit = AuditStore(output)
        payload = audit.load()
        angles = payload["groups"]["G1"]["shot_intelligence"]["angles"]
        angles["CB"] = {**angles["CA"], "clip_id": "CB", "camera": "B", "summary": "人物推开门"}
        audit.save(payload)
    else:
        ScriptSupervisorStore(output).apply({
            "group_id": "G1", "expected_revision": 0, "actor": "editor",
            "entry": {"scene": "12", "shot": "1", "take_number": 1,
                      "angles": {"CB": {"shot_type": "closeup", "note": "人物推开门"}}},
        })
    reply = assistant.answer("帮我找B机的特写片段")
    rows = reply["retrieval"]["results"]
    assert [(row["group_id"], row["clip_id"], row["media_id"], row["source"]) for row in rows] == [
        ("G1", "CB", "media-b", "visual"),
    ]
    assert rows[0]["metadata"]["camera"] == "B"
    assert rows[0]["metadata"]["file_name"] == "B001.mov"
    assert rows[0]["metadata"]["shot_type_label"] == "特写"
    assert reply["answer_mode"] == "deterministic" and "B 机 · 特写" in reply["answer"]
    assert reply["suggested_actions"] == [] and not assistant.task_manager.submitted
    assert not WorkspaceDatabase("ws", read_only=True).path.exists()


def _cache_dialogue(assistant, clip_id, name):
    row = Clip(clip_id, name, "B", "", 0, 4, 4, False, media_id=f"media-{clip_id}")
    TranscriptStore(assistant.config.transcript_dir).write(row, "你回来了。", [
        {"start": 1.23456, "end": 2.98765, "text": " 你回来了。 "},
    ])
    return row.media_id


@pytest.mark.parametrize("left,right", [("“", "”"), ('"', '"'), ("「", "」"), ("‘", "’"), ("'", "'")])
def test_search_intent_preserves_quoted_dialogue(left, right):
    intent = _parse_search_intent(f"小镜请问查一下B机位说{left}你说的特写呢{right}那句对白")
    assert intent.quoted_phrases == ("你说的特写呢",)
    assert intent.cleaned_query == "你说的特写呢" and intent.tokens == intent.quoted_phrases
    assert intent.camera == "B" and intent.wants_dialogue and not intent.shot_types
    assert _parse_search_intent("帮我找我的世界的片段").tokens == ("我的世界",)
    assert _parse_search_intent("查找镜头感强的表情片段").tokens == ("镜头感强的表情",)
    assert _parse_search_intent("找一下说你回来了那句台词").tokens == ("你回来了",)


def test_search_matches_exact_cached_dialogue_and_fuses_semantic_occurrences(question_assistant):
    assistant = question_assistant
    assistant.language = SimpleNamespace(enabled=False)
    path = assistant.config.output_dir / "material_index.json"
    material = json.loads(path.read_text())
    material["groups"][0]["members"][1]["media_id"] = _cache_dialogue(assistant, "CB", "B001.mov")
    material["groups"][0]["members"].append({
        "clip_id": "CB2", "name": "B002.mov", "camera": "B", "duration": 4.0,
        "media_id": _cache_dialogue(assistant, "CB2", "B002.mov"),
    })
    path.write_text(json.dumps(material))
    _save_current_audit(assistant.config)
    audit = AuditStore(assistant.config.output_dir)
    payload = audit.load()
    angles = payload["groups"]["G1"]["shot_intelligence"]["angles"]
    angles["CB"] = {"clip_id": "CB", "camera": "B", "shot_type": "closeup"}
    angles["CB2"] = {"clip_id": "CB2", "camera": "B", "shot_type": "wide"}
    audit.save(payload)

    first = assistant.answer("找一下说‘你回来了’那句台词")
    speech = [row for row in first["retrieval"]["results"] if row["source"] == "speech"]
    assert len(speech) == 2
    for row in speech:
        assert (row["start"], row["end"]) == (1.23456, 2.98765)
        assert row["metadata"]["time_basis"] == "take_relative"
        assert row["source_label"] == "对白" and row["snippet"] == "你回来了。"
    assert not WorkspaceDatabase("ws", read_only=True).path.exists()

    semantic = SemanticStore(WorkspaceDatabase("ws"))
    semantic.replace_documents("demo", "speech", [
        {"document_id": f"indexed-{clip}", "source": "speech", "clip_id": clip, "group_id": "G1",
         "text": "你回来了。", "start": 1.235, "end": 2.988, "content_fingerprint": clip}
        for clip in ("CB2", "CB")
    ])
    reply = assistant.answer("帮我找B机的特写，说‘你回来了’那句台词")
    rows = reply["retrieval"]["results"]
    assert [(row["clip_id"], row["source"]) for row in rows if row["source"] == "speech"] == [
        ("CB", "speech"), ("CB2", "speech"),
    ]
    assert rows[0]["clip_id"] == "CB" and rows[0]["source"] == "speech"
    assert (rows[0]["start"], rows[0]["end"]) == (1.23456, 2.98765)
    assert rows[0]["metadata"]["shot_type_label"] == "特写"
    assert reply["retrieval"]["summary"]["returned"] == len(rows)
    assert "1.235–2.988 秒" in reply["answer"]
    assert reply["assistant"]["messages"][-1]["evidence"][0]["metadata"] == rows[0]["metadata"]
    assert not reply["suggested_actions"] and not assistant.task_manager.submitted


def test_project_steward_reads_only_saved_production_facts(question_assistant, monkeypatch):
    assistant = question_assistant
    assistant.language = SimpleNamespace(enabled=False)
    output = assistant.config.output_dir
    matches_path = output / "matches.json"
    matches = json.loads(matches_path.read_text())
    matches["script_gaps"] = [{"gap_id": "gap1", "segment_ids": ["S2"], "episode": 1, "scene_id": "E01-12"}]
    matches_path.write_text(json.dumps(matches))
    review = ReviewStore(output / "review.json")
    review.apply_actions([
        {"action": "set_group_placement", "group_id": "G1", "script_segment_ids": ["S2"], "actor": "editor"},
    ])
    editorial = EditorialStore(output)
    editorial.apply_decision({
        "target_kind": "group", "group_id": "G1", "state": "best", "actor": "editor", "expected_revision": 0,
    })
    editorial.apply_opinion({
        "target_kind": "assignment", "group_id": "G1", "segment_id": "S2", "state": "keep", "actor": "teammate",
    })
    supervisor = ScriptSupervisorStore(output)
    supervisor.apply({
        "group_id": "G1", "actor": "slate", "expected_revision": supervisor.load()["revision"],
        "entry": {"scene": "12", "shot": "1", "take_number": 1, "status": "ng", "note": "失焦 /private/source"},
    })
    supervisor.apply_record({
        "record_id": "insert", "actor": "slate", "expected_revision": supervisor.load()["revision"],
        "record": {"status": "partial", "note": "留前半段", "usable_range": {"start": 1.0, "end": 2.5}},
    })
    database = WorkspaceDatabase("ws")
    database.sync_project_summary("demo")
    database.upsert_identity("demo", identity_id="face", kind="face", role_name="李雪", label="演员甲",
                             metadata={"human_confirmed": True})
    database.upsert_identity("demo", identity_id="voice", kind="speaker", label="候选声纹")

    task_path = output / "tasks.json"
    task_path.write_text(json.dumps({"tasks": [
        {"task_id": "old-host", "type": "audit", "status": "interrupted", "runner_id": "old"},
        {"task_id": "t1", "type": "transcribe", "status": "running", "stage": "asr",
         "message": "正在转写", "runner_id": "another-host"},
        {"task_id": "t2", "type": "audit", "status": "failed", "stage": "error",
         "message": "错误 C:\\private\\input", "error": "/Users/operator/raw"},
    ]}))
    manager = tasks.TaskManager(lambda _: assistant.config, workspace_id="ws")
    monkeypatch.setattr(manager, "submit", lambda *_a, **_k: pytest.fail("问答不应提交任务"))
    monkeypatch.setattr(assistant.tools, "task_manager", manager)
    paths = (task_path, review.path, editorial.path, supervisor.path, database.path)
    before = {path: path.read_bytes() for path in paths}

    reply = assistant.answer("项目现在进度怎么样，有哪些缺口和NG？")
    steward = reply["project_steward"]
    assert steward["project"]["is_media_directory"] is True
    assert steward["script_gaps"]["count"] == 1
    assert steward["script_gaps"]["samples"][0] == {
        "gap_id": "gap1", "segment_id": "S2", "episode": 1, "scene_id": "E01-12",
        "scene": "", "speaker": "李雪", "text": "你回来了",
    }
    assert steward["review"] == {"mapped": 1, "unmapped": 0, "excluded": 0, "human_conflicts": 1}
    assert steward["editorial"] == {"best": 1, "keep": 0, "reject": 0, "undecided": 0, "pending_team_opinions": 1}
    assert steward["slate"]["ng"] == steward["slate"]["partial"] == 1
    assert steward["slate"]["with_notes"] == 2
    assert steward["slate"]["highlights"][1]["usable_range"] == {"start": 1.0, "end": 2.5}
    assert steward["identities"] == {"confirmed": [{"role_name": "李雪", "label": "演员甲"}], "unconfirmed_count": 1}
    assert steward["tasks"]["active"] == [
        {"task_id": "t1", "type": "transcribe", "status": "running", "stage": "asr", "message": "正在转写"},
    ]
    assert steward["tasks"]["failed"] == [{"task_id": "t2", "type": "audit", "status": "failed", "stage": "error"}]
    assert "项目总览" in reply["answer"] and "剧本缺口 1" in reply["answer"] and "NG 1" in reply["answer"]
    for path in ("/private/", "/Users/", "C:\\", "/Volumes/"):
        assert path not in json.dumps(reply) and path not in assistant.store.path.read_text()
    prompts = []
    assistant.language = SimpleNamespace(enabled=True, complete_answer=lambda **kwargs: prompts.append(kwargs["context"]) or "收到")
    assistant.answer("项目进度怎么样？")
    assert prompts[0]["project_steward"] == steward
    assert all(path.read_bytes() == content for path, content in before.items())


@pytest.mark.parametrize("vision_enabled", [False, True])
def test_missing_coverage_suggests_allowlisted_actions_without_submitting(question_assistant, monkeypatch, vision_enabled):
    assistant = question_assistant
    assistant.language = SimpleNamespace(enabled=False)
    assistant.config.transcript_dir.rmdir()
    monkeypatch.setattr(assistant.models, "vision", SimpleNamespace(enabled=vision_enabled))
    monkeypatch.setattr(assistant.task_manager, "submit", lambda *_a, **_k: pytest.fail("问答不应提交任务"))
    reply = assistant.answer("帮我查这句对白的特写镜头")
    actions = reply["suggested_actions"]
    assert [(action["action"], action.get("task_type")) for action in actions] == [
        ("submit_task", "transcribe"),
        ("submit_task", "evidence_extract") if vision_enabled else ("open_settings", None),
    ]
    assert actions[0]["targets"] == {}
    if vision_enabled:
        assert actions[1]["targets"] == {"group_ids": ["G1"]}
    assert assistant.store.load()["messages"][-1]["suggested_actions"] == actions
    ScriptSupervisorStore(assistant.config.output_dir).apply({
        "group_id": "G1", "actor": "slate", "expected_revision": 0, "entry": {"note": "有场记备注"},
    })
    refresh = assistant.answer("找不存在的水壶")
    assert [action["task_type"] for action in refresh["suggested_actions"]] == ["semantic_index"]
    assert not refresh["retrieval"]["results"] and not assistant.task_manager.submitted
    assert not assistant.config.transcript_dir.exists()
