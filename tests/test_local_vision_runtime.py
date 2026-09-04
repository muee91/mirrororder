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
    assert public["read_path_health_probe"] is False
    assert public["read_path_cache_scan"] is False


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
    stage = (root / "desktop/scripts/stage-runtime.mjs").read_text(encoding="utf-8")
    verifier = (root / "desktop/scripts/verify-macos-bundle.mjs").read_text(encoding="utf-8")
    runtime = (root / "desktop/src-tauri/src/runtime.rs").read_text(encoding="utf-8")
    panel = (root / "desktop/src/features/settings/LocalRuntimePanel.tsx").read_text(encoding="utf-8")
    assert "MIRRORORDER_PORTABLE_PYTHON_ROOT" in stage
    assert "MIRRORORDER_MEDIA_TOOLS_ROOT" in stage
    assert "model weights" in stage
    assert "runtime manifest" in verifier
    assert "PACKAGED_RUNTIME_CONTRACT" in runtime
    assert "resolve_python_runtime" in runtime
    assert "本地 AI 与身份识别" in panel
    assert "启用一次后" in panel
    assert 'setCapability("vision"' in panel
    assert 'action: "prepare_identity"' in panel
    assert "重新准备" in panel
    assert "切换项目不需要重新激活" in panel
    assert "可取消的设备任务进入状态中心" in panel


def test_legacy_local_runtime_route_is_removed_and_desktop_api_is_host_local() -> None:
    root = Path(__file__).resolve().parents[1]
    automation = (root / "src" / "script_organizer" / "automation_runtime.py").read_text(encoding="utf-8")
    desktop = (root / "src" / "script_organizer" / "desktop_runtime.py").read_text(encoding="utf-8")
    assert '["api", "v1", "local-runtime"]' not in automation
    assert "_runtime_payload" not in automation
    assert '["api", "v1", "desktop-local-runtime"]' in desktop
    assert '["api", "v1", "device-tasks"]' in desktop
    assert "self._local_only()" in desktop
    assert 'action == "prepare"' in desktop
    assert "prepare_async" not in desktop
    assert '"local_vision_prepare"' in desktop
    assert '"identity_runtime_prepare"' in desktop


def test_local_runtime_binds_llama_server_to_loopback_only() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "src" / "script_organizer" / "local_vision_runtime.py").read_text(encoding="utf-8")
    assert '"--host", "127.0.0.1"' in runtime
    assert 'environment["LLAMA_CACHE"]' in runtime
    assert '"-hf", self.config.model' in runtime
    assert "shell=True" not in runtime
