from __future__ import annotations

from pathlib import Path

from script_organizer.local_vision_runtime import DEFAULT_LOCAL_VISION_MODEL, LocalVisionRuntime
from script_organizer.vision_provider import VisionProviderConfig


def test_local_vision_provider_has_pinned_default_model(monkeypatch) -> None:
    monkeypatch.setenv("MIRRORORDER_VISION_PROVIDER", "local")
    monkeypatch.delenv("MIRRORORDER_VISION_MODEL", raising=False)
    monkeypatch.delenv("MIRRORORDER_VISION_BASE_URL", raising=False)
    config = VisionProviderConfig.from_env()
    assert config.enabled is True
    assert config.is_local is True
    assert config.model == DEFAULT_LOCAL_VISION_MODEL
    assert config.base_url == ""


def test_local_model_cache_is_device_local(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path / "MirrorOrder"))
    runtime = LocalVisionRuntime()
    assert runtime.cache_dir == tmp_path / "MirrorOrder" / "models" / "llama-cache"
    assert "projects" not in runtime.cache_dir.parts
    assert runtime.public()["download_policy"] == "first_use_when_local_vision_enabled"


def test_app_build_bundles_binary_but_never_model_weights() -> None:
    root = Path(__file__).resolve().parents[1]
    build = (root / "macos-app" / "build_app.sh").read_text(encoding="utf-8")
    assert "MIRRORORDER_LLAMA_SERVER" in build
    assert 'cp "$LLAMA_SERVER_SOURCE" "$RUNTIME/bin/llama-server"' in build
    assert "build must NEVER download or embed model weights" in build
    assert "huggingface.co" not in build
    assert "curl " not in build
    assert "wget " not in build


def test_local_runtime_binds_llama_server_to_loopback_only() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "src" / "script_organizer" / "local_vision_runtime.py").read_text(encoding="utf-8")
    assert '"--host", "127.0.0.1"' in runtime
    assert 'environment["LLAMA_CACHE"]' in runtime
    assert '"-hf", self.config.model' in runtime
    assert "shell=True" not in runtime
