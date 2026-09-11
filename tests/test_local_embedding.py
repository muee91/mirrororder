"""内置本地向量编码器：目录解析与 SemanticEncoder 本地降级。"""

from __future__ import annotations

import pytest


def _make_model_dir(root: Path, name: str) -> Path:
    model_dir = root / "models" / name
    model_dir.mkdir(parents=True)
    (model_dir / "model.onnx").write_bytes(b"onnx-placeholder")
    (model_dir / "tokenizer.json").write_bytes(b"{}")
    return model_dir


def test_local_embedding_dir_resolution(tmp_path: Path, monkeypatch) -> None:
    from script_organizer import local_embedding

    model_dir = _make_model_dir(tmp_path, "embedding")
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("MIRRORORDER_EMBEDDING_MODEL_DIR", raising=False)
    assert local_embedding.local_embedding_model_dir() == model_dir
    assert local_embedding.local_embedding_available() is True


def test_local_embedding_prefers_explicit_override(tmp_path: Path, monkeypatch) -> None:
    from script_organizer import local_embedding

    override = tmp_path / "custom" / "vector-zh"
    override.mkdir(parents=True)
    (override / "model.onnx").write_bytes(b"onnx")
    (override / "tokenizer.json").write_bytes(b"{}")
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("MIRRORORDER_EMBEDDING_MODEL_DIR", str(override))
    assert local_embedding.local_embedding_model_dir() == override


def test_semantic_encoder_falls_back_to_local_model(tmp_path: Path, monkeypatch) -> None:
    from script_organizer.semantic_encoder import SemanticEncoder

    _make_model_dir(tmp_path, "embedding")
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path))
    for key in ("MIRRORORDER_EMBEDDING_PROVIDER", "MIRRORORDER_EMBEDDING_BASE_URL", "MIRRORORDER_EMBEDDING_API_KEY", "MIRRORORDER_EMBEDDING_MODEL"):
        monkeypatch.delenv(key, raising=False)
    encoder = SemanticEncoder()
    assert encoder.enabled is True
    assert encoder.identity.startswith("local-onnx:")
    assert encoder.public()["provider"] == "local-onnx"


def test_semantic_encoder_stays_disabled_without_local_model(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path / "app-support"))
    for key in ("MIRRORORDER_EMBEDDING_PROVIDER", "MIRRORORDER_EMBEDDING_BASE_URL", "MIRRORORDER_EMBEDDING_API_KEY", "MIRRORORDER_EMBEDDING_MODEL", "MIRRORORDER_EMBEDDING_MODEL_DIR"):
        monkeypatch.delenv(key, raising=False)
    from script_organizer.semantic_encoder import SemanticEncoder

    assert SemanticEncoder().enabled is False
