from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ASSISTANT = ROOT / "desktop" / "src" / "features" / "assistant" / "AssistantWorkbench.tsx"
SETTINGS = ROOT / "desktop" / "src" / "features" / "settings" / "SettingsStatusWorkbench.tsx"
STATUS = ROOT / "desktop" / "src" / "features" / "status" / "StatusCenterWorkbench.tsx"
PROJECT_LIFECYCLE = ROOT / "desktop" / "src" / "features" / "projects" / "ProjectLifecyclePanel.tsx"
LEGACY_TASK_PANEL = ROOT / "desktop" / "src" / "features" / "settings" / "TaskStatusPanel.tsx"
SEMANTIC_RUNTIME = ROOT / "src" / "script_organizer" / "semantic_runtime.py"
DOCS_INDEX = ROOT / "docs" / "README.md"
README = ROOT / "README.md"
AGENTS = ROOT / "AGENTS.md"
DESKTOP_README = ROOT / "desktop" / "README.md"


def test_model_connection_configuration_has_one_global_settings_home() -> None:
    assistant = ASSISTANT.read_text(encoding="utf-8")
    settings = SETTINGS.read_text(encoding="utf-8")

    assert "AssistantModelsPanel" not in assistant
    assert "Provider" not in assistant
    assert "Base URL" not in assistant
    assert "API Key" not in assistant
    assert "AssistantModelsPanel" in settings
    assert "外部 / 自定义模型连接" in settings
    assert "连接本身仍是设备本机配置，不会写入项目" in settings


def test_status_center_is_the_single_durable_task_surface() -> None:
    status = STATUS.read_text(encoding="utf-8")
    settings = SETTINGS.read_text(encoding="utf-8")

    assert not LEGACY_TASK_PANEL.exists()
    assert "showCompleted" in status
    assert "查看已完成" in status
    assert "canCancelTask" in status
    assert "canRetryTask" in status
    assert "semantic_index" in status
    assert "语义索引" in status
    assert "waiting_embedding" in status
    assert "后台任务统一在“状态中心”查看" in settings


def test_semantic_refresh_is_durable_instead_of_hidden_daemon_work() -> None:
    source = SEMANTIC_RUNTIME.read_text(encoding="utf-8")

    assert 'tasks_module.TASK_TYPES.add("semantic_index")' in source
    assert '"semantic_index"' in source
    assert 'manager.submit(' in source
    assert 'idempotency_key=f"semantic-refresh:{task_id}"' in source
    assert 'manager._resource(config, task, "embedding", "semantic_index", "语义索引")' in source
    assert 'progress={"done": index, "total": total}' in source
    assert "Thread(target=refresh" not in source
    assert "daemon=True" not in source


def test_project_removal_copy_uses_user_language_and_matches_backend_boundary() -> None:
    source = PROJECT_LIFECYCLE.read_text(encoding="utf-8")

    assert "工作区内生成的项目目录和项目记录" in source
    assert "你原来的媒体、剧本与 FCPXML 文件不会被删除" in source
    assert "quarantine" not in source
    assert "Core 会" not in source


def test_document_authority_has_one_front_door() -> None:
    docs = DOCS_INDEX.read_text(encoding="utf-8")
    readme = README.read_text(encoding="utf-8")
    agents = AGENTS.read_text(encoding="utf-8")
    desktop = DESKTOP_README.read_text(encoding="utf-8")

    assert "当前产品与工程 Authority" in docs
    assert "app-information-architecture.md" in docs
    assert "ux-principles.md" in docs
    assert "一次性 Codex prompt" in docs
    assert "docs/README.md" in readme
    assert "docs/README.md" in agents
    assert "docs/app-information-architecture.md" in agents
    assert "docs/ux-principles.md" in agents
    assert "../docs/README.md" in desktop
