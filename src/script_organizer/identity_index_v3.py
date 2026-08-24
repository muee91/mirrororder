from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any

from .identity_index_legacy import _decode_embedding, _encode_embedding, _normalize
from .identity_index_v2 import (
    FACE_DETECTOR,
    FACE_RECOGNIZER,
    FaceEmbeddingProvider,
    IdentityIndexer as _IdentityIndexerV2,
    SpeakerEmbeddingProvider,
    _centroid,
    _cosine,
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _json_object(value: object) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    try:
        decoded = json.loads(str(value or "{}"))
    except (TypeError, ValueError):
        return {}
    return dict(decoded) if isinstance(decoded, dict) else {}


def _prototype_similarity(vector: list[float], vectors: list[list[float]]) -> float:
    """Compare against both the cluster centre and real observed prototypes.

    Face embeddings are sensitive to yaw, focal length and crop scale. A single
    centroid is therefore a poor representation of an actor observed by several
    cameras. The nearest real prototype keeps a strong side-profile / camera
    view from being averaged away, while the small guard below prevents a
    malformed vector from turning into a match.
    """

    if not vector or not vectors:
        return -1.0
    centre = _centroid(vectors)
    centroid_score = _cosine(vector, centre) if centre else -1.0
    prototype_scores = sorted((_cosine(vector, item) for item in vectors), reverse=True)
    nearest = prototype_scores[0] if prototype_scores else -1.0
    if nearest < -0.5:
        return centroid_score
    # Keep the nearest real face almost intact. The 0.01 guard means a lone
    # prototype still has to clear the configured profile threshold itself.
    prototype_score = nearest - 0.01
    if len(prototype_scores) >= 2:
        supported = sum(prototype_scores[: min(3, len(prototype_scores))]) / min(3, len(prototype_scores))
        prototype_score = max(prototype_score, 0.78 * nearest + 0.22 * supported)
    return max(centroid_score, prototype_score)


def _pair_similarity(left: list[list[float]], right: list[list[float]]) -> tuple[float, float, float]:
    if not left or not right:
        return -1.0, -1.0, -1.0
    left_centre = _centroid(left)
    right_centre = _centroid(right)
    centroid_score = _cosine(left_centre, right_centre) if left_centre and right_centre else -1.0
    cross = sorted((_cosine(a, b) for a in left for b in right), reverse=True)
    nearest = cross[0] if cross else -1.0
    support = sum(cross[: min(4, len(cross))]) / min(4, len(cross)) if cross else -1.0
    # Consolidation is deliberately stricter than assignment. One close frame
    # is useful, but a cluster pair also needs broader support.
    score = max(centroid_score, 0.68 * nearest + 0.32 * support)
    return score, nearest, centroid_score


class IdentityIndexer(_IdentityIndexerV2):
    """Identity indexing with durable human reuse and anti-fragmentation faces.

    Human-confirmed actor/speaker clusters are sticky. Automatic face clusters
    use real prototypes as well as centroids, then run a conservative local
    consolidation pass. No biometric data leaves the device-local database.
    """

    def _fully_human_labeled(self, kind: str, group_id: str) -> bool:
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT COUNT(*) AS total,
                       SUM(
                         CASE WHEN COALESCE(json_extract(i.metadata_json, '$.human_confirmed'), 0)=1
                              THEN 1 ELSE 0 END
                       ) AS confirmed
                FROM identity_observations AS o
                LEFT JOIN identities AS i
                  ON i.project_id=o.project_id AND i.identity_id=o.identity_id
                WHERE o.project_id=? AND o.group_id=? AND o.kind=?
                """,
                (self.project_id, str(group_id), kind),
            ).fetchone()
        if row is None:
            return False
        total = int(row["total"] or 0)
        confirmed = int(row["confirmed"] or 0)
        return total > 0 and confirmed == total

    def _already_indexed(self, kind: str, group_id: str) -> bool:
        if self._fully_human_labeled(kind, group_id):
            return True
        return super()._already_indexed(kind, group_id)

    def _state_version(self, kind: str) -> str:
        if kind != "face":
            return super()._state_version(kind)
        # v4 changes cluster semantics. Non-human cached face observations are
        # rebuilt once so existing fragmented projects benefit from the fix.
        return (
            "face-v4-prototypes|" + FACE_DETECTOR.sha256[:12] + "|" + FACE_RECOGNIZER.sha256[:12]
            + f"|{self.identity_profile_id}|{self.face_threshold:.3f}|{self.frames_per_camera}"
        )

    def _assign(
        self,
        kind: str,
        group_id: str,
        observations: list[dict[str, Any]],
        *,
        clip_id: str,
        threshold: float,
    ) -> int:
        clusters = self._existing_clusters(kind, group_id)
        with self.database.connection() as connection:
            connection.execute(
                "DELETE FROM identity_observations WHERE project_id=? AND group_id=? AND kind=?",
                (self.project_id, group_id, kind),
            )
            connection.commit()

        created = self._identity_count(kind)
        written = 0
        for observation in observations:
            vector = _normalize(observation.get("embedding", []))
            if not vector:
                continue

            best_id = ""
            best_score = -1.0
            for identity_id, vectors in clusters.items():
                score = (
                    _prototype_similarity(vector, vectors)
                    if kind == "face"
                    else _cosine(vector, _centroid(vectors))
                )
                if score > best_score:
                    best_id, best_score = identity_id, score

            if not best_id or best_score < threshold:
                digest = hashlib.sha1(_encode_embedding(vector)).hexdigest()[:18]
                best_id = f"{kind}_{digest}"
                if best_id not in clusters:
                    if not self._identity_exists(best_id, kind):
                        created += 1
                        label = ("人物候选 " if kind == "face" else "声音候选 ") + f"{created:02d}"
                        self.database.upsert_identity(
                            self.project_id,
                            identity_id=best_id,
                            kind=kind,
                            label=label,
                            metadata={
                                "auto_cluster": True,
                                "threshold": threshold,
                                "matching": "prototype+centroid" if kind == "face" else "centroid",
                            },
                        )
                    clusters[best_id] = []
                best_score = 1.0

            clusters.setdefault(best_id, []).append(vector)
            metadata = dict(observation.get("metadata", {}))
            metadata["cluster_similarity"] = max(0.0, min(1.0, best_score))
            metadata["cluster_matching"] = "prototype+centroid" if kind == "face" else "centroid"
            source_clip_id = str(
                observation.get("clip_id", "")
                or metadata.get("clip_id", "")
                or clip_id
                or ""
            )
            self.database.add_identity_observation(
                self.project_id,
                group_id,
                kind=kind,
                clip_id=source_clip_id,
                start=float(observation.get("start", 0) or 0),
                end=float(observation.get("end", 0) or 0),
                confidence=float(observation.get("confidence", 0) or 0),
                identity_id=best_id,
                embedding=_encode_embedding(vector),
                metadata=metadata,
            )
            written += 1
        return written

    def _face_cluster_snapshot(self) -> dict[str, dict[str, Any]]:
        clusters: dict[str, dict[str, Any]] = {}
        with self.database.connection() as connection:
            identities = connection.execute(
                """
                SELECT identity_id, label, role_name, metadata_json, created_at
                FROM identities
                WHERE project_id=? AND kind='face'
                """,
                (self.project_id,),
            ).fetchall()
            observations = connection.execute(
                """
                SELECT identity_id, group_id, embedding, metadata_json
                FROM identity_observations
                WHERE project_id=? AND kind='face' AND identity_id IS NOT NULL
                """,
                (self.project_id,),
            ).fetchall()
        for row in identities:
            identity_id = str(row["identity_id"] or "")
            if not identity_id:
                continue
            metadata = _json_object(row["metadata_json"])
            clusters[identity_id] = {
                "identity_id": identity_id,
                "label": str(row["label"] or ""),
                "role_name": str(row["role_name"] or ""),
                "metadata": metadata,
                "confirmed": bool(metadata.get("human_confirmed")),
                "created_at": str(row["created_at"] or ""),
                "vectors": [],
                "presence": set(),
            }
        for row in observations:
            identity_id = str(row["identity_id"] or "")
            cluster = clusters.get(identity_id)
            if cluster is None:
                continue
            vector = _normalize(_decode_embedding(row["embedding"]))
            if vector:
                cluster["vectors"].append(vector)
            metadata = _json_object(row["metadata_json"])
            group_id = str(row["group_id"] or "")
            camera = str(metadata.get("camera", "") or "?")
            if group_id:
                cluster["presence"].add((group_id, camera))
        return {key: value for key, value in clusters.items() if value["vectors"]}

    @staticmethod
    def _same_camera_cooccurrence(left: dict[str, Any], right: dict[str, Any]) -> bool:
        return bool(set(left.get("presence", set())) & set(right.get("presence", set())))

    def _merge_face_cluster(self, target: str, source: str) -> None:
        if not target or not source or target == source:
            return
        with self.database.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                UPDATE identity_observations SET identity_id=?
                WHERE project_id=? AND identity_id=? AND kind='face'
                """,
                (target, self.project_id, source),
            )
            connection.execute(
                "DELETE FROM identities WHERE project_id=? AND identity_id=? AND kind='face'",
                (self.project_id, source),
            )
            connection.execute(
                "UPDATE identities SET updated_at=? WHERE project_id=? AND identity_id=?",
                (_now(), self.project_id, target),
            )
            connection.commit()

    @staticmethod
    def _merge_target(left: dict[str, Any], right: dict[str, Any]) -> tuple[str, str]:
        left_id = str(left["identity_id"])
        right_id = str(right["identity_id"])
        if left.get("confirmed") and not right.get("confirmed"):
            return left_id, right_id
        if right.get("confirmed") and not left.get("confirmed"):
            return right_id, left_id
        left_size = len(left.get("vectors", []))
        right_size = len(right.get("vectors", []))
        if left_size != right_size:
            return (left_id, right_id) if left_size > right_size else (right_id, left_id)
        left_key = (str(left.get("created_at", "")), left_id)
        right_key = (str(right.get("created_at", "")), right_id)
        return (left_id, right_id) if left_key <= right_key else (right_id, left_id)

    def _consolidate_auto_face_clusters(self) -> int:
        """Merge only strong, non-contradictory face fragments.

        This is intentionally conservative. Two identities observed in the same
        camera of the same Take are treated as different people. Two separately
        human-confirmed identities are never merged. A fragment may be absorbed
        into a human-confirmed identity only at a stronger similarity threshold.
        """

        merged = 0
        base_threshold = max(0.58, min(0.82, float(self.face_threshold) + 0.13))
        for _ in range(48):
            clusters = self._face_cluster_snapshot()
            ids = sorted(clusters)
            best_pair: tuple[str, str] | None = None
            best_score = -1.0
            for left_index, left_id in enumerate(ids):
                left = clusters[left_id]
                for right_id in ids[left_index + 1 :]:
                    right = clusters[right_id]
                    if left.get("confirmed") and right.get("confirmed"):
                        continue
                    if self._same_camera_cooccurrence(left, right):
                        continue
                    score, nearest, centroid_score = _pair_similarity(left["vectors"], right["vectors"])
                    threshold = base_threshold + (0.07 if left.get("confirmed") or right.get("confirmed") else 0.0)
                    # Require both a strong prototype relation and broader
                    # cluster agreement. This prevents a single accidental face
                    # crop from joining two otherwise unrelated actors.
                    if nearest < threshold or score < threshold - 0.025:
                        continue
                    if centroid_score < threshold - 0.13 and min(len(left["vectors"]), len(right["vectors"])) >= 2:
                        continue
                    if score > best_score:
                        best_score = score
                        best_pair = (left_id, right_id)
            if best_pair is None:
                break
            left = clusters[best_pair[0]]
            right = clusters[best_pair[1]]
            target, source = self._merge_target(left, right)
            self._merge_face_cluster(target, source)
            merged += 1
        return merged

    def run(
        self,
        kind: str,
        *,
        group_ids: list[str] | None = None,
        force_reindex: bool = False,
        **kwargs: Any,
    ) -> dict[str, Any]:
        requested = list(dict.fromkeys(str(value) for value in (group_ids or []) if str(value)))
        if requested and not force_reindex:
            pending = [group_id for group_id in requested if not self._already_indexed(kind, group_id)]
            if not pending:
                merged = self._consolidate_auto_face_clusters() if kind == "face" else 0
                return {
                    "status": "completed",
                    "kind": kind,
                    "processed": 0,
                    "observations": 0,
                    "failed": 0,
                    "total": 0,
                    "skipped_cached": True,
                    "merged_clusters": merged,
                    "intelligence": self.database.project_intelligence(self.project_id),
                }
            requested = pending
        result = super().run(kind, group_ids=requested or None, **kwargs)
        if kind == "face":
            merged = self._consolidate_auto_face_clusters()
            result["merged_clusters"] = merged
            if merged:
                try:
                    from .identity_rescue import apply_identity_rescue
                    apply_identity_rescue(self.config)
                except Exception:
                    pass
        return result


__all__ = ["FaceEmbeddingProvider", "SpeakerEmbeddingProvider", "IdentityIndexer"]