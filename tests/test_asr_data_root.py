from __future__ import annotations

from pathlib import Path

import script_organizer.asr_runtime as asr_runtime


def test_asr_model_cache_uses_shared_application_support_root(monkeypatch, tmp_path: Path) -> None:
    root = tmp_path / "device-root"
    monkeypatch.setattr(asr_runtime, "application_support_root", lambda: root)
    for key in ("HF_HOME", "HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"):
        monkeypatch.delenv(key, raising=False)

    cache = asr_runtime._configure_model_cache()

    assert cache == root / "models" / "huggingface"
    assert cache.is_dir()
    assert asr_runtime.os.environ["HF_HOME"] == str(cache)


def test_asr_model_cache_respects_explicit_operator_cache(monkeypatch, tmp_path: Path) -> None:
    root = tmp_path / "device-root"
    explicit = tmp_path / "operator-cache"
    monkeypatch.setattr(asr_runtime, "application_support_root", lambda: root)
    monkeypatch.setenv("HF_HOME", str(explicit))
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    monkeypatch.delenv("HUGGINGFACE_HUB_CACHE", raising=False)

    cache = asr_runtime._configure_model_cache()

    assert cache == root / "models" / "huggingface"
    assert asr_runtime.os.environ["HF_HOME"] == str(explicit)
