from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from .semantic_index import ProjectSemanticIndexer, SEMANTIC_SOURCES


FRAME_SOURCE = "frame"
BACKGROUND_SEMANTIC_SOURCES = set(SEMANTIC_SOURCES) | {FRAME_SOURCE}
ProgressCallback = Callable[[int, int, str], None]
CancelCallback = Callable[[], bool]


def _cancelled(callback: CancelCallback | None) -> bool:
    try:
        return bool(callback and callback())
    except Exception:
        return False


def _frame_documents(
    indexer: ProjectSemanticIndexer,
    groups: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    config = getattr(indexer.encoder, "config", None)
    if not bool(getattr(indexer.encoder, "enabled", False)) or str(getattr(config, "profile", "")) != "standard":
        return []
    if not hasattr(indexer.encoder, "encode_multimodal"):
        return []

    documents: list[dict[str, Any]] = []
    for group_id, group in groups.items():
        members = [row for row in group.get("members", []) if isinstance(row, dict)]
        by_clip = {str(row.get("clip_id", "") or ""): row for row in members}
        for frame in indexer.database.frames(indexer.project_id, group_id):
            path = Path(str(frame.get("path", "") or ""))
            if not path.is_file():
                continue
            frame_id = str(frame.get("frame_id", "") or "")
            clip_id = str(frame.get("clip_id", "") or "")
            if not frame_id:
                continue
            member = by_clip.get(clip_id, {})
            source_time = float(frame.get("source_time", 0) or 0)
            source_start = float(member.get("source_start", 0) or 0) if isinstance(member, dict) else 0.0
            relative_time = max(0.0, source_time - source_start)
            camera = str(frame.get("camera", "") or (member.get("camera", "") if isinstance(member, dict) else ""))
            try:
                image_sha = hashlib.sha1(path.read_bytes()).hexdigest()
            except OSError:
                continue
            metadata = {
                "evidence": "representative_frame",
                "frame_id": frame_id,
                "camera": camera,
                "reason": str(frame.get("reason", "") or ""),
                "time_basis": "take_relative",
            }
            fingerprint = hashlib.sha1(
                f"{frame_id}|{image_sha}|{relative_time:.3f}|{camera}".encode("utf-8")
            ).hexdigest()
            documents.append(
                {
                    "document_id": f"sem_frame_{hashlib.sha1(f'{indexer.project_id}|{frame_id}'.encode('utf-8')).hexdigest()[:24]}",
                    "group_id": group_id,
                    "clip_id": clip_id,
                    "media_id": str(member.get("media_id", "") or "") if isinstance(member, dict) else "",
                    "source": FRAME_SOURCE,
                    "start": relative_time,
                    "end": relative_time,
                    # SemanticStore requires safe display text. The image path is
                    # deliberately transient and is stripped before persistence.
                    "text": f"代表帧 · {camera or 'camera'} · {relative_time:.2f}s",
                    "metadata": metadata,
                    "content_fingerprint": fingerprint,
                    "_embedding_input": {"image": str(path)},
                }
            )
    return documents


def _prepare_documents(
    indexer: ProjectSemanticIndexer,
    *,
    group_ids: Sequence[str] | None,
    sources: Iterable[str] | None,
) -> list[tuple[str, list[dict[str, Any]]]]:
    selected_sources = {str(value) for value in (sources or BACKGROUND_SEMANTIC_SOURCES) if str(value)}
    unknown = selected_sources - BACKGROUND_SEMANTIC_SOURCES
    if unknown:
        raise ValueError("unknown semantic sources: " + ", ".join(sorted(unknown)))
    groups = indexer._selected_groups(group_ids)
    prepared: list[tuple[str, list[dict[str, Any]]]] = []
    for source in sorted(selected_sources):
        if source == "visual":
            documents = indexer._visual_documents(groups)
        elif source == "speech":
            documents = indexer._speech_documents(groups)
        elif source == "slate":
            documents = indexer._slate_documents(group_ids)
        else:
            documents = _frame_documents(indexer, groups)
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
        if source == FRAME_SOURCE:
            inputs = [row.get("_embedding_input") for row in batch]
            vectors = indexer.encoder.encode_multimodal(inputs)
        else:
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
    """Refresh text and representative-frame semantic evidence in background.

    No new VLM inference occurs here. Existing device-local perception frames are
    read only while encoding and their filesystem paths are never persisted into
    SemanticStore. Embedding is bounded and cancellation-aware between batches;
    partially completed vectors remain usable and every textual evidence source
    keeps its FTS fallback.
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

        done = sum(len(rows) for _name, rows in prepared[: len(reports)])
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
            "representative_frames_only": True,
            "device_local": True,
            "device_paths_persisted": False,
            "review_write": False,
            "editorial_write": False,
            "automatic_write": False,
        },
    }
