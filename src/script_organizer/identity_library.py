from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Sequence

from .workspace_db import WorkspaceDatabase


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _json_object(value: object) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    try:
        decoded = json.loads(str(value or "{}"))
    except ValueError:
        return {}
    return dict(decoded) if isinstance(decoded, dict) else {}


class IdentityLibrary:
    """App-only management layer over device-local actor/speaker identities.

    Embedding blobs never leave the workspace database through this API. Human
    labels and role names are durable local metadata and are preserved across
    automatic re-indexing.
    """

    def __init__(self, database: WorkspaceDatabase, project_id: str):
        self.database = database
        self.project_id = str(project_id or "").strip()
        if not self.project_id:
            raise ValueError("project_id 不能为空")
        self._install_confirmation_guard()

    def _install_confirmation_guard(self) -> None:
        """Prevent automatic cluster upserts from clobbering human labels.

        IdentityIndexer marks its automatically-created rows with auto_cluster.
        A row touched through this library is marked human_confirmed. SQLite
        then ignores future automatic UPDATE branches for that identity while
        observations/centroids remain free to refresh.
        """
        with self.database.connection() as connection:
            connection.execute(
                """
                CREATE TRIGGER IF NOT EXISTS protect_human_identity_labels
                BEFORE UPDATE OF label, role_name, metadata_json ON identities
                WHEN COALESCE(json_extract(OLD.metadata_json, '$.human_confirmed'), 0) = 1
                 AND COALESCE(json_extract(NEW.metadata_json, '$.auto_cluster'), 0) = 1
                BEGIN
                    SELECT RAISE(IGNORE);
                END
                """
            )
            connection.commit()

    def list(self, kind: str = "") -> list[dict[str, Any]]:
        if kind and kind not in {"face", "speaker"}:
            raise ValueError("identity kind 必须是 face 或 speaker")
        clause = "AND i.kind=?" if kind else ""
        parameters: tuple[Any, ...] = (self.project_id, kind) if kind else (self.project_id,)
        with self.database.connection() as connection:
            rows = connection.execute(
                f"""
                SELECT i.identity_id, i.kind, i.label, i.role_name, i.metadata_json,
                       i.created_at, i.updated_at,
                       COUNT(o.observation_id) AS observation_count,
                       AVG(o.confidence) AS average_confidence,
                       COUNT(DISTINCT o.group_id) AS take_count,
                       MIN(o.group_id) AS example_group_id
                FROM identities AS i
                LEFT JOIN identity_observations AS o
                  ON o.project_id=i.project_id AND o.identity_id=i.identity_id
                WHERE i.project_id=? {clause}
                GROUP BY i.identity_id
                ORDER BY i.kind, observation_count DESC, i.created_at, i.identity_id
                """,
                parameters,
            ).fetchall()
        result = []
        for row in rows:
            metadata = _json_object(row["metadata_json"])
            result.append(
                {
                    "identity_id": str(row["identity_id"]),
                    "kind": str(row["kind"]),
                    "label": str(row["label"] or ""),
                    "role_name": str(row["role_name"] or ""),
                    "observation_count": int(row["observation_count"] or 0),
                    "take_count": int(row["take_count"] or 0),
                    "average_confidence": float(row["average_confidence"] or 0),
                    "example_group_id": str(row["example_group_id"] or ""),
                    "confirmed": bool(metadata.get("human_confirmed")),
                    "created_at": str(row["created_at"] or ""),
                    "updated_at": str(row["updated_at"] or ""),
                }
            )
        return result

    def get(self, identity_id: str) -> dict[str, Any]:
        identity_id = str(identity_id or "")
        for row in self.list():
            if row["identity_id"] == identity_id:
                return row
        raise KeyError(identity_id)

    def update(self, identity_id: str, *, label: str, role_name: str) -> dict[str, Any]:
        identity_id = str(identity_id or "").strip()
        if not identity_id:
            raise ValueError("identity_id 不能为空")
        label = str(label or "").strip()[:120]
        role_name = str(role_name or "").strip()[:120]
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT metadata_json FROM identities
                WHERE project_id=? AND identity_id=?
                """,
                (self.project_id, identity_id),
            ).fetchone()
            if row is None:
                raise KeyError(identity_id)
            metadata = _json_object(row["metadata_json"])
            metadata["human_confirmed"] = True
            metadata["human_updated_at"] = _now()
            connection.execute(
                """
                UPDATE identities
                SET label=?, role_name=?, metadata_json=?, updated_at=?
                WHERE project_id=? AND identity_id=?
                """,
                (
                    label,
                    role_name,
                    json.dumps(metadata, ensure_ascii=False, separators=(",", ":"), sort_keys=True),
                    _now(),
                    self.project_id,
                    identity_id,
                ),
            )
            connection.commit()
        return self.get(identity_id)

    def merge(
        self,
        target_identity_id: str,
        source_identity_ids: Sequence[str],
    ) -> dict[str, Any]:
        target = str(target_identity_id or "").strip()
        sources = [
            str(value).strip()
            for value in source_identity_ids
            if str(value).strip() and str(value).strip() != target
        ]
        sources = list(dict.fromkeys(sources))
        if not target or not sources:
            raise ValueError("合并需要一个目标身份和至少一个来源身份")
        with self.database.connection() as connection:
            target_row = connection.execute(
                "SELECT kind FROM identities WHERE project_id=? AND identity_id=?",
                (self.project_id, target),
            ).fetchone()
            if target_row is None:
                raise KeyError(target)
            kind = str(target_row["kind"])
            placeholders = ",".join("?" for _ in sources)
            rows = connection.execute(
                f"""
                SELECT identity_id, kind FROM identities
                WHERE project_id=? AND identity_id IN ({placeholders})
                """,
                (self.project_id, *sources),
            ).fetchall()
            found = {str(row["identity_id"]): str(row["kind"]) for row in rows}
            missing = [value for value in sources if value not in found]
            if missing:
                raise KeyError(",".join(missing))
            if any(found[value] != kind for value in sources):
                raise ValueError("只能合并同一种身份类型")
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                f"""
                UPDATE identity_observations
                SET identity_id=?
                WHERE project_id=? AND identity_id IN ({placeholders})
                """,
                (target, self.project_id, *sources),
            )
            connection.execute(
                f"""
                DELETE FROM identities
                WHERE project_id=? AND identity_id IN ({placeholders})
                """,
                (self.project_id, *sources),
            )
            connection.execute(
                "UPDATE identities SET updated_at=? WHERE project_id=? AND identity_id=?",
                (_now(), self.project_id, target),
            )
            connection.commit()
        return self.get(target)

    def group_identities(self, group_id: str) -> dict[str, list[dict[str, Any]]]:
        """Return identity evidence for matcher/App use, never raw embeddings."""
        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT o.kind, o.identity_id, o.confidence, o.start, o.end,
                       i.label, i.role_name, i.metadata_json
                FROM identity_observations AS o
                LEFT JOIN identities AS i
                  ON i.project_id=o.project_id AND i.identity_id=o.identity_id
                WHERE o.project_id=? AND o.group_id=?
                ORDER BY o.kind, o.confidence DESC, o.observation_id
                """,
                (self.project_id, str(group_id)),
            ).fetchall()
        result: dict[str, list[dict[str, Any]]] = {"face": [], "speaker": []}
        for row in rows:
            kind = str(row["kind"])
            if kind not in result:
                continue
            metadata = _json_object(row["metadata_json"])
            result[kind].append(
                {
                    "identity_id": str(row["identity_id"] or ""),
                    "label": str(row["label"] or ""),
                    "role_name": str(row["role_name"] or ""),
                    "confidence": float(row["confidence"] or 0),
                    "start": float(row["start"] or 0),
                    "end": float(row["end"] or 0),
                    "confirmed": bool(metadata.get("human_confirmed")),
                }
            )
        return result
