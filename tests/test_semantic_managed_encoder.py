from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest

from script_organizer.device_runtime_settings import load_runtime_settings, save_runtime_settings
from script_organizer.semantic_managed_encoder import ManagedSemanticEncoder, _map_qwen_checkpoint_keys
from script_organizer.semantic_profiles import STANDARD_MODEL_REVISION


def _isolated_runtime(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("MIRRORORDER_DATA_DIR", str(tmp_path / "app-data"))
    for key in (
        "MIRRORORDER_EMBEDDING_PROVIDER",
        "MIRRORORDER_EMBEDDING_BASE_URL",
        "MIRRORORDER_EMBEDDING_API_KEY",
        "MIRRORORDER_EMBEDDING_MODEL",
        "MIRRORORDER_SEMANTIC_PROFILE",
    ):
        monkeypatch.delenv(key, raising=False)


def test_semantic_runtime_settings_are_device_local_and_opt_in(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _isolated_runtime(monkeypatch, tmp_path)
    defaults = load_runtime_settings()
    assert defaults["semantic_embedding_enabled"] is False
    assert defaults["semantic_embedding_profile"] == "standard"
    assert defaults["semantic_embedding_dimensions"] == 1024

    saved = save_runtime_settings(
        {
            "semantic_embedding_enabled": True,
            "semantic_embedding_profile": "standard",
            "semantic_embedding_dimensions": 1024,
        }
    )
    assert saved["version"] == 5
    assert saved["semantic_embedding_enabled"] is True
    assert saved["semantic_embedding_profile"] == "standard"
    assert saved["semantic_embedding_dimensions"] == 1024
    payload = json.loads((tmp_path / "app-data" / "runtime-settings.json").read_text(encoding="utf-8"))
    assert payload["semantic_embedding_profile"] == "standard"
    assert "review" not in payload
    assert "editorial" not in payload


def test_semantic_dimensions_are_validated_per_profile(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _isolated_runtime(monkeypatch, tmp_path)
    with pytest.raises(ValueError):
        save_runtime_settings(
            {
                "semantic_embedding_profile": "standard",
                "semantic_embedding_dimensions": 4096,
            }
        )
    light = save_runtime_settings(
        {
            "semantic_embedding_profile": "lightweight",
            "semantic_embedding_dimensions": 1024,
        }
    )
    assert light["semantic_embedding_profile"] == "lightweight"
    assert light["semantic_embedding_dimensions"] == 1024


def test_search_encoder_never_prepares_or_downloads_model_inline(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _isolated_runtime(monkeypatch, tmp_path)
    save_runtime_settings(
        {
            "semantic_embedding_enabled": True,
            "semantic_embedding_profile": "standard",
            "semantic_embedding_dimensions": 1024,
        }
    )
    import script_organizer.semantic_managed_encoder as managed

    monkeypatch.setattr(managed, "semantic_runtime_support", lambda _profile: {"available": True})
    encoder = ManagedSemanticEncoder(allow_prepare=False)
    assert encoder.enabled is True
    assert encoder.prepared is False

    def forbidden_prepare() -> bool:
        raise AssertionError("search path must never prepare/download the model")

    monkeypatch.setattr(encoder, "prepare", forbidden_prepare)
    assert encoder.encode_one("找陈大山站在窗边的镜头") is None
    assert encoder.prepared is False


def test_vector_identity_changes_with_dimensions_and_instruction_contract(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _isolated_runtime(monkeypatch, tmp_path)
    import script_organizer.semantic_managed_encoder as managed

    monkeypatch.setattr(managed, "semantic_runtime_support", lambda _profile: {"available": True})
    save_runtime_settings(
        {
            "semantic_embedding_enabled": True,
            "semantic_embedding_profile": "standard",
            "semantic_embedding_dimensions": 1024,
        }
    )
    first = ManagedSemanticEncoder(allow_prepare=False)
    save_runtime_settings({"semantic_embedding_dimensions": 768})
    second = ManagedSemanticEncoder(allow_prepare=False)
    assert first.identity != second.identity
    assert "Qwen/Qwen3-VL-Embedding-2B" in first.identity
    assert "1024" in first.identity
    assert "768" in second.identity
    assert "editor-retrieval-v1" in first.identity
    assert STANDARD_MODEL_REVISION in first.identity
    assert first.config.public()["revision"] == STANDARD_MODEL_REVISION


def test_prepare_downloads_the_pinned_revision_and_rejects_unresolved_snapshot(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _isolated_runtime(monkeypatch, tmp_path)
    import script_organizer.semantic_managed_encoder as managed

    monkeypatch.setattr(managed, "semantic_runtime_support", lambda _profile: {"available": True})
    save_runtime_settings(
        {
            "semantic_embedding_enabled": True,
            "semantic_embedding_profile": "standard",
            "semantic_embedding_dimensions": 1024,
        }
    )
    encoder = ManagedSemanticEncoder(allow_prepare=True)
    monkeypatch.setattr(managed.ManagedSemanticEncoder, "_models", {})
    snapshot = tmp_path / "snapshots" / STANDARD_MODEL_REVISION
    snapshot.mkdir(parents=True)
    calls: list[dict[str, str]] = []

    def fake_snapshot_download(model: str, *, revision: str, cache_dir: str) -> str:
        calls.append({"model": model, "revision": revision, "cache_dir": cache_dir})
        return str(snapshot)

    hub = types.ModuleType("huggingface_hub")
    hub.snapshot_download = fake_snapshot_download  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub)
    monkeypatch.setattr(managed, "_load_qwen_sentence_transformer", lambda *args, **kwargs: object())
    monkeypatch.setattr(managed.ManagedSemanticEncoder, "_device", staticmethod(lambda _torch: "cpu"))
    torch = types.ModuleType("torch")
    monkeypatch.setitem(sys.modules, "torch", torch)

    assert encoder.prepare() is True
    assert calls == [
        {
            "model": "Qwen/Qwen3-VL-Embedding-2B",
            "revision": STANDARD_MODEL_REVISION,
            "cache_dir": str(tmp_path / "app-data" / "models" / "semantic"),
        }
    ]
    assert encoder.identity.endswith(f":1024:editor-retrieval-v1")

    ManagedSemanticEncoder._models.clear()
    wrong_encoder = ManagedSemanticEncoder(allow_prepare=True)
    wrong_snapshot = tmp_path / "snapshots" / "wrong-revision"
    wrong_snapshot.mkdir()
    monkeypatch.setattr(
        hub,
        "snapshot_download",
        lambda model, *, revision, cache_dir: str(wrong_snapshot),
    )
    assert wrong_encoder.prepare() is False
    assert "revision mismatch" in wrong_encoder.last_error


def test_qwen_checkpoint_mapping_is_explicit_and_fail_closed() -> None:
    marker = object()
    assert _map_qwen_checkpoint_keys({"model.language_model.weight": marker}) == {"language_model.weight": marker}
    with pytest.raises(ValueError):
        _map_qwen_checkpoint_keys({"language_model.weight": marker})


def test_desktop_contract_exposes_semantic_profile_without_model_download_action() -> None:
    root = Path(__file__).resolve().parents[1]
    api = (root / "desktop" / "src" / "api" / "desktop.ts").read_text(encoding="utf-8")
    panel = (root / "desktop" / "src" / "features" / "settings" / "LocalRuntimePanel.tsx").read_text(encoding="utf-8")
    settings = (root / "desktop" / "src" / "features" / "settings" / "SettingsStatusWorkbench.tsx").read_text(encoding="utf-8")
    requirements = (root / "requirements-semantic.txt").read_text(encoding="utf-8")

    assert 'export type SemanticEmbeddingProfile = "standard" | "lightweight"' in api
    assert "semantic_embedding_enabled" in api
    assert "准备并建立当前项目索引" in panel
    assert 'tasks.submit(' in panel
    assert '"semantic_index"' in panel
    assert '<LocalRuntimePanel baseUrl={baseUrl} projectId={projectId} />' in settings
    assert "sentence-transformers[image]==5.4.0" in requirements
    assert "never pip-install at App launch" in requirements
