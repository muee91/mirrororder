from __future__ import annotations

from pathlib import Path

from script_organizer.semantic_profiles import (
    DEFAULT_SEMANTIC_PROFILE,
    SEMANTIC_QUERY_INSTRUCTION,
    STANDARD_MODEL_REVISION,
    semantic_profile,
    semantic_profiles_public,
)


def test_standard_profile_targets_qwen3_vl_embedding_2b() -> None:
    profile = semantic_profile("standard")
    assert DEFAULT_SEMANTIC_PROFILE == "standard"
    assert profile.model == "Qwen/Qwen3-VL-Embedding-2B"
    assert profile.revision == STANDARD_MODEL_REVISION
    assert len(profile.revision) == 40
    assert profile.runtime == "sentence-transformers"
    assert set(profile.modalities) == {"text", "image", "video", "mixed"}
    assert profile.max_dimensions == 2048
    assert profile.default_dimensions == 1024
    assert profile.instruction_aware is True
    assert profile.mrl is True


def test_lightweight_profile_is_official_text_gguf_fallback() -> None:
    profile = semantic_profile("lightweight")
    assert profile.model == "Qwen/Qwen3-Embedding-0.6B-GGUF"
    assert profile.runtime == "llama-server"
    assert profile.modalities == ("text",)
    assert profile.max_dimensions == 1024
    assert profile.default_dimensions == 1024


def test_profile_inventory_never_grants_editorial_authority() -> None:
    payload = semantic_profiles_public()
    assert payload["default"] == "standard"
    assert payload["query_instruction"] == SEMANTIC_QUERY_INSTRUCTION
    assert set(payload["profiles"]) == {"standard", "lightweight"}
    assert payload["authority"] == {
        "retrieval_only": True,
        "review_write": False,
        "editorial_write": False,
        "best_selection": False,
    }
    for row in payload["profiles"].values():
        support = row["runtime_support"]
        assert isinstance(support["available"], bool)
        assert support["runtime"] == row["runtime"]
    assert payload["profiles"]["standard"]["revision"] == STANDARD_MODEL_REVISION


def test_desktop_search_and_assistant_do_not_trigger_inline_index_refresh() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "src" / "script_organizer" / "semantic_runtime.py").read_text(encoding="utf-8")
    assert runtime.count("refresh=False") >= 4
    assert ".search(text, limit=14, refresh=True)" not in runtime
    assert "inline_index_refresh\": False" in runtime
