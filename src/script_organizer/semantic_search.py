from __future__ import annotations

import math
from typing import Any, Sequence

from .config import ProjectConfig
from .semantic_encoder import SemanticEncoder
from .semantic_index import ProjectSemanticIndexer
from .semantic_store import SemanticStore
from .workspace_db import WorkspaceDatabase


SEMANTIC_SEARCH_CONTRACT = "semantic_search.v1"
SOURCE_LABELS = {
    "visual": "画面",
    "speech": "对白",
    "slate": "场记",
}


def _dot(left: Sequence[float], right: Sequence[float]) -> float:
    if not left or len(left) != len(right):
        return -1.0
    value = sum(a * b for a, b in zip(left, right))
    return value if math.isfinite(value) else -1.0


def _snippet(text: str, query: str, limit: int = 320) -> str:
    value = " ".join(str(text or "").split())
    if len(value) <= limit:
        return value
    needle = str(query or "").strip().casefold()
    position = value.casefold().find(needle) if needle else -1
    if position < 0:
        return value[: limit - 1] + "…"
    start = max(0, position - limit // 3)
    end = min(len(value), start + limit)
    prefix = "…" if start else ""
    suffix = "…" if end < len(value) else ""
    return prefix + value[start:end] + suffix


class SemanticSearcher:
    """Hybrid retrieval over visual, speech and human slate evidence."""

    def __init__(
        self,
        workspace_id: str,
        project_id: str,
        config: ProjectConfig,
        *,
        database: WorkspaceDatabase | None = None,
        encoder: SemanticEncoder | None = None,
    ):
        self.workspace_id = str(workspace_id or "")
        self.project_id = str(project_id or "")
        self.config = config
        self.database = database or WorkspaceDatabase(self.workspace_id)
        self.store = SemanticStore(self.database)
        self.encoder = encoder or SemanticEncoder()

    def _refresh(self) -> dict[str, Any]:
        indexer = ProjectSemanticIndexer(
            self.workspace_id,
            self.project_id,
            self.config,
            database=self.database,
            encoder=self.encoder,
        )
        return indexer.refresh()

    def search(
        self,
        query: str,
        *,
        limit: int = 16,
        sources: Sequence[str] | None = None,
        refresh: bool = True,
        allow_query_embedding: bool = True,
    ) -> dict[str, Any]:
        """Hybrid retrieval over cached production evidence.

        ``allow_query_embedding=False`` is mandatory on GET read paths: a page
        request must never run provider/network inference. Blocked searches
        keep the deterministic keyword/FTS recall and simply lose the vector
        contribution. Explicit AI flows (assistant / agent tools) keep the
        default so query embeddings stay evidence for a user-invoked action.
        """
        text = str(query or "").strip()[:1000]
        if not text:
            raise ValueError("语义搜索内容不能为空")
        limit = max(1, min(60, int(limit)))
        selected_sources = {str(value) for value in (sources or []) if str(value)}
        refresh_report: dict[str, Any] = {}
        if refresh:
            refresh_report = self._refresh()

        keyword_rows = self.store.keyword_search(self.project_id, text, limit=max(80, limit * 6))
        if selected_sources:
            keyword_rows = [row for row in keyword_rows if row.get("source") in selected_sources]
        keyword_rank = {row["document_id"]: rank for rank, row in enumerate(keyword_rows, start=1)}

        query_vector: list[float] | None = None
        vector_rows: list[tuple[dict[str, Any], float]] = []
        if allow_query_embedding and self.encoder.enabled:
            query_vector = self.encoder.encode_one(text)
            if query_vector:
                documents = self.store.documents(
                    self.project_id,
                    sources=sorted(selected_sources) if selected_sources else None,
                    embedding_model=self.encoder.identity,
                )
                for document in documents:
                    vector = document.get("embedding", [])
                    score = _dot(query_vector, vector if isinstance(vector, list) else [])
                    if score > -0.5:
                        vector_rows.append((document, score))
                vector_rows.sort(key=lambda item: (-item[1], item[0]["document_id"]))
                vector_rows = vector_rows[: max(80, limit * 6)]
        vector_rank = {row["document_id"]: rank for rank, (row, _score) in enumerate(vector_rows, start=1)}
        vector_score = {row["document_id"]: score for row, score in vector_rows}

        all_rows: dict[str, dict[str, Any]] = {row["document_id"]: row for row in keyword_rows}
        all_rows.update({row["document_id"]: row for row, _score in vector_rows})
        fused: list[tuple[float, dict[str, Any]]] = []
        for document_id, row in all_rows.items():
            score = 0.0
            if document_id in vector_rank:
                score += 1.0 / (60.0 + vector_rank[document_id])
            if document_id in keyword_rank:
                score += 0.85 / (60.0 + keyword_rank[document_id])
            # Exact natural-language phrase is useful evidence but is not called
            # model confidence. It only provides a small deterministic ranking boost.
            exact = text.casefold() in str(row.get("text", "")).casefold()
            if exact:
                score += 0.008
            fused.append((score, row))
        fused.sort(key=lambda item: (-item[0], item[1].get("source", ""), item[1].get("group_id", "")))

        results = []
        for score, row in fused[:limit]:
            document_id = str(row.get("document_id", "") or "")
            results.append(
                {
                    "document_id": document_id,
                    "group_id": str(row.get("group_id", "") or ""),
                    "clip_id": str(row.get("clip_id", "") or ""),
                    "media_id": str(row.get("media_id", "") or ""),
                    "source": str(row.get("source", "") or ""),
                    "source_label": SOURCE_LABELS.get(str(row.get("source", "")), str(row.get("source", ""))),
                    "score": round(score, 8),
                    "vector_similarity": (
                        round(float(vector_score[document_id]), 6)
                        if document_id in vector_score else None
                    ),
                    "keyword_rank": keyword_rank.get(document_id),
                    "vector_rank": vector_rank.get(document_id),
                    "start": float(row.get("start", 0) or 0),
                    "end": float(row.get("end", 0) or 0),
                    "snippet": _snippet(str(row.get("text", "") or ""), text),
                    "metadata": row.get("metadata", {}) if isinstance(row.get("metadata"), dict) else {},
                }
            )

        mode = "hybrid" if query_vector and keyword_rows else "vector" if query_vector else "keyword"
        summary = self.store.summary(self.project_id)
        return {
            "contract": SEMANTIC_SEARCH_CONTRACT,
            "query": text,
            "mode": mode,
            "results": results,
            "summary": {
                "returned": len(results),
                "documents": int(summary.get("documents", 0) or 0),
                "vectors": int(summary.get("vectors", 0) or 0),
                "sources": summary.get("sources", {}),
                "fts": bool(summary.get("fts", False)),
                "vector_available": bool(query_vector),
            },
            "encoder": self.encoder.config.public(),
            "refresh": refresh_report,
            "semantics": {
                "read_only": True,
                "result_is_editorial_decision": False,
                "result_is_review_state": False,
                "device_paths_exposed": False,
                "keyword_fallback": True,
                "shared_encoder_for_documents_and_query": True,
                "read_path_blocks_query_embedding": not allow_query_embedding,
            },
        }


def safe_search_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Remove technical model details for Team Web / external consumers."""
    return {
        "contract": str(payload.get("contract", SEMANTIC_SEARCH_CONTRACT) or SEMANTIC_SEARCH_CONTRACT),
        "query": str(payload.get("query", "") or ""),
        "mode": str(payload.get("mode", "keyword") or "keyword"),
        "results": payload.get("results", []) if isinstance(payload.get("results"), list) else [],
        "summary": payload.get("summary", {}) if isinstance(payload.get("summary"), dict) else {},
        "semantics": payload.get("semantics", {}) if isinstance(payload.get("semantics"), dict) else {},
    }
