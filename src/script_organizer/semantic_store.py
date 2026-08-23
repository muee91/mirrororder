from __future__ import annotations

import json
import math
import sqlite3
import struct
from datetime import datetime, timezone
from typing import Any, Iterable, Sequence

from .workspace_db import WorkspaceDatabase


SEMANTIC_STORE_CONTRACT = "semantic_index.v1"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _pack(vector: Sequence[float] | None) -> tuple[bytes | None, int]:
    if not vector:
        return None, 0
    values = [float(value) for value in vector]
    if not values or len(values) > 16384 or any(not math.isfinite(value) for value in values):
        return None, 0
    return struct.pack(f"<{len(values)}f", *values), len(values)


def _unpack(value: object, dimensions: object) -> list[float]:
    if not isinstance(value, (bytes, bytearray, memoryview)):
        return []
    try:
        count = int(dimensions or 0)
    except (TypeError, ValueError):
        return []
    raw = bytes(value)
    if count <= 0 or len(raw) != count * 4:
        return []
    try:
        return list(struct.unpack(f"<{count}f", raw))
    except struct.error:
        return []


class SemanticStore:
    """Rebuildable semantic documents inside the device-local workspace DB.

    Shared project JSON remains authoritative. This store contains only derived
    search text, optional embeddings and safe media identities. It deliberately
    never stores device-local media paths.
    """

    def __init__(self, database: WorkspaceDatabase):
        self.database = database
        self._fts_token = False
        self._fts_trigram = False
        self._initialize()

    def _initialize(self) -> None:
        with self.database.connection() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS semantic_documents (
                    project_id TEXT NOT NULL,
                    document_id TEXT NOT NULL,
                    group_id TEXT NOT NULL DEFAULT '',
                    clip_id TEXT NOT NULL DEFAULT '',
                    media_id TEXT NOT NULL DEFAULT '',
                    source TEXT NOT NULL,
                    start REAL NOT NULL DEFAULT 0,
                    end REAL NOT NULL DEFAULT 0,
                    text TEXT NOT NULL,
                    metadata_json TEXT NOT NULL DEFAULT '{}',
                    content_fingerprint TEXT NOT NULL DEFAULT '',
                    embedding BLOB,
                    embedding_dim INTEGER NOT NULL DEFAULT 0,
                    embedding_model TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(project_id, document_id)
                );
                CREATE INDEX IF NOT EXISTS semantic_documents_by_project
                    ON semantic_documents(project_id, source, group_id);
                CREATE INDEX IF NOT EXISTS semantic_documents_by_embedding
                    ON semantic_documents(project_id, embedding_model);
                """
            )
            try:
                connection.execute(
                    """
                    CREATE VIRTUAL TABLE IF NOT EXISTS semantic_documents_fts
                    USING fts5(document_id UNINDEXED, project_id UNINDEXED, source UNINDEXED, text, tokenize='unicode61')
                    """
                )
                self._fts_token = True
            except sqlite3.OperationalError:
                self._fts_token = False
            try:
                connection.execute(
                    """
                    CREATE VIRTUAL TABLE IF NOT EXISTS semantic_documents_trigram
                    USING fts5(document_id UNINDEXED, project_id UNINDEXED, source UNINDEXED, text, tokenize='trigram')
                    """
                )
                self._fts_trigram = True
            except sqlite3.OperationalError:
                self._fts_trigram = False
            connection.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES('semantic_store_contract', ?)",
                (SEMANTIC_STORE_CONTRACT,),
            )
            connection.commit()

    @staticmethod
    def _safe_document(raw: dict[str, Any]) -> dict[str, Any]:
        text = str(raw.get("text", "") or "").strip()[:20000]
        return {
            "document_id": str(raw.get("document_id", "") or "")[:200],
            "group_id": str(raw.get("group_id", "") or "")[:160],
            "clip_id": str(raw.get("clip_id", "") or "")[:160],
            "media_id": str(raw.get("media_id", "") or "")[:160],
            "source": str(raw.get("source", "") or "")[:40],
            "start": max(0.0, float(raw.get("start", 0) or 0)),
            "end": max(0.0, float(raw.get("end", 0) or 0)),
            "text": text,
            "metadata": raw.get("metadata", {}) if isinstance(raw.get("metadata"), dict) else {},
            "content_fingerprint": str(raw.get("content_fingerprint", "") or "")[:160],
            "embedding": raw.get("embedding") if isinstance(raw.get("embedding"), list) else None,
            "embedding_model": str(raw.get("embedding_model", "") or "")[:400],
        }

    def _delete_ids(self, connection: sqlite3.Connection, project_id: str, document_ids: Sequence[str]) -> None:
        ids = [str(value) for value in document_ids if str(value)]
        if not ids:
            return
        placeholders = ",".join("?" for _ in ids)
        parameters = [project_id, *ids]
        connection.execute(
            f"DELETE FROM semantic_documents WHERE project_id=? AND document_id IN ({placeholders})",
            parameters,
        )
        if self._fts_token:
            connection.execute(
                f"DELETE FROM semantic_documents_fts WHERE project_id=? AND document_id IN ({placeholders})",
                parameters,
            )
        if self._fts_trigram:
            connection.execute(
                f"DELETE FROM semantic_documents_trigram WHERE project_id=? AND document_id IN ({placeholders})",
                parameters,
            )

    def replace_documents(
        self,
        project_id: str,
        source: str,
        documents: Iterable[dict[str, Any]],
        *,
        group_ids: Sequence[str] | None = None,
    ) -> dict[str, int]:
        project_id = str(project_id or "")
        source = str(source or "")
        if not project_id or not source:
            raise ValueError("semantic documents require project_id and source")
        safe = [self._safe_document(row) for row in documents if isinstance(row, dict)]
        safe = [row for row in safe if row["document_id"] and row["text"] and row["source"] == source]
        incoming = {row["document_id"] for row in safe}
        requested_groups = {str(value) for value in (group_ids or []) if str(value)}
        now = _now()
        with self.database.connection() as connection:
            if requested_groups:
                placeholders = ",".join("?" for _ in requested_groups)
                rows = connection.execute(
                    f"SELECT document_id FROM semantic_documents WHERE project_id=? AND source=? AND group_id IN ({placeholders})",
                    [project_id, source, *sorted(requested_groups)],
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT document_id FROM semantic_documents WHERE project_id=? AND source=?",
                    (project_id, source),
                ).fetchall()
            existing = {str(row[0]) for row in rows}
            stale = sorted(existing - incoming)
            self._delete_ids(connection, project_id, stale)

            changed = 0
            unchanged = 0
            for row in safe:
                current = connection.execute(
                    "SELECT content_fingerprint, embedding_model, embedding_dim FROM semantic_documents WHERE project_id=? AND document_id=?",
                    (project_id, row["document_id"]),
                ).fetchone()
                embedding_blob, embedding_dim = _pack(row["embedding"])
                if (
                    current is not None
                    and str(current["content_fingerprint"] or "") == row["content_fingerprint"]
                    and str(current["embedding_model"] or "") == row["embedding_model"]
                    and (not row["embedding_model"] or int(current["embedding_dim"] or 0) == embedding_dim)
                ):
                    unchanged += 1
                    continue
                self._delete_ids(connection, project_id, [row["document_id"]])
                connection.execute(
                    """
                    INSERT INTO semantic_documents(
                        project_id, document_id, group_id, clip_id, media_id,
                        source, start, end, text, metadata_json,
                        content_fingerprint, embedding, embedding_dim,
                        embedding_model, updated_at
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        project_id,
                        row["document_id"],
                        row["group_id"],
                        row["clip_id"],
                        row["media_id"],
                        source,
                        row["start"],
                        row["end"],
                        row["text"],
                        _json(row["metadata"]),
                        row["content_fingerprint"],
                        embedding_blob,
                        embedding_dim,
                        row["embedding_model"],
                        now,
                    ),
                )
                if self._fts_token:
                    connection.execute(
                        "INSERT INTO semantic_documents_fts(document_id, project_id, source, text) VALUES(?, ?, ?, ?)",
                        (row["document_id"], project_id, source, row["text"]),
                    )
                if self._fts_trigram:
                    connection.execute(
                        "INSERT INTO semantic_documents_trigram(document_id, project_id, source, text) VALUES(?, ?, ?, ?)",
                        (row["document_id"], project_id, source, row["text"]),
                    )
                changed += 1
            connection.commit()
        return {"documents": len(safe), "changed": changed, "unchanged": unchanged, "removed": len(stale)}

    @staticmethod
    def _row(row: sqlite3.Row) -> dict[str, Any]:
        try:
            metadata = json.loads(str(row["metadata_json"] or "{}"))
        except ValueError:
            metadata = {}
        result = {
            "document_id": str(row["document_id"]),
            "group_id": str(row["group_id"] or ""),
            "clip_id": str(row["clip_id"] or ""),
            "media_id": str(row["media_id"] or ""),
            "source": str(row["source"]),
            "start": float(row["start"] or 0),
            "end": float(row["end"] or 0),
            "text": str(row["text"] or ""),
            "metadata": metadata if isinstance(metadata, dict) else {},
            "content_fingerprint": str(row["content_fingerprint"] or ""),
            "embedding_model": str(row["embedding_model"] or ""),
            "embedding": _unpack(row["embedding"], row["embedding_dim"]),
            "updated_at": str(row["updated_at"] or ""),
        }
        return result

    def documents(
        self,
        project_id: str,
        *,
        sources: Sequence[str] | None = None,
        embedding_model: str | None = None,
    ) -> list[dict[str, Any]]:
        clauses = ["project_id=?"]
        parameters: list[Any] = [project_id]
        selected_sources = [str(value) for value in (sources or []) if str(value)]
        if selected_sources:
            placeholders = ",".join("?" for _ in selected_sources)
            clauses.append(f"source IN ({placeholders})")
            parameters.extend(selected_sources)
        if embedding_model is not None:
            clauses.append("embedding_model=?")
            parameters.append(embedding_model)
        with self.database.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM semantic_documents WHERE " + " AND ".join(clauses) + " ORDER BY source, group_id, document_id",
                parameters,
            ).fetchall()
        return [self._row(row) for row in rows]

    @staticmethod
    def _fts_query(text: str) -> str:
        # Quote user text so FTS operators in natural-language questions are not
        # interpreted as query syntax. Trigram FTS still performs substring-like
        # recall for CJK text inside a quoted phrase.
        value = str(text or "").strip().replace('"', ' ')
        return f'"{value}"' if value else ""

    def keyword_search(self, project_id: str, query: str, *, limit: int = 80) -> list[dict[str, Any]]:
        needle = str(query or "").strip()
        if not needle:
            return []
        limit = max(1, min(300, int(limit)))
        document_ids: list[str] = []
        seen: set[str] = set()
        fts_query = self._fts_query(needle)
        with self.database.connection() as connection:
            for table, enabled in (
                ("semantic_documents_trigram", self._fts_trigram),
                ("semantic_documents_fts", self._fts_token),
            ):
                if not enabled or not fts_query:
                    continue
                try:
                    rows = connection.execute(
                        f"SELECT document_id FROM {table} WHERE project_id=? AND {table} MATCH ? ORDER BY bm25({table}) LIMIT ?",
                        (project_id, fts_query, limit),
                    ).fetchall()
                except sqlite3.OperationalError:
                    continue
                for row in rows:
                    document_id = str(row[0])
                    if document_id not in seen:
                        seen.add(document_id)
                        document_ids.append(document_id)
                        if len(document_ids) >= limit:
                            break
                if len(document_ids) >= limit:
                    break

            if len(document_ids) < limit:
                like = f"%{needle}%"
                rows = connection.execute(
                    "SELECT document_id FROM semantic_documents WHERE project_id=? AND text LIKE ? ORDER BY updated_at DESC LIMIT ?",
                    (project_id, like, limit),
                ).fetchall()
                for row in rows:
                    document_id = str(row[0])
                    if document_id not in seen:
                        seen.add(document_id)
                        document_ids.append(document_id)
                        if len(document_ids) >= limit:
                            break
            if not document_ids:
                return []
            placeholders = ",".join("?" for _ in document_ids)
            rows = connection.execute(
                f"SELECT * FROM semantic_documents WHERE project_id=? AND document_id IN ({placeholders})",
                [project_id, *document_ids],
            ).fetchall()
        by_id = {str(row["document_id"]): self._row(row) for row in rows}
        return [by_id[document_id] for document_id in document_ids if document_id in by_id]

    def summary(self, project_id: str) -> dict[str, Any]:
        with self.database.connection() as connection:
            rows = connection.execute(
                "SELECT source, COUNT(*) AS count, SUM(CASE WHEN embedding_dim > 0 THEN 1 ELSE 0 END) AS vectors FROM semantic_documents WHERE project_id=? GROUP BY source",
                (project_id,),
            ).fetchall()
        sources = {str(row["source"]): int(row["count"] or 0) for row in rows}
        vectors = sum(int(row["vectors"] or 0) for row in rows)
        return {
            "contract": SEMANTIC_STORE_CONTRACT,
            "documents": sum(sources.values()),
            "vectors": vectors,
            "sources": sources,
            "fts": bool(self._fts_token or self._fts_trigram),
            "trigram": bool(self._fts_trigram),
            "device_local": True,
            "rebuildable": True,
        }
