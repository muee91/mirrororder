from __future__ import annotations

from pathlib import Path

from script_organizer.semantic_task_indexer import refresh_semantic_index_background


class _Config:
    def __init__(self, enabled: bool):
        self.enabled = enabled

    def public(self) -> dict:
        return {"enabled": self.enabled, "model": "fake-4d" if self.enabled else ""}


class FakeEncoder:
    enabled = True
    identity = "fake:fake-4d"

    def __init__(self):
        self.config = _Config(True)
        self.calls = 0

    def encode(self, texts):
        self.calls += 1
        rows = list(texts)
        return [[1.0, 0.0, 0.0, 0.0] for _ in rows]


class BrokenEncoder(FakeEncoder):
    def encode(self, texts):
        self.calls += 1
        return None


class DisabledEncoder:
    enabled = False
    identity = ""

    def __init__(self):
        self.config = _Config(False)

    def encode(self, _texts):
        raise AssertionError("disabled encoder must not be called")


class FakeStore:
    def __init__(self):
        self.rows: dict[str, dict] = {}

    def documents(self, _project_id: str, *, sources=None, embedding_model=None):
        selected = set(sources or [])
        rows = [dict(row) for row in self.rows.values() if not selected or row["source"] in selected]
        if embedding_model is not None:
            rows = [row for row in rows if row.get("embedding_model") == embedding_model]
        return rows

    def replace_documents(self, _project_id: str, source: str, documents, *, group_ids=None):
        del group_ids
        incoming = {row["document_id"] for row in documents}
        stale = [key for key, row in self.rows.items() if row["source"] == source and key not in incoming]
        for key in stale:
            self.rows.pop(key, None)
        for row in documents:
            self.rows[row["document_id"]] = dict(row)
        return {"documents": len(documents), "changed": len(documents), "unchanged": 0, "removed": len(stale)}

    def summary(self, _project_id: str):
        return {
            "documents": len(self.rows),
            "vectors": sum(1 for row in self.rows.values() if row.get("embedding")),
        }


class FakeIndexer:
    def __init__(self, documents: dict[str, list[dict]], encoder):
        self.project_id = "demo"
        self.encoder = encoder
        self.store = FakeStore()
        self._documents = documents

    def _selected_groups(self, _group_ids):
        return {}

    def _visual_documents(self, _groups):
        return [dict(row) for row in self._documents.get("visual", [])]

    def _speech_documents(self, _groups):
        return [dict(row) for row in self._documents.get("speech", [])]

    def _slate_documents(self, _group_ids):
        return [dict(row) for row in self._documents.get("slate", [])]


def _docs(source: str, count: int) -> list[dict]:
    return [
        {
            "document_id": f"{source}-{index}",
            "group_id": f"G{index}",
            "clip_id": "",
            "media_id": "",
            "source": source,
            "start": 0,
            "end": 1,
            "text": f"document {index}",
            "metadata": {"evidence": source},
            "content_fingerprint": f"v1-{index}",
        }
        for index in range(count)
    ]


def test_background_index_cancels_between_embedding_batches_and_keeps_partial_work() -> None:
    encoder = FakeEncoder()
    indexer = FakeIndexer({"visual": _docs("visual", 5)}, encoder)
    seen: list[tuple[int, int, str]] = []

    result = refresh_semantic_index_background(
        indexer,
        sources=["visual"],
        batch_size=2,
        progress=lambda done, total, source: seen.append((done, total, source)),
        cancelled=lambda: encoder.calls >= 1,
    )

    assert result["cancelled"] is True
    assert result["progress"] == {"done": 2, "total": 5}
    assert indexer.store.summary("demo") == {"documents": 5, "vectors": 2}
    assert encoder.calls == 1
    assert (2, 5, "visual") in seen


def test_embedding_failure_keeps_lexical_documents_and_reports_retryable_failure() -> None:
    indexer = FakeIndexer({"speech": _docs("speech", 3)}, BrokenEncoder())
    result = refresh_semantic_index_background(indexer, sources=["speech"], batch_size=2)

    assert result["cancelled"] is False
    assert result["embedding_failed"] is True
    assert indexer.store.summary("demo") == {"documents": 3, "vectors": 0}


def test_disabled_encoder_finishes_as_lexical_index_without_fake_vectors() -> None:
    indexer = FakeIndexer(
        {"slate": _docs("slate", 2), "visual": _docs("visual", 2)},
        DisabledEncoder(),
    )
    seen: list[tuple[int, int, str]] = []
    result = refresh_semantic_index_background(
        indexer,
        sources=["visual", "slate"],
        progress=lambda done, total, source: seen.append((done, total, source)),
    )

    assert result["cancelled"] is False
    assert result["embedding_failed"] is False
    assert result["progress"] == {"done": 4, "total": 4}
    assert indexer.store.summary("demo") == {"documents": 4, "vectors": 0}
    assert seen[-1][0:2] == (4, 4)


def test_semantic_task_is_visible_and_search_does_not_run_inline_indexing() -> None:
    root = Path(__file__).resolve().parents[1]
    runtime = (root / "src" / "script_organizer" / "semantic_runtime.py").read_text(encoding="utf-8")
    status = (root / "desktop" / "src" / "features" / "status" / "StatusCenterWorkbench.tsx").read_text(encoding="utf-8")

    assert 'SEMANTIC_TASK_TYPE = "semantic_index"' in runtime
    assert '"background_task": SEMANTIC_TASK_TYPE' in runtime
    assert "refresh_semantic_index_background" in runtime
    assert runtime.count("refresh=False") >= 4
    assert "maybe_schedule_bootstrap" not in runtime
    assert 'semantic_index: "语义索引"' in status
    assert "语义索引与 Audit" in status
