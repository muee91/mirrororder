from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
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

    _guard_lock = RLock()
    _guarded_databases: set[tuple[Path, int]] = set()

    def __init__(self, database: WorkspaceDatabase, project_id: str):
        self.database = database
        self.project_id = str(project_id or "").strip()
        if not self.project_id:
            raise ValueError("project_id 不能为空")
        self._install_confirmation_guard()

    def _install_confirmation_guard(self) -> None:
        """Prevent automatic cluster upserts from clobbering human labels."""
        database_path = self.database.path.resolve()
        database_key = (database_path, database_path.stat().st_ino)
        with self._guard_lock:
            if database_key in self._guarded_databases:
                return
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
            self._guarded_databases.add(database_key)

    def _refresh_mapping_rescue(self) -> None:
        """Re-evaluate derived local mapping evidence after human role edits.

        This is intentionally best-effort. Editing the local actor/voice library
        must never fail because project outputs are missing or the local
        intelligence layer is damaged.
        """
        try:
            with self.database.connection() as connection:
                row = connection.execute(
                    "SELECT config_path FROM projects WHERE project_id=? LIMIT 1",
                    (self.project_id,),
                ).fetchone()
            if row is None:
                return
            config_path = Path(str(row[0] or "")).expanduser()
            if not config_path.is_file():
                return
            from .config import ProjectConfig
            from .identity_rescue import apply_identity_rescue

            apply_identity_rescue(ProjectConfig.from_file(config_path))
        except Exception:
            return

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

        identity_ids = [str(row["identity_id"] or "") for row in rows]
        observations_by_identity: dict[str, list[sqlite3.Row]] = {
            identity_id: [] for identity_id in identity_ids if identity_id
        }
        if observations_by_identity:
            placeholders = ",".join("?" for _ in observations_by_identity)
            with self.database.connection() as connection:
                observations = connection.execute(
                    f"""
                    SELECT identity_id, group_id, clip_id, start, end, confidence,
                           observation_id, metadata_json
                    FROM identity_observations
                    WHERE project_id=? AND identity_id IN ({placeholders})
                    """,
                    (self.project_id, *observations_by_identity),
                ).fetchall()
            for observation in observations:
                identity_id = str(observation["identity_id"] or "")
                if identity_id in observations_by_identity:
                    observations_by_identity[identity_id].append(observation)

        result = []
        for row in rows:
            metadata = _json_object(row["metadata_json"])
            identity_id = str(row["identity_id"] or "")
            observations = observations_by_identity.get(identity_id, [])
            example = self._example_from_observations(observations)
            occurrences = self._occurrences_from_observations(observations)
            result.append(
                {
                    "identity_id": identity_id,
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
                    "example": example or None,
                    "occurrences": occurrences,
                }
            )
        return result

    @staticmethod
    def _occurrences_from_observations(observations: Sequence[sqlite3.Row]) -> list[dict[str, Any]]:
        ordered = sorted(
            observations,
            key=lambda row: (
                -float(row["confidence"] or 0),
                str(row["group_id"] or ""),
                float(row["start"] or 0),
                str(row["observation_id"] or ""),
            ),
        )
        result: list[dict[str, Any]] = []
        seen_groups: set[str] = set()
        for row in ordered:
            group_id = str(row["group_id"] or "")
            if not group_id or group_id in seen_groups:
                continue
            seen_groups.add(group_id)
            metadata = _json_object(row["metadata_json"])
            result.append(
                {
                    "group_id": group_id,
                    "clip_id": str(row["clip_id"] or ""),
                    "camera": str(metadata.get("camera", "") or ""),
                    "start": float(row["start"] or 0),
                    "end": float(row["end"] or 0),
                    "source_time": float(metadata.get("source_time", row["start"]) or 0),
                    "confidence": float(row["confidence"] or 0),
                    "transcript_text": str(metadata.get("text", "") or "")[:180],
                }
            )
            if len(result) >= 12:
                break
        return result

    def _occurrences(self, identity_id: str, limit: int = 12) -> list[dict[str, Any]]:
        """Return clustered Take evidence that can be opened in the workbench."""

        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT o.group_id, o.clip_id, o.start, o.end, o.confidence,
                       o.metadata_json
                FROM identity_observations AS o
                WHERE o.project_id=? AND o.identity_id=?
                ORDER BY o.confidence DESC, o.group_id, o.start, o.observation_id
                LIMIT ?
                """,
                (self.project_id, identity_id, max(1, min(60, int(limit)))),
            ).fetchall()
        result: list[dict[str, Any]] = []
        seen_groups: set[str] = set()
        for row in rows:
            group_id = str(row["group_id"] or "")
            if not group_id or group_id in seen_groups:
                continue
            seen_groups.add(group_id)
            metadata = _json_object(row["metadata_json"])
            result.append(
                {
                    "group_id": group_id,
                    "clip_id": str(row["clip_id"] or ""),
                    "camera": str(metadata.get("camera", "") or ""),
                    "start": float(row["start"] or 0),
                    "end": float(row["end"] or 0),
                    "source_time": float(metadata.get("source_time", row["start"]) or 0),
                    "confidence": float(row["confidence"] or 0),
                    "transcript_text": str(metadata.get("text", "") or "")[:180],
                }
            )
        return result

    @staticmethod
    def _example_from_observations(observations: Sequence[sqlite3.Row]) -> dict[str, Any]:
        if not observations:
            return {}
        row = min(
            observations,
            key=lambda item: (
                -float(item["confidence"] or 0),
                -(float(item["end"] or 0) - float(item["start"] or 0)),
                str(item["observation_id"] or ""),
            ),
        )
        metadata = _json_object(row["metadata_json"])
        return {
            "group_id": str(row["group_id"] or ""),
            "clip_id": str(row["clip_id"] or ""),
            "start": float(row["start"] or 0),
            "end": float(row["end"] or 0),
            "confidence": float(row["confidence"] or 0),
            # A person-labeling surface must never fall back to the complete
            # camera frame. The source frame remains traceable metadata only.
            "face_crop_path": str(metadata.get("face_crop_path", "") or ""),
            "source_frame_path": str(
                metadata.get("source_frame_path", metadata.get("frame_path", "")) or ""
            ),
            "camera": str(metadata.get("camera", "") or ""),
            "source_time": float(metadata.get("source_time", row["start"]) or 0),
            "transcript_text": str(metadata.get("text", "") or "")[:600],
        }

    def _example(self, identity_id: str) -> dict[str, Any]:
        """Return one local, inspectable sample without exposing embeddings."""
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT o.group_id, o.clip_id, o.start, o.end, o.confidence,
                       o.metadata_json
                FROM identity_observations AS o
                WHERE o.project_id=? AND o.identity_id=?
                ORDER BY o.confidence DESC, (o.end-o.start) DESC, o.observation_id
                LIMIT 1
                """,
                (self.project_id, identity_id),
            ).fetchone()
        if row is None:
            return {}
        metadata = _json_object(row["metadata_json"])
        face_crop_path = str(metadata.get("face_crop_path", "") or "")
        return {
            "group_id": str(row["group_id"] or ""),
            "clip_id": str(row["clip_id"] or ""),
            "start": float(row["start"] or 0),
            "end": float(row["end"] or 0),
            "confidence": float(row["confidence"] or 0),
            # A person-labeling surface must never fall back to the complete
            # camera frame. The source frame remains traceable metadata only.
            "face_crop_path": face_crop_path,
            "source_frame_path": str(
                metadata.get("source_frame_path", metadata.get("frame_path", "")) or ""
            ),
            "camera": str(metadata.get("camera", "") or ""),
            "source_time": float(metadata.get("source_time", row["start"]) or 0),
            "transcript_text": str(metadata.get("text", "") or "")[:600],
        }

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
        result = self.get(identity_id)
        self._refresh_mapping_rescue()
        return result

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
        result = self.get(target)
        self._refresh_mapping_rescue()
        return result

    def group_identities(self, group_id: str) -> dict[str, list[dict[str, Any]]]:
        """Return identity evidence for App use, never raw embeddings."""
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

    def identities_by_group(self) -> dict[str, dict[str, list[dict[str, Any]]]]:
        """Bulk variant of :meth:`group_identities`: one query for the whole
        project. Read models that need evidence for every take must consume
        this — per-group calls open one SQLite connection per take, which is
        the dominant cost of refreshing a 1500-take review payload."""
        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT o.group_id, o.kind, o.identity_id, o.confidence, o.start, o.end,
                       i.label, i.role_name, i.metadata_json
                FROM identity_observations AS o
                LEFT JOIN identities AS i
                  ON i.project_id=o.project_id AND i.identity_id=o.identity_id
                WHERE o.project_id=?
                ORDER BY o.group_id, o.kind, o.confidence DESC, o.observation_id
                """,
                (self.project_id,),
            ).fetchall()
        grouped: dict[str, dict[str, list[dict[str, Any]]]] = {}
        for row in rows:
            kind = str(row["kind"])
            if kind not in {"face", "speaker"}:
                continue
            group_id = str(row["group_id"] or "")
            metadata = _json_object(row["metadata_json"])
            bucket = grouped.setdefault(group_id, {"face": [], "speaker": []})
            bucket[kind].append(
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
        return grouped
