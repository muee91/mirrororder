from __future__ import annotations

from pathlib import Path

from script_organizer.asr_runtime import _configure_model_cache
from script_organizer.device_runtime_settings import load_runtime_settings, save_runtime_settings, settings_path
from script_organizer.local_vision_runtime import DEFAULT_LOCAL_VISION_MODEL, LocalVisionRuntime
from script_organizer.vision_provider import VisionProviderConfig


def test_local_vision_provider_has_pinned_default_model(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path / "MirrorOrder"))
    monkeypatch.setenv("MIRRORORDER_VISION_PROVIDER", "local")
    monkeypatch.delenv("MIRRORORDER_VISION_MODEL", raising=False)
    monkeypatch.delenv("MIRRORORDER_VISION_BASE_URL", raising=False)
    config = VisionProviderConfig.from_env()
    assert config.enabled is True
    assert config.is_local is True
    assert config.model == DEFAULT_LOCAL_VISION_MODEL
    assert config.base_url == ""


def test_device_setting_controls_local_vision_without_project_state(monkeypatch, tmp_path: Path) -> None:
    root = tmp_path / "MirrorOrder"
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(root))
    monkeypatch.delenv("MIRRORORDER_VISION_PROVIDER", raising=False)
    monkeypatch.delenv("MIRRORORDER_VISION_MODEL", raising=False)

    saved = save_runtime_settings({"local_vision_enabled": True})
    assert saved["local_vision_enabled"] is True
    assert settings_path() == root / "runtime-settings.json"
    assert load_runtime_settings()["local_vision_model"] == DEFAULT_LOCAL_VISION_MODEL

    config = VisionProviderConfig.from_env()
    assert config.provider == "local"
    assert config.enabled is True
    assert config.model == DEFAULT_LOCAL_VISION_MODEL

    save_runtime_settings({"local_vision_enabled": False})
    assert VisionProviderConfig.from_env().enabled is False


def test_local_model_cache_is_device_local(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path / "MirrorOrder"))
    runtime = LocalVisionRuntime()
    assert runtime.cache_dir == tmp_path / "MirrorOrder" / "models" / "llama-cache"
    assert "projects" not in runtime.cache_dir.parts
    public = runtime.public()
    assert public["download_policy"] == "first_use_when_local_vision_enabled"
    assert "status" in public
    assert "cache_bytes" in public
    assert "preparing" in public


def test_mlx_model_cache_is_device_local(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path / "MirrorOrder"))
    monkeypatch.delenv("HF_HOME", raising=False)
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_CACHE", raising=False)
    cache = _configure_model_cache()
    assert cache == tmp_path / "MirrorOrder" / "models" / "huggingface"
    assert "projects" not in cache.parts


def test_app_build_bundles_runtime_ui_but_never_model_weights() -> None:
    root = Path(__file__).resolve().parents[1]
    build = (root / "macos-app" / "build_app.sh").read_text(encoding="utf-8")
    desktop = "\n".join(
        (root / "macos-app" / name).read_text(encoding="utf-8")
        for name in ("MirrorOrderDesktopCore.swift", "MirrorOrderDesktopUI.swift")
    )
    panel = (root / "macos-app" / "LocalRuntimeSettingsView.swift").read_text(encoding="utf-8")
    assert "MIRRORORDER_LLAMA_SERVER" in build
    assert 'cp "$LLAMA_SERVER_SOURCE" "$RUNTIME_BIN"' in build
    assert 'install_name_tool -id "@rpath/$name"' in build
    assert 'RUNTIME_LIB_SOURCES=(' in build
    assert 'llama-runtime.lock' in build
    assert "validate_macho_closure" in build
    assert "external Mach-O dependency" in build
    assert 'codesign --force --sign - "$RUNTIME/bin/llama-server"' in build
    assert 'codesign --force --deep --sign - "$APP"' in build
    assert '"$CORE_SOURCE" "$UI_SOURCE" "$NATIVE_WORKBENCH_SOURCE" "$LOCAL_RUNTIME_SOURCE" "$RUNTIME_OVERVIEW_SOURCE"' in build
    assert "build must NEVER download or embed model weights" in build
    assert "huggingface.co" not in build
    assert "curl " not in build
    assert "wget " not in build
    assert "LocalRuntimeSettingsSection(" in desktop
    assert "workspaceID: controller.selectedWorkspaceID" in desktop
    assert '@Published var port = "8766"' in desktop
    assert 'private let selectedWorkspaceKey = "selectedWorkspaceID"' in desktop
    assert 'private let selectedProjectKey = "selectedProjectID"' in desktop
    assert "persistSelection()" in desktop
    assert 'appendingPathComponent("local-runtime")' in panel
    assert "首次下载并准备模型" in panel
    assert 'appendingPathComponent("api/v1/workspaces")' in panel


def test_local_runtime_control_api_is_host_local() -> None:
    root = Path(__file__).resolve().parents[1]
    automation = (root / "src" / "script_organizer" / "automation_runtime.py").read_text(encoding="utf-8")
    assert '["api", "v1", "local-runtime"]' in automation
    assert "self._local_only()" in automation
    assert 'action == "prepare"' in automation
    assert "prepare_async" in automation


def test_local_runtime_binds_llama_server_to_loopback_only() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "src" / "script_organizer" / "local_vision_runtime.py").read_text(encoding="utf-8")
    assert '"--host", "127.0.0.1"' in runtime
    assert 'environment["LLAMA_CACHE"]' in runtime
    assert '"-hf", self.config.model' in runtime
    assert "shell=True" not in runtime
