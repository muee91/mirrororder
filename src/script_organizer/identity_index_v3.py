from __future__ import annotations

import hashlib
from typing import Any

from .identity_index_legacy import _encode_embedding, _normalize
from .identity_index_v2 import (
    FaceEmbeddingProvider,
    IdentityIndexer as _IdentityIndexerV2,
    SpeakerEmbeddingProvider,
    _centroid,
    _cosine,
)


class IdentityIndexer(_IdentityIndexerV2):
    """V2 identity indexer with source identity and durable human reuse.

    Sparse face tracks may originate from different camera clips in one Take.
    Keep each observation's real clip_id in the normalized DB column so App
    inspectors and evidence playback can return to the correct camera source.

    Human-confirmed actor/speaker clusters are intentionally sticky. Normal and
    manually scoped indexing reuses a group whose identity evidence is already
    current; fully human-confirmed groups stay cached even if a model/profile
    fingerprint later changes. A developer may opt into force_reindex=True for
    an explicit rebuild, but production UI never needs to pay that cost merely
    because a known actor appears again.
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
        # Human labels outrank automatic model/profile freshness. The cluster
        # embeddings remain reusable evidence; do not erase and regenerate them
        # just because a runtime version changed.
        if self._fully_human_labeled(kind, group_id):
            return True
        return super()._already_indexed(kind, group_id)

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
                score = _cosine(vector, _centroid(vectors))
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
                            metadata={"auto_cluster": True, "threshold": threshold},
                        )
                    clusters[best_id] = []
                best_score = 1.0

            clusters.setdefault(best_id, []).append(vector)
            metadata = dict(observation.get("metadata", {}))
            metadata["cluster_similarity"] = max(0.0, min(1.0, best_score))
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
                return {
                    "status": "completed",
                    "kind": kind,
                    "processed": 0,
                    "observations": 0,
                    "failed": 0,
                    "total": 0,
                    "skipped_cached": True,
                    "intelligence": self.database.project_intelligence(self.project_id),
                }
            requested = pending
        return super().run(kind, group_ids=requested or None, **kwargs)


__all__ = ["FaceEmbeddingProvider", "SpeakerEmbeddingProvider", "IdentityIndexer"]
