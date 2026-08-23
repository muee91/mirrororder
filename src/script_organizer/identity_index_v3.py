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
    """V2 identity indexer with observation-specific source-media identity.

    Sparse face tracks may originate from different camera clips in one Take.
    Keep each observation's real clip_id in the normalized DB column so App
    inspectors and evidence playback can return to the correct camera source.
    """

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


__all__ = ["FaceEmbeddingProvider", "SpeakerEmbeddingProvider", "IdentityIndexer"]
