from __future__ import annotations

from typing import Any, Callable, Iterable, Sequence

from .semantic_index import ProjectSemanticIndexer, SEMANTIC_SOURCES


ProgressCallback = Callable[[int, int, str], None]
CancelCallback = Callable[[], bool]


def _cancelled(callback: CancelCallback | None) -> bool:
    try:
        return bool(callback and callback())
    except Exception:
        return False


def _prepare_documents(
    indexer: ProjectSemanticIndexer,
    *,
    group_ids: Sequence[str] | None,
    sources: Iterable[str] | None,
) -> list[tuple[str, list[dict[str, Any]]]]:
    selected_sources = {str(value) for value in (sources or SEMANTIC_SOURCES) if str(value)}
    unknown = selected_sources - SEMANTIC_SOURCES
    if unknown:
        raise ValueError("unknown semantic sources: " + ", ".join(sorted(unknown)))
    groups = indexer._selected_groups(group_ids)
    prepared: list[tuple[str, list[dict[str, Any]]]] = []
    for source in sorted(selected_sources):
        if source == "visual":
            documents = indexer._visual_documents(groups)
        elif source == "speech":
            documents = indexer._speech_documents(groups)
        else:
            documents = indexer._slate_documents(group_ids)
        prepared.append((source, documents))
    return prepared


def _attach_embeddings_incrementally(
    indexer: ProjectSemanticIndexer,
    source: str,
    documents: list[dict[str, Any]],
    *,
    completed_before: int,
    total: int,
    progress: ProgressCallback | None,
    cancelled: CancelCallback | None,
    batch_size: int,
) -> dict[str, Any]:
    existing = {
        row["document_id"]: row
        for row in indexer.store.documents(indexer.project_id, sources=[source])
    }
    pending: list[dict[str, Any]] = []
    settled = 0
    for document in documents:
        current = existing.get(document["document_id"])
        if (
            current
            and current.get("content_fingerprint") == document.get("content_fingerprint")
            and current.get("embedding")
        ):
            if not indexer.encoder.enabled or current.get("embedding_model") == indexer.encoder.identity:
                document["embedding"] = current["embedding"]
                document["embedding_model"] = current.get("embedding_model", "")
                settled += 1
                continue
        if indexer.encoder.enabled:
            pending.append(document)
        else:
            settled += 1

    if progress:
        progress(completed_before + settled, total, source)

    encoded = 0
    failed = False
    was_cancelled = False
    size = max(1, min(128, int(batch_size)))
    for offset in range(0, len(pending), size):
        if _cancelled(cancelled):
            was_cancelled = True
            break
        batch = pending[offset : offset + size]
        vectors = indexer.encoder.encode([str(row.get("text", "") or "") for row in batch])
        if vectors is None or len(vectors) != len(batch):
            failed = True
            break
        for row, vector in zip(batch, vectors):
            row["embedding"] = vector
            row["embedding_model"] = indexer.encoder.identity
            encoded += 1
        if progress:
            progress(completed_before + settled + encoded, total, source)

    return {
        "encoder_enabled": bool(indexer.encoder.enabled),
        "encoded": encoded,
        "reused_or_lexical": settled,
        "embedding_failed": failed,
        "cancelled": was_cancelled,
    }


def refresh_semantic_index_background(
    indexer: ProjectSemanticIndexer,
    *,
    group_ids: Sequence[str] | None = None,
    sources: Iterable[str] | None = None,
    progress: ProgressCallback | None = None,
    cancelled: CancelCallback | None = None,
    batch_size: int = 32,
) -> dict[str, Any]:
    """Refresh semantic documents without hiding expensive work in a search request.

    Document construction is cheap/rebuildable and never performs new VLM
    inference. Embedding is processed in bounded batches with cancellation
    checks between batches. Any already completed vectors are persisted when a
    user cancels, while unfinished documents remain available to lexical FTS.
    """

    prepared = _prepare_documents(indexer, group_ids=group_ids, sources=sources)
    total = sum(len(documents) for _source, documents in prepared)
    done = 0
    reports: dict[str, Any] = {}
    if progress:
        progress(0, total, "preparing")

    for source, documents in prepared:
        if _cancelled(cancelled):
            return {
                "contract": "semantic_refresh.v2",
                "project_id": indexer.project_id,
                "sources": reports,
                "index": indexer.store.summary(indexer.project_id),
                "encoder": indexer.encoder.config.public(),
                "cancelled": True,
                "progress": {"done": done, "total": total},
            }

        embedding = _attach_embeddings_incrementally(
            indexer,
            source,
            documents,
            completed_before=done,
            total=total,
            progress=progress,
            cancelled=cancelled,
            batch_size=batch_size,
        )
        scope = list(group_ids or []) if source != "slate" or group_ids else None
        persisted = indexer.store.replace_documents(
            indexer.project_id,
            source,
            documents,
            group_ids=scope,
        )
        reports[source] = {**persisted, **embedding}

        processed = int(embedding.get("reused_or_lexical", 0) or 0) + int(embedding.get("encoded", 0) or 0)
        done += min(len(documents), processed)
        if embedding.get("cancelled"):
            return {
                "contract": "semantic_refresh.v2",
                "project_id": indexer.project_id,
                "sources": reports,
                "index": indexer.store.summary(indexer.project_id),
                "encoder": indexer.encoder.config.public(),
                "cancelled": True,
                "progress": {"done": done, "total": total},
            }
        if embedding.get("embedding_failed"):
            return {
                "contract": "semantic_refresh.v2",
                "project_id": indexer.project_id,
                "sources": reports,
                "index": indexer.store.summary(indexer.project_id),
                "encoder": indexer.encoder.config.public(),
                "cancelled": False,
                "embedding_failed": True,
                "progress": {"done": done, "total": total},
            }

        done = sum(len(rows) for name, rows in prepared[: len(reports)])
        if progress:
            progress(done, total, source)

    return {
        "contract": "semantic_refresh.v2",
        "project_id": indexer.project_id,
        "sources": reports,
        "index": indexer.store.summary(indexer.project_id),
        "encoder": indexer.encoder.config.public(),
        "cancelled": False,
        "embedding_failed": False,
        "progress": {"done": total, "total": total},
        "semantics": {
            "new_vlm_inference": False,
            "device_local": True,
            "review_write": False,
            "editorial_write": False,
            "automatic_write": False,
        },
    }
