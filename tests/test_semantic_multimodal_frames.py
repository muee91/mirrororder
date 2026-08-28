from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from script_organizer.semantic_search import SemanticSearcher
from script_organizer.semantic_store import SemanticStore
from script_organizer.semantic_task_indexer import (
    FRAME_SOURCE,
    _frame_documents,
    _prepare_documents,
)
from script_organizer.workspace_db import WorkspaceDatabase


class _Config:
    profile = "standard"

    @staticmethod
    def public() -> dict:
        return {"enabled": True, "profile": "standard", "model": "fake-multimodal"}


class _FakeMultimodalEncoder:
    enabled = True
    identity = "fake:shared-space"
    config = _Config()

    @staticmethod
    def encode_multimodal(inputs):
        return [[1.0, 0.0] for _value in inputs]

    @staticmethod
    def encode(texts):
        return [[0.0, 1.0] for _value in texts]

    @staticmethod
    def encode_one(_text: str):
        return [1.0, 0.0]


class _FakeIndexer:
    project_id = "demo"

    def __init__(self, database: WorkspaceDatabase):
        self.encoder = _FakeMultimodalEncoder()
        self.database = database
        self.store = SemanticStore(database)

    @staticmethod
    def _selected_groups(_group_ids):
        return {
            "G1": {
                "group_id": "G1",
                "members": [
                    {
                        "clip_id": "C1",
                        "media_id": "M1",
                        "camera": "B",
                        "source_start": 10.0,
                    }
                ],
            }
        }

    @staticmethod
    def _visual_documents(_groups):
        return []

    @staticmethod
    def _speech_documents(_groups):
        return []

    @staticmethod
    def _slate_documents(_group_ids):
        return []


def _database(tmp_path: Path) -> WorkspaceDatabase:
    return WorkspaceDatabase("semantic-frame-test", path=tmp_path / "workspace.sqlite3")


def test_legacy_all_text_sources_expand_to_frame_but_scoped_refresh_does_not(tmp_path: Path) -> None:
    indexer = _FakeIndexer(_database(tmp_path))
    all_rows = _prepare_documents(
        indexer,
        group_ids=None,
        sources=["visual", "speech", "slate"],
    )
    assert {source for source, _rows in all_rows} == {"visual", "speech", "slate", FRAME_SOURCE}

    speech_only = _prepare_documents(indexer, group_ids=None, sources=["speech"])
    assert [source for source, _rows in speech_only] == ["speech"]


def test_frame_embedding_path_is_transient_and_never_persisted(tmp_path: Path) -> None:
    database = _database(tmp_path)
    indexer = _FakeIndexer(database)
    frame_path = tmp_path / "secret-device-frame.jpg"
    frame_path.write_bytes(b"representative-frame")
    database.replace_frames(
        "demo",
        "G1",
        [
            {
                "frame_id": "frm_1",
                "clip_id": "C1",
                "camera": "B",
                "source_time": 12.5,
                "reason": "semantic",
                "path": str(frame_path),
            }
        ],
    )

    documents = _frame_documents(indexer, indexer._selected_groups(None))
    assert len(documents) == 1
    assert documents[0]["_embedding_input"] == {"image": str(frame_path)}
    assert documents[0]["start"] == 2.5
    assert documents[0]["metadata"]["frame_id"] == "frm_1"

    documents[0]["embedding"] = [1.0, 0.0]
    documents[0]["embedding_model"] = indexer.encoder.identity
    indexer.store.replace_documents("demo", FRAME_SOURCE, documents)
    persisted = indexer.store.documents("demo", sources=[FRAME_SOURCE])
    assert len(persisted) == 1
    serialized = repr(persisted)
    assert "_embedding_input" not in serialized
    assert str(frame_path) not in serialized
    assert persisted[0]["metadata"]["frame_id"] == "frm_1"
    assert persisted[0]["media_id"] == "M1"


def test_text_query_can_recall_representative_frame_in_shared_vector_space(tmp_path: Path) -> None:
    database = _database(tmp_path)
    store = SemanticStore(database)
    store.replace_documents(
        "demo",
        FRAME_SOURCE,
        [
            {
                "document_id": "frame-door",
                "group_id": "G-door",
                "clip_id": "C-door",
                "media_id": "M-door",
                "source": FRAME_SOURCE,
                "start": 1.25,
                "end": 1.25,
                "text": "代表帧 · B · 1.25s",
                "metadata": {"evidence": "representative_frame", "frame_id": "frm-door"},
                "content_fingerprint": "frame-v1",
                "embedding": [1.0, 0.0],
                "embedding_model": _FakeMultimodalEncoder.identity,
            }
        ],
    )
    store.replace_documents(
        "demo",
        "speech",
        [
            {
                "document_id": "speech-other",
                "group_id": "G-other",
                "source": "speech",
                "text": "我们先去办公室。",
                "metadata": {"evidence": "speech"},
                "content_fingerprint": "speech-v1",
                "embedding": [0.0, 1.0],
                "embedding_model": _FakeMultimodalEncoder.identity,
            }
        ],
    )

    searcher = SemanticSearcher(
        "semantic-frame-test",
        "demo",
        SimpleNamespace(),
        database=database,
        encoder=_FakeMultimodalEncoder(),
    )
    payload = searcher.search("找推门后的反应镜头", refresh=False)
    assert payload["mode"] == "vector"
    assert payload["results"][0]["source"] == FRAME_SOURCE
    assert payload["results"][0]["source_label"] == "代表帧"
    assert payload["results"][0]["group_id"] == "G-door"
    assert payload["results"][0]["vector_similarity"] == 1.0
    assert payload["semantics"]["device_paths_exposed"] is False
    assert payload["semantics"]["representative_frame_vectors"] is True
