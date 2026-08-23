from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any, Iterator, Sequence
from uuid import uuid4

from .media_identity import device_state_dir


SCHEMA_VERSION = 1
_SAFE_ID = re.compile(r"[^A-Za-z0-9_.-]+")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _safe_workspace_key(workspace_id: str) -> str:
    raw = str(workspace_id or "").strip()
    if not raw:
        raise ValueError("workspace_id 不能为空")
    safe = _SAFE_ID.sub("_", raw).strip("._-")
    if not safe:
        safe = "workspace"
    # Keep human-readable workspace IDs while making collisions impossible when
    # a future adapter supplies characters that need sanitising.
    if safe != raw:
        safe += "-" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]
    return safe[:120]


def workspace_database_path(workspace_id: str) -> Path:
    """Return the device-local database path for one logical workspace.

    The database intentionally lives in Application Support rather than inside
    the shared workspace. SQLite/WAL is safe for one Host process on one Mac,
    while cloud-drive/network-filesystem replication of a live WAL database is
    not. Shared project facts remain in the workspace JSON/TOML files.
    """

    return device_state_dir() / "workspaces" / _safe_workspace_key(workspace_id) / "workspace.sqlite3"


class WorkspaceDatabase:
    """Device-local SQLite index for one MirrorOrder workspace.

    JSON/TOML remain authoritative for project definition and human review in
    schema v1. SQLite stores fast project summaries, Take structure, sampled
    evidence, optional local biometric observations, and perception job state.
    It is therefore rebuildable from project artifacts and never needs to be
    synced between editors.
    """

    def __init__(self, workspace_id: str, path: Path | None = None):
        self.workspace_id = str(workspace_id or "").strip()
        if not self.workspace_id:
            raise ValueError("workspace_id 不能为空")
        self.path = Path(path) if path is not None else workspace_database_path(self.workspace_id)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self._initialize()

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=30.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=5000")
        try:
            yield connection
        finally:
            connection.close()

    def _initialize(self) -> None:
        with self._lock, self.connection() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=NORMAL")
            current = int(connection.execute("PRAGMA user_version").fetchone()[0])
            if current > SCHEMA_VERSION:
                raise RuntimeError(f"工作区数据库版本 {current} 高于当前支持的 {SCHEMA_VERSION}")
            if current < 1:
                self._migrate_v1(connection)
                connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            connection.commit()
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    @staticmethod
    def _migrate_v1(connection: sqlite3.Connection) -> None:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS projects (
                project_id TEXT PRIMARY KEY,
                name TEXT NOT NULL DEFAULT '',
                input_kind TEXT NOT NULL DEFAULT '',
                config_path TEXT NOT NULL DEFAULT '',
                analysis_revision TEXT NOT NULL DEFAULT '',
                review_revision INTEGER NOT NULL DEFAULT 0,
                stats_json TEXT NOT NULL DEFAULT '{}',
                lifecycle TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS takes (
                project_id TEXT NOT NULL,
                group_id TEXT NOT NULL,
                start REAL NOT NULL DEFAULT 0,
                end REAL NOT NULL DEFAULT 0,
                duration REAL NOT NULL DEFAULT 0,
                cameras_json TEXT NOT NULL DEFAULT '[]',
                members_json TEXT NOT NULL DEFAULT '[]',
                kind TEXT NOT NULL DEFAULT '',
                parent_group_id TEXT NOT NULL DEFAULT '',
                take_index INTEGER NOT NULL DEFAULT 1,
                split_reason TEXT NOT NULL DEFAULT '',
                semantic_status TEXT NOT NULL DEFAULT 'pending',
                semantic_json TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL,
                PRIMARY KEY (project_id, group_id),
                FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS frames (
                project_id TEXT NOT NULL,
                group_id TEXT NOT NULL,
                frame_id TEXT NOT NULL,
                clip_id TEXT NOT NULL DEFAULT '',
                camera TEXT NOT NULL DEFAULT '',
                source_time REAL NOT NULL DEFAULT 0,
                reason TEXT NOT NULL DEFAULT '',
                path TEXT NOT NULL,
                width INTEGER NOT NULL DEFAULT 0,
                height INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                PRIMARY KEY (project_id, frame_id),
                FOREIGN KEY (project_id, group_id)
                    REFERENCES takes(project_id, group_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS frames_by_take
                ON frames(project_id, group_id, source_time);

            CREATE TABLE IF NOT EXISTS perception_runs (
                run_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                mode TEXT NOT NULL,
                status TEXT NOT NULL,
                processed INTEGER NOT NULL DEFAULT 0,
                failed INTEGER NOT NULL DEFAULT 0,
                details_json TEXT NOT NULL DEFAULT '{}',
                error TEXT NOT NULL DEFAULT '',
                started_at TEXT NOT NULL,
                completed_at TEXT NOT NULL DEFAULT '',
                FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS perception_runs_by_project
                ON perception_runs(project_id, started_at DESC);

            CREATE TABLE IF NOT EXISTS identities (
                identity_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                kind TEXT NOT NULL CHECK(kind IN ('face', 'speaker')),
                label TEXT NOT NULL DEFAULT '',
                role_name TEXT NOT NULL DEFAULT '',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS identity_observations (
                observation_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                group_id TEXT NOT NULL,
                identity_id TEXT,
                kind TEXT NOT NULL CHECK(kind IN ('face', 'speaker')),
                clip_id TEXT NOT NULL DEFAULT '',
                start REAL NOT NULL DEFAULT 0,
                end REAL NOT NULL DEFAULT 0,
                confidence REAL NOT NULL DEFAULT 0,
                embedding BLOB,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                FOREIGN KEY (project_id, group_id)
                    REFERENCES takes(project_id, group_id) ON DELETE CASCADE,
                FOREIGN KEY (identity_id) REFERENCES identities(identity_id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS identity_observations_by_take
                ON identity_observations(project_id, group_id, kind);

            CREATE TABLE IF NOT EXISTS analysis_requests (
                request_id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                segment_id TEXT NOT NULL DEFAULT '',
                actor TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'queued',
                payload_json TEXT NOT NULL DEFAULT '{}',
                result_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (project_id) REFERENCES projects(project_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS analysis_requests_by_project
                ON analysis_requests(project_id, created_at DESC);
            """
        )
        connection.execute(
            "INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )

    def sync_project_summary(
        self,
        project_id: str,
        *,
        name: str = "",
        input_kind: str = "",
        config_path: str = "",
        analysis_revision: str = "",
        review_revision: int = 0,
        stats: dict[str, Any] | None = None,
    ) -> None:
        now = _now()
        with self._lock, self.connection() as connection:
            connection.execute(
                """
                INSERT INTO projects(
                    project_id, name, input_kind, config_path,
                    analysis_revision, review_revision, stats_json,
                    lifecycle, created_at, updated_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
                ON CONFLICT(project_id) DO UPDATE SET
                    name=excluded.name,
                    input_kind=excluded.input_kind,
                    config_path=excluded.config_path,
                    analysis_revision=excluded.analysis_revision,
                    review_revision=excluded.review_revision,
                    stats_json=excluded.stats_json,
                    lifecycle='active',
                    updated_at=excluded.updated_at
                """,
                (
                    str(project_id),
                    str(name),
                    str(input_kind),
                    str(config_path),
                    str(analysis_revision),
                    int(review_revision or 0),
                    _json(stats or {}),
                    now,
                    now,
                ),
            )
            connection.commit()

    def remove_project(self, project_id: str) -> None:
        with self._lock, self.connection() as connection:
            connection.execute("DELETE FROM projects WHERE project_id=?", (str(project_id),))
            connection.commit()

    def sync_take_index(
        self,
        project_id: str,
        *,
        name: str,
        input_kind: str,
        config_path: str,
        index: dict[str, Any],
    ) -> dict[str, int]:
        groups = [item for item in index.get("groups", []) if isinstance(item, dict) and item.get("group_id")]
        self.sync_project_summary(
            project_id,
            name=name,
            input_kind=input_kind,
            config_path=config_path,
            stats=index.get("stats", {}) if isinstance(index.get("stats"), dict) else {},
        )
        now = _now()
        group_ids = {str(group["group_id"]) for group in groups}
        with self._lock, self.connection() as connection:
            existing = {
                str(row[0])
                for row in connection.execute("SELECT group_id FROM takes WHERE project_id=?", (project_id,))
            }
            stale = existing - group_ids
            if stale:
                connection.executemany(
                    "DELETE FROM takes WHERE project_id=? AND group_id=?",
                    [(project_id, group_id) for group_id in stale],
                )
            for group in groups:
                connection.execute(
                    """
                    INSERT INTO takes(
                        project_id, group_id, start, end, duration, cameras_json,
                        members_json, kind, parent_group_id, take_index,
                        split_reason, updated_at
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(project_id, group_id) DO UPDATE SET
                        start=excluded.start,
                        end=excluded.end,
                        duration=excluded.duration,
                        cameras_json=excluded.cameras_json,
                        members_json=excluded.members_json,
                        kind=excluded.kind,
                        parent_group_id=excluded.parent_group_id,
                        take_index=excluded.take_index,
                        split_reason=excluded.split_reason,
                        updated_at=excluded.updated_at
                    """,
                    (
                        project_id,
                        str(group["group_id"]),
                        float(group.get("start", 0) or 0),
                        float(group.get("end", 0) or 0),
                        float(group.get("duration", 0) or 0),
                        _json(group.get("cameras", []) if isinstance(group.get("cameras"), list) else []),
                        _json(group.get("members", []) if isinstance(group.get("members"), list) else []),
                        str(group.get("kind", "") or ""),
                        str(group.get("parent_group_id", "") or ""),
                        int(group.get("take_index", 1) or 1),
                        str(group.get("split_reason", "") or ""),
                        now,
                    ),
                )
            connection.commit()
        return {"takes": len(group_ids), "removed": len(stale)}

    def pending_groups(
        self,
        project_id: str,
        *,
        semantic: bool = False,
        group_ids: Sequence[str] | None = None,
        limit: int = 0,
    ) -> list[str]:
        requested = {str(value) for value in (group_ids or []) if str(value)}
        with self.connection() as connection:
            rows = connection.execute(
                """
                SELECT t.group_id,
                       COUNT(f.frame_id) AS frame_count,
                       t.semantic_status
                FROM takes AS t
                LEFT JOIN frames AS f
                  ON f.project_id=t.project_id AND f.group_id=t.group_id
                WHERE t.project_id=?
                GROUP BY t.group_id, t.semantic_status
                ORDER BY t.start, t.group_id
                """,
                (project_id,),
            ).fetchall()
        result = []
        for row in rows:
            group_id = str(row["group_id"])
            if requested and group_id not in requested:
                continue
            if semantic:
                if str(row["semantic_status"]) == "ready":
                    continue
            elif int(row["frame_count"] or 0) > 0:
                continue
            result.append(group_id)
            if limit > 0 and len(result) >= limit:
                break
        return result

    def replace_frames(self, project_id: str, group_id: str, frames: Sequence[dict[str, Any]]) -> None:
        now = _now()
        with self._lock, self.connection() as connection:
            connection.execute("DELETE FROM frames WHERE project_id=? AND group_id=?", (project_id, group_id))
            for frame in frames:
                connection.execute(
                    """
                    INSERT INTO frames(
                        project_id, group_id, frame_id, clip_id, camera,
                        source_time, reason, path, width, height, created_at
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        project_id,
                        group_id,
                        str(frame.get("frame_id", "")),
                        str(frame.get("clip_id", "") or ""),
                        str(frame.get("camera", "") or ""),
                        float(frame.get("source_time", 0) or 0),
                        str(frame.get("reason", "") or ""),
                        str(frame.get("path", "")),
                        int(frame.get("width", 0) or 0),
                        int(frame.get("height", 0) or 0),
                        now,
                    ),
                )
            connection.commit()

    def frames(self, project_id: str, group_id: str) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                """
                SELECT frame_id, clip_id, camera, source_time, reason,
                       path, width, height, created_at
                FROM frames
                WHERE project_id=? AND group_id=?
                ORDER BY source_time, frame_id
                """,
                (project_id, group_id),
            ).fetchall()
        return [dict(row) for row in rows]

    def set_semantic(self, project_id: str, group_id: str, payload: dict[str, Any] | None, status: str) -> None:
        with self._lock, self.connection() as connection:
            connection.execute(
                """
                UPDATE takes
                SET semantic_status=?, semantic_json=?, updated_at=?
                WHERE project_id=? AND group_id=?
                """,
                (str(status), _json(payload or {}), _now(), project_id, group_id),
            )
            connection.commit()

    def semantic(self, project_id: str, group_id: str) -> dict[str, Any]:
        with self.connection() as connection:
            row = connection.execute(
                "SELECT semantic_status, semantic_json FROM takes WHERE project_id=? AND group_id=?",
                (project_id, group_id),
            ).fetchone()
        if row is None:
            return {"status": "missing", "data": {}}
        try:
            data = json.loads(str(row["semantic_json"] or "{}"))
        except ValueError:
            data = {}
        return {"status": str(row["semantic_status"]), "data": data if isinstance(data, dict) else {}}

    def start_perception_run(self, project_id: str, mode: str) -> str:
        run_id = "prun_" + uuid4().hex
        with self._lock, self.connection() as connection:
            connection.execute(
                """
                INSERT INTO perception_runs(
                    run_id, project_id, mode, status, processed, failed,
                    details_json, error, started_at, completed_at
                ) VALUES(?, ?, ?, 'running', 0, 0, '{}', '', ?, '')
                """,
                (run_id, project_id, str(mode), _now()),
            )
            connection.commit()
        return run_id

    def finish_perception_run(
        self,
        run_id: str,
        *,
        status: str,
        processed: int,
        failed: int,
        details: dict[str, Any] | None = None,
        error: str = "",
    ) -> None:
        with self._lock, self.connection() as connection:
            connection.execute(
                """
                UPDATE perception_runs
                SET status=?, processed=?, failed=?, details_json=?, error=?, completed_at=?
                WHERE run_id=?
                """,
                (str(status), int(processed), int(failed), _json(details or {}), str(error), _now(), run_id),
            )
            connection.commit()

    def project_intelligence(self, project_id: str) -> dict[str, int]:
        with self.connection() as connection:
            take_row = connection.execute(
                """
                SELECT COUNT(*) AS takes,
                       SUM(CASE WHEN semantic_status='ready' THEN 1 ELSE 0 END) AS semantic_takes
                FROM takes WHERE project_id=?
                """,
                (project_id,),
            ).fetchone()
            framed = connection.execute(
                "SELECT COUNT(DISTINCT group_id) FROM frames WHERE project_id=?",
                (project_id,),
            ).fetchone()[0]
            identity_rows = connection.execute(
                """
                SELECT kind, COUNT(*) AS count
                FROM identity_observations
                WHERE project_id=? GROUP BY kind
                """,
                (project_id,),
            ).fetchall()
        identity = {str(row["kind"]): int(row["count"] or 0) for row in identity_rows}
        takes = int(take_row["takes"] or 0) if take_row else 0
        semantic_takes = int(take_row["semantic_takes"] or 0) if take_row else 0
        return {
            "takes": takes,
            "framed_takes": int(framed or 0),
            "semantic_takes": semantic_takes,
            "pending_semantic": max(0, takes - semantic_takes),
            "face_observations": identity.get("face", 0),
            "speaker_observations": identity.get("speaker", 0),
        }

    def upsert_identity(
        self,
        project_id: str,
        *,
        identity_id: str,
        kind: str,
        label: str = "",
        role_name: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> None:
        if kind not in {"face", "speaker"}:
            raise ValueError("identity kind 必须是 face 或 speaker")
        now = _now()
        with self._lock, self.connection() as connection:
            connection.execute(
                """
                INSERT INTO identities(
                    identity_id, project_id, kind, label, role_name,
                    metadata_json, created_at, updated_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(identity_id) DO UPDATE SET
                    label=excluded.label,
                    role_name=excluded.role_name,
                    metadata_json=excluded.metadata_json,
                    updated_at=excluded.updated_at
                """,
                (identity_id, project_id, kind, label, role_name, _json(metadata or {}), now, now),
            )
            connection.commit()

    def add_identity_observation(
        self,
        project_id: str,
        group_id: str,
        *,
        kind: str,
        clip_id: str = "",
        start: float = 0,
        end: float = 0,
        confidence: float = 0,
        identity_id: str | None = None,
        embedding: bytes | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> str:
        if kind not in {"face", "speaker"}:
            raise ValueError("observation kind 必须是 face 或 speaker")
        observation_id = "obs_" + uuid4().hex
        with self._lock, self.connection() as connection:
            connection.execute(
                """
                INSERT INTO identity_observations(
                    observation_id, project_id, group_id, identity_id, kind,
                    clip_id, start, end, confidence, embedding, metadata_json, created_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    observation_id,
                    project_id,
                    group_id,
                    identity_id,
                    kind,
                    clip_id,
                    float(start),
                    float(end),
                    max(0.0, min(1.0, float(confidence))),
                    embedding,
                    _json(metadata or {}),
                    _now(),
                ),
            )
            connection.commit()
        return observation_id

    def create_analysis_request(
        self,
        project_id: str,
        *,
        kind: str,
        segment_id: str = "",
        actor: str = "",
        payload: dict[str, Any] | None = None,
    ) -> str:
        request_id = "req_" + uuid4().hex
        now = _now()
        with self._lock, self.connection() as connection:
            connection.execute(
                """
                INSERT INTO analysis_requests(
                    request_id, project_id, kind, segment_id, actor, status,
                    payload_json, result_json, created_at, updated_at
                ) VALUES(?, ?, ?, ?, ?, 'queued', ?, '{}', ?, ?)
                """,
                (request_id, project_id, kind, segment_id, actor[:80], _json(payload or {}), now, now),
            )
            connection.commit()
        return request_id

    def health(self) -> dict[str, Any]:
        with self.connection() as connection:
            quick_check = str(connection.execute("PRAGMA quick_check").fetchone()[0])
            version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        return {
            "workspace_id": self.workspace_id,
            "schema_version": version,
            "quick_check": quick_check,
            "path": str(self.path),
        }
