from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any

from .automation_store import AutomationStore
from .config import ProjectConfig
from .identity_library import IdentityLibrary
from .media_identity import device_state_dir
from .workspace_db import WorkspaceDatabase


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _norm(value: object) -> str:
    return re.sub(r"[\s·•・:：,，。.!！?？()（）\[\]【】]+", "", str(value or "")).casefold()


def _candidate_ids(candidate: dict[str, Any]) -> list[str]:
    raw = candidate.get("script_segment_ids")
    if isinstance(raw, list):
        return [str(value) for value in raw if str(value)]
    single = str(candidate.get("script_segment_id", "") or "")
    return [single] if single else []


def _database_for_config(config: ProjectConfig) -> WorkspaceDatabase | None:
    root = device_state_dir() / "workspaces"
    if not root.is_dir():
        return None
    wanted = str(config.config_path.resolve())
    for path in root.glob("*/workspace.sqlite3"):
        try:
            connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=1.0)
            try:
                row = connection.execute(
                    "SELECT 1 FROM projects WHERE config_path=? LIMIT 1", (wanted,)
                ).fetchone()
            finally:
                connection.close()
        except sqlite3.Error:
            continue
        if row is not None:
            return WorkspaceDatabase("resolved-local-workspace", path)
    return None


def _confirmed_roles(evidence: dict[str, list[dict[str, Any]]]) -> dict[str, dict[str, float]]:
    result: dict[str, dict[str, float]] = {"speaker": {}, "face": {}}
    for kind in ("speaker", "face"):
        for row in evidence.get(kind, []):
            if not row.get("confirmed"):
                continue
            role = _norm(row.get("role_name"))
            if not role:
                continue
            confidence = max(0.0, min(1.0, float(row.get("confidence", 0) or 0)))
            result[kind][role] = max(result[kind].get(role, 0.0), confidence)
    return result


def _candidate_speakers(
    candidate: dict[str, Any], segment_by_id: dict[str, dict[str, Any]]
) -> set[str]:
    result = set()
    for segment_id in _candidate_ids(candidate):
        segment = segment_by_id.get(segment_id, {})
        speaker = _norm(segment.get("speaker"))
        if speaker:
            result.add(speaker)
    return result


def _support(
    candidate: dict[str, Any],
    segment_by_id: dict[str, dict[str, Any]],
    roles: dict[str, dict[str, float]],
) -> dict[str, Any]:
    speakers = _candidate_speakers(candidate, segment_by_id)
    speaker_matches = {
        role: confidence for role, confidence in roles["speaker"].items() if role in speakers
    }
    face_matches = {
        role: confidence for role, confidence in roles["face"].items() if role in speakers
    }
    speaker_score = max(speaker_matches.values(), default=0.0)
    face_score = max(face_matches.values(), default=0.0)
    score = speaker_score + 0.45 * face_score
    return {
        "score": score,
        "speaker_score": speaker_score,
        "face_score": face_score,
        "script_speakers": sorted(speakers),
        "speaker_roles": sorted(speaker_matches),
        "visible_roles": sorted(face_matches),
    }


def apply_identity_rescue(
    config: ProjectConfig,
    automation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Apply device-local confirmed role evidence to ambiguous automation only.

    Shared deterministic matches.json is never modified. A confirmed speaker can
    promote one already-existing matcher candidate when it is uniquely supported.
    Face evidence is supporting context only. No identity evidence can override a
    human mapping or a previously confirmed deterministic/AI mapping.
    """

    store = AutomationStore(config.output_dir)
    current = automation if isinstance(automation, dict) else store.load()
    groups = dict(current.get("groups", {})) if isinstance(current.get("groups"), dict) else {}
    if not groups:
        return current

    database = _database_for_config(config)
    if database is None:
        return current

    project_id = config.project_dir.name
    # The local database project ID may differ from the directory name. Resolve
    # it by the exact config_path we used to locate the database.
    with database.connection() as connection:
        row = connection.execute(
            "SELECT project_id FROM projects WHERE config_path=? LIMIT 1",
            (str(config.config_path.resolve()),),
        ).fetchone()
    if row is None:
        return current
    project_id = str(row[0])
    library = IdentityLibrary(database, project_id)

    script = _read_json(config.output_dir / "script.json")
    matches = _read_json(config.output_dir / "matches.json")
    segment_by_id = {
        str(item.get("segment_id")): item
        for item in script.get("segments", [])
        if isinstance(item, dict) and item.get("segment_id")
    }
    match_groups = matches.get("groups", {}) if isinstance(matches.get("groups"), dict) else {}
    changed = False

    for group_id, decision in list(groups.items()):
        if not isinstance(decision, dict):
            continue
        if str(decision.get("status", "")) not in {"needs_review", "unresolved"}:
            continue
        evidence = library.group_identities(group_id)
        roles = _confirmed_roles(evidence)
        if not roles["speaker"] and not roles["face"]:
            continue
        row = match_groups.get(group_id, {}) if isinstance(match_groups.get(group_id), dict) else {}
        candidates = [item for item in row.get("candidates", []) if isinstance(item, dict)]
        candidates = [item for item in candidates if _candidate_ids(item)]

        public_evidence = {
            "speaker_roles": sorted(roles["speaker"]),
            "visible_roles": sorted(roles["face"]),
        }
        updated = dict(decision)
        updated_evidence = dict(updated.get("evidence", {})) if isinstance(updated.get("evidence"), dict) else {}
        updated_evidence["identity"] = public_evidence
        updated["evidence"] = updated_evidence

        scored = [(_support(candidate, segment_by_id, roles), candidate) for candidate in candidates[:8]]
        scored.sort(key=lambda item: item[0]["score"], reverse=True)
        if scored:
            best_support, best = scored[0]
            runner_score = scored[1][0]["score"] if len(scored) > 1 else 0.0
            total_score = float(best.get("total_score", 0) or 0)
            dialogue_score = float(best.get("dialogue_score", 0) or 0)
            strong_speaker = best_support["speaker_score"] >= 0.80
            unique = best_support["score"] - runner_score >= 0.18
            matcher_support = (
                total_score >= config.possible_confidence * 0.60 or dialogue_score >= 0.30
            )
            if strong_speaker and unique and matcher_support:
                ids = _candidate_ids(best)
                updated.update(
                    {
                        "status": "ai_confirmed",
                        "mapping_status": "confirmed",
                        "mapping_source": "identity_rescue",
                        "candidate_id": str(best.get("candidate_id", "") or ""),
                        "script_segment_ids": ids,
                        "episode_ids": sorted(
                            {
                                int(segment_by_id[item].get("episode", 0) or 0)
                                for item in ids
                                if item in segment_by_id
                                and int(segment_by_id[item].get("episode", 0) or 0) > 0
                            }
                        ),
                        "confidence": min(
                            0.96,
                            max(
                                float(updated.get("confidence", 0) or 0),
                                0.70 + 0.22 * best_support["speaker_score"],
                            ),
                        ),
                        "reason": "已确认角色声纹唯一支持现有剧本候选，并通过本地匹配证据门槛",
                    }
                )
                updated["evidence"]["identity"].update(best_support)
            else:
                updated["evidence"]["identity"]["candidate_support"] = [
                    {
                        "candidate_id": str(candidate.get("candidate_id", "") or ""),
                        **support,
                    }
                    for support, candidate in scored[:3]
                    if support["score"] > 0
                ]
        elif roles["speaker"]:
            context_ids = [
                str(value)
                for value in row.get("context_segment_ids", [])
                if str(value) in segment_by_id
            ]
            suggestions = []
            for segment_id in context_ids:
                segment = segment_by_id[segment_id]
                role = _norm(segment.get("speaker"))
                if role and role in roles["speaker"] and roles["speaker"][role] >= 0.80:
                    suggestions.append(segment_id)
            suggestions = list(dict.fromkeys(suggestions))
            if len(suggestions) == 1:
                segment_id = suggestions[0]
                segment = segment_by_id[segment_id]
                updated.update(
                    {
                        "status": "needs_review",
                        "mapping_status": "ambiguous",
                        "mapping_source": "identity_rescue",
                        "script_segment_ids": [segment_id],
                        "episode_ids": [int(segment.get("episode", 0) or 0)],
                        "confidence": max(float(updated.get("confidence", 0) or 0), 0.66),
                        "reason": "已确认角色声纹在近邻剧本中找到唯一角色行；无对白候选，保留人工确认",
                    }
                )
                updated["evidence"]["identity"]["context_suggestion"] = segment_id
        if updated != decision:
            groups[group_id] = updated
            changed = True

    if not changed:
        return current
    return store.save(
        str(current.get("analysis_revision", "") or ""),
        groups,
        current.get("model", {}) if isinstance(current.get("model"), dict) else {},
    )
