from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable

from .config import ProjectConfig
from .identity_library import IdentityLibrary
from .script_parser import parse_script

_INSTALLED = False


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _candidate_ids(candidate: dict[str, Any]) -> list[str]:
    raw = candidate.get("script_segment_ids")
    if isinstance(raw, list):
        return [str(value) for value in raw if str(value)]
    value = str(candidate.get("script_segment_id", "") or "")
    return [value] if value else []


def _speaker_name(value: object) -> str:
    return " ".join(str(value or "").strip().split())[:120]


def _project_config(library: IdentityLibrary) -> ProjectConfig | None:
    try:
        with library.database.connection() as connection:
            row = connection.execute(
                "SELECT config_path FROM projects WHERE project_id=? LIMIT 1",
                (library.project_id,),
            ).fetchone()
        if row is None:
            return None
        path = Path(str(row[0] or "")).expanduser()
        if not path.is_file():
            return None
        return ProjectConfig.from_file(path)
    except Exception:
        return None


def _script_segments(config: ProjectConfig) -> list[dict[str, Any]]:
    payload = _read_json(config.output_dir / "script.json")
    rows = payload.get("segments", []) if isinstance(payload.get("segments"), list) else []
    if rows:
        return [dict(row) for row in rows if isinstance(row, dict)]
    try:
        return [segment.to_dict() for segment in parse_script(config.script).segments]
    except Exception:
        return []


def _identity_group_quality(library: IdentityLibrary, kind: str) -> tuple[dict[str, dict[str, float]], dict[str, int]]:
    """Return per-identity Take quality and number of identities visible per Take."""

    quality: dict[str, dict[str, float]] = defaultdict(dict)
    group_identities: dict[str, set[str]] = defaultdict(set)
    with library.database.connection() as connection:
        rows = connection.execute(
            """
            SELECT identity_id, group_id, confidence, metadata_json
            FROM identity_observations
            WHERE project_id=? AND kind=? AND identity_id IS NOT NULL
            """,
            (library.project_id, kind),
        ).fetchall()
    for row in rows:
        identity_id = str(row["identity_id"] or "")
        group_id = str(row["group_id"] or "")
        if not identity_id or not group_id:
            continue
        group_identities[group_id].add(identity_id)
        try:
            metadata = json.loads(str(row["metadata_json"] or "{}"))
            if not isinstance(metadata, dict):
                metadata = {}
        except ValueError:
            metadata = {}
        observation = max(0.0, min(1.0, float(row["confidence"] or 0)))
        try:
            similarity = max(0.0, min(1.0, float(metadata.get("cluster_similarity", observation))))
        except (TypeError, ValueError):
            similarity = observation
        score = min(observation, similarity) if similarity > 0 else observation
        quality[identity_id][group_id] = max(quality[identity_id].get(group_id, 0.0), score)
    return quality, {group_id: len(ids) for group_id, ids in group_identities.items()}


def _placement_speakers(
    review: dict[str, Any],
    group_id: str,
    segment_by_id: dict[str, dict[str, Any]],
) -> list[tuple[str, float, str]]:
    placements = review.get("placements", {}) if isinstance(review.get("placements"), dict) else {}
    placement = placements.get(group_id, {}) if isinstance(placements.get(group_id), dict) else {}
    ids = placement.get("script_segment_ids", []) if isinstance(placement.get("script_segment_ids"), list) else []
    speakers = list(dict.fromkeys(
        _speaker_name(segment_by_id.get(str(segment_id), {}).get("speaker"))
        for segment_id in ids
        if _speaker_name(segment_by_id.get(str(segment_id), {}).get("speaker"))
    ))
    if not speakers:
        return []
    weight = 1.35 / max(1, len(speakers))
    return [(speaker, weight, "human_placement") for speaker in speakers]


def _match_speakers(
    matches: dict[str, Any],
    group_id: str,
    segment_by_id: dict[str, dict[str, Any]],
) -> list[tuple[str, float, str]]:
    groups = matches.get("groups", {}) if isinstance(matches.get("groups"), dict) else {}
    row = groups.get(group_id, {}) if isinstance(groups.get(group_id), dict) else {}
    candidates = [item for item in row.get("candidates", []) if isinstance(item, dict)]
    candidates.sort(key=lambda item: float(item.get("total_score", 0) or 0), reverse=True)
    evidence: list[tuple[str, float, str]] = []
    for rank, candidate in enumerate(candidates[:2]):
        confidence = str(candidate.get("confidence", "") or "")
        score = max(0.0, min(1.0, float(candidate.get("total_score", 0) or 0)))
        if score < 0.42 or confidence == "context_only":
            continue
        factor = 1.0 if confidence in {"exact_dialogue", "manual"} else 0.68 if confidence == "possible_dialogue" else 0.45
        factor *= 1.0 if rank == 0 else 0.48
        speakers = list(dict.fromkeys(
            _speaker_name(segment_by_id.get(segment_id, {}).get("speaker"))
            for segment_id in _candidate_ids(candidate)
            if _speaker_name(segment_by_id.get(segment_id, {}).get("speaker"))
        ))
        if not speakers:
            continue
        weight = max(0.22, score) * factor / len(speakers)
        evidence.extend((speaker, weight, "script_match") for speaker in speakers)
    return evidence


def _group_relation_evidence(
    config: ProjectConfig,
) -> tuple[dict[str, list[tuple[str, float, str]]], dict[str, dict[str, Any]]]:
    segments = _script_segments(config)
    segment_by_id = {
        str(row.get("segment_id", "")): row
        for row in segments
        if str(row.get("segment_id", ""))
    }
    if not segment_by_id:
        return {}, {}
    matches = _read_json(config.output_dir / "matches.json")
    review = _read_json(config.output_dir / "review.json")
    group_ids = set()
    if isinstance(matches.get("groups"), dict):
        group_ids.update(str(value) for value in matches["groups"])
    if isinstance(review.get("placements"), dict):
        group_ids.update(str(value) for value in review["placements"])
    result: dict[str, list[tuple[str, float, str]]] = {}
    for group_id in group_ids:
        human = _placement_speakers(review, group_id, segment_by_id)
        # Human exact placement outranks automatic matching. Do not duplicate it
        # with a possibly contradictory matcher candidate.
        result[group_id] = human or _match_speakers(matches, group_id, segment_by_id)
    return result, segment_by_id


def _ambiguity_factor(kind: str, visible_identities: int) -> float:
    if visible_identities <= 1:
        return 1.0
    if kind == "face":
        return 0.28 if visible_identities == 2 else 0.12
    return 0.42 if visible_identities == 2 else 0.22


def _role_candidates(
    identity_id: str,
    kind: str,
    group_quality: dict[str, float],
    visible_counts: dict[str, int],
    relations: dict[str, list[tuple[str, float, str]]],
) -> list[dict[str, Any]]:
    scores: dict[str, float] = defaultdict(float)
    support: dict[str, set[str]] = defaultdict(set)
    unambiguous: dict[str, set[str]] = defaultdict(set)
    human_placement_support: dict[str, set[str]] = defaultdict(set)
    for group_id, quality in group_quality.items():
        rows = relations.get(group_id, [])
        if not rows:
            continue
        visible = max(1, int(visible_counts.get(group_id, 1) or 1))
        ambiguity = _ambiguity_factor(kind, visible)
        for role, relation_weight, source in rows:
            if not role:
                continue
            contribution = max(0.0, float(quality)) * ambiguity * max(0.0, float(relation_weight))
            if contribution <= 0:
                continue
            scores[role] += contribution
            support[role].add(group_id)
            if ambiguity >= 0.75:
                unambiguous[role].add(group_id)
            if source == "human_placement":
                human_placement_support[role].add(group_id)
    if not scores:
        return []
    ordered = sorted(scores, key=lambda role: (-scores[role], role))
    total = sum(scores.values()) or 1.0
    result = []
    for role in ordered[:4]:
        groups = support[role]
        second_score = max((scores[value] for value in ordered if value != role), default=0.0)
        dominance = scores[role] / max(1e-9, scores[role] + second_score)
        support_factor = min(1.0, len(groups) / 3.0)
        average_strength = min(1.0, scores[role] / max(1, len(groups)))
        confidence = 0.45 * dominance + 0.35 * support_factor + 0.20 * average_strength
        if len(groups) < 2:
            confidence *= 0.72
        result.append(
            {
                "role_name": role,
                "confidence": round(max(0.0, min(0.98, confidence)), 4),
                "score": round(scores[role], 4),
                "share": round(scores[role] / total, 4),
                "supporting_takes": len(groups),
                "unambiguous_takes": len(unambiguous[role]),
                "human_placement_takes": len(human_placement_support[role]),
                "source": "script_take_cooccurrence",
            }
        )
    return result


def enrich_identity_rows(library: IdentityLibrary, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    config = _project_config(library)
    if config is None or not rows:
        return rows
    try:
        relations, _segments = _group_relation_evidence(config)
        if not relations:
            return rows
        kinds = {str(row.get("kind", "")) for row in rows if str(row.get("kind", "")) in {"face", "speaker"}}
        quality_by_kind: dict[str, dict[str, dict[str, float]]] = {}
        counts_by_kind: dict[str, dict[str, int]] = {}
        for kind in kinds:
            quality_by_kind[kind], counts_by_kind[kind] = _identity_group_quality(library, kind)
        result = []
        for raw in rows:
            row = dict(raw)
            identity_id = str(row.get("identity_id", "") or "")
            kind = str(row.get("kind", "") or "")
            candidates = _role_candidates(
                identity_id,
                kind,
                quality_by_kind.get(kind, {}).get(identity_id, {}),
                counts_by_kind.get(kind, {}),
                relations,
            )
            row["role_candidates"] = candidates[:3]
            # A face suggestion needs evidence from multiple Takes and at least
            # one unambiguous/solo-face Take. This avoids naming everybody in a
            # two-shot after the speaker's dialogue.
            best = candidates[0] if candidates else None
            safe = bool(
                best
                and best["supporting_takes"] >= 2
                and best["confidence"] >= 0.58
                and best["share"] >= 0.60
                and (kind != "face" or best["unambiguous_takes"] >= 1)
            )
            if safe and not str(row.get("role_name", "") or "").strip():
                row["suggested_role_name"] = str(best["role_name"])
                row["suggested_role_confidence"] = float(best["confidence"])
                row["suggested_role_source"] = str(best["source"])
            else:
                row["suggested_role_name"] = ""
                row["suggested_role_confidence"] = 0.0
                row["suggested_role_source"] = ""
            result.append(row)
        return result
    except Exception:
        # Identity browsing must remain available even if script evidence is
        # incomplete. Suggestions are derived convenience, never authority.
        return rows


def install_identity_role_inference() -> None:
    global _INSTALLED
    if _INSTALLED:
        return
    original_list: Callable[..., list[dict[str, Any]]] = IdentityLibrary.list

    def list_with_role_candidates(self: IdentityLibrary, kind: str = "") -> list[dict[str, Any]]:
        return enrich_identity_rows(self, original_list(self, kind))

    IdentityLibrary.list = list_with_role_candidates  # type: ignore[method-assign]
    _INSTALLED = True


__all__ = ["enrich_identity_rows", "install_identity_role_inference"]