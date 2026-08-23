from __future__ import annotations

import hashlib
import json
import re
import shutil
import tempfile
from collections import defaultdict
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Callable

from .audit_provider import SHOT_TYPES, TakeAuditProvider
from .audit_store import AuditStore
from .automation_store import AutomationStore, COMPLETED_STATUSES
from .config import ProjectConfig
from .identity_library import IdentityLibrary
from .media_identity import DeviceMediaStore
from .perception_index import _default_extract_frames
from .review_store import ReviewStore
from .workspace_db import WorkspaceDatabase


ProgressCallback = Callable[[int, int, str], None]
CancelCallback = Callable[[], bool]


FAILURE_TAXONOMY = {
    "mapping_conflict": "人工归集与自动归集冲突",
    "needs_review": "自动候选仍有歧义",
    "unresolved": "缺少可靠归集证据",
    "candidate_competition": "候选分数过近",
    "no_candidate": "没有可用剧本候选",
    "no_dialogue_evidence": "缺少可靠对白证据",
    "missing_media": "当前 Host 缺少可读取素材",
    "multicam_speaker_visual_mismatch": "多机位画面人物与说话人可能不一致",
    "possible_pickup": "可能是补拍或非单调拍摄",
    "continuity_risk": "连续性存在风险",
    "technical_quality": "画面或声音技术质量问题",
    "algorithm_disagreement": "AI 审计不同意当前算法判断",
    "other": "其它素材问题",
}


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _int(value: object, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _normalize_text(value: object) -> str:
    return re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "", str(value or "")).casefold()


def _analysis_revision(output_dir: Path) -> str:
    signature = []
    for name in ("material_index.json", "script.json", "matches.json"):
        path = output_dir / name
        try:
            stat = path.stat()
            signature.append((name, stat.st_size, stat.st_mtime_ns))
        except OSError:
            signature.append((name, -1, -1))
    return hashlib.sha1(repr(tuple(signature)).encode("utf-8")).hexdigest()[:16]


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _candidate_ids(candidate: dict[str, Any]) -> list[str]:
    values = candidate.get("script_segment_ids") or (
        [candidate.get("script_segment_id")] if candidate.get("script_segment_id") else []
    )
    return list(dict.fromkeys(str(value) for value in values if str(value)))


def _manual_mapping(review: dict[str, Any], group: dict[str, Any]) -> dict[str, Any]:
    group_id = str(group.get("group_id", "") or "")
    parent = str(group.get("parent_group_id", "") or "")
    placements = _as_dict(review.get("placements"))
    placement = _as_dict(placements.get(group_id))
    inherited = False
    if not placement and parent:
        placement = _as_dict(placements.get(parent))
        inherited = bool(placement)
    segment_ids = [str(value) for value in _as_list(placement.get("script_segment_ids")) if str(value)]
    episode_ids = sorted({_int(value) for value in _as_list(placement.get("episode_ids")) if _int(value) > 0})
    for segment_id, rows in _as_dict(review.get("assignments")).items():
        row = _as_dict(rows)
        if group_id in row or (parent and parent in row):
            segment_ids.append(str(segment_id))
    return {
        "source": "human" if segment_ids or episode_ids else "none",
        "script_segment_ids": list(dict.fromkeys(segment_ids)),
        "episode_ids": episode_ids,
        "inherited": inherited,
    }


def _mapping_for_group(
    review: dict[str, Any],
    automation_entry: dict[str, Any],
    group: dict[str, Any],
) -> dict[str, Any]:
    manual = _manual_mapping(review, group)
    if manual["source"] == "human":
        return {**manual, "confidence": 1.0, "status": "human_override"}
    status = str(automation_entry.get("status", "") or "")
    if status in COMPLETED_STATUSES:
        return {
            "source": "automatic",
            "status": status,
            "script_segment_ids": [str(value) for value in _as_list(automation_entry.get("script_segment_ids")) if str(value)],
            "episode_ids": sorted({_int(value) for value in _as_list(automation_entry.get("episode_ids")) if _int(value) > 0}),
            "confidence": _float(automation_entry.get("confidence"), 0.0),
        }
    return {
        "source": "none",
        "status": status or "unresolved",
        "script_segment_ids": [],
        "episode_ids": [],
        "confidence": _float(automation_entry.get("confidence"), 0.0),
    }


def _script_excerpt(segment_ids: list[str], segments: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for segment_id in segment_ids:
        segment = segments.get(segment_id)
        if not segment:
            continue
        result.append(
            {
                "segment_id": segment_id,
                "episode": _int(segment.get("episode"), 0),
                "scene_id": str(segment.get("scene_id", "") or ""),
                "order": _int(segment.get("order"), 0),
                "speaker": str(segment.get("speaker", "") or ""),
                "text": str(segment.get("text", "") or segment.get("raw_text", "") or "")[:500],
            }
        )
    return result


def _safe_candidate(candidate: dict[str, Any], segments: dict[str, dict[str, Any]]) -> dict[str, Any]:
    ids = _candidate_ids(candidate)
    return {
        "candidate_id": str(candidate.get("candidate_id", "") or ""),
        "script_segment_ids": ids,
        "confidence": str(candidate.get("confidence", "") or ""),
        "total_score": _float(candidate.get("total_score"), 0.0),
        "dialogue_score": _float(candidate.get("dialogue_score"), 0.0),
        "sequence_score": _float(candidate.get("sequence_score"), 0.0),
        "margin": _float(candidate.get("margin"), 0.0),
        "transcript_text": str(candidate.get("transcript_text", "") or "")[:1000],
        "script": _script_excerpt(ids, segments),
    }


def _issue(code: str, severity: str, detail: str, source: str = "deterministic") -> dict[str, Any]:
    return {
        "code": code if code in FAILURE_TAXONOMY else "other",
        "severity": severity if severity in {"info", "warning", "error"} else "warning",
        "label": FAILURE_TAXONOMY.get(code, FAILURE_TAXONOMY["other"]),
        "detail": str(detail or "")[:500],
        "source": source,
    }


def _shot_type(value: object) -> str:
    raw = str(value or "").strip().lower()
    if raw in SHOT_TYPES:
        return raw
    aliases = {
        "全景": "wide",
        "远景": "wide",
        "大全景": "wide",
        "全身": "full",
        "中景": "medium",
        "中近景": "medium_closeup",
        "近景": "closeup",
        "近摄": "closeup",
        "特写": "extreme_closeup",
        "大特写": "extreme_closeup",
        "细节": "insert",
        "插入": "insert",
    }
    for key, mapped in aliases.items():
        if key in str(value or ""):
            return mapped
    return "unknown"


class AuditEngine:
    """AI shadow judge + material issue ledger + learning-data producer.

    The engine is intentionally outside the deterministic resolver. It can
    disagree with the algorithm and collect hard cases, but never promotes its
    own judgment into review or automatic authority.
    """

    def __init__(
        self,
        workspace_id: str,
        project_id: str,
        config: ProjectConfig,
        *,
        database: WorkspaceDatabase | None = None,
        media_store: DeviceMediaStore | None = None,
        provider: TakeAuditProvider | None = None,
    ) -> None:
        self.workspace_id = str(workspace_id or "")
        self.project_id = str(project_id or "")
        self.config = config
        self.database = database or WorkspaceDatabase(self.workspace_id)
        self.media_store = media_store or DeviceMediaStore()
        self.provider = provider or TakeAuditProvider()
        self.store = AuditStore(config.output_dir)
        self.identity_library = IdentityLibrary(self.database, self.project_id)

    def _inputs(self) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
        index = _read_json(self.config.output_dir / "material_index.json")
        script = _read_json(self.config.output_dir / "script.json")
        matches = _read_json(self.config.output_dir / "matches.json")
        review = ReviewStore(self.config.output_dir / "review.json").load()
        automation = AutomationStore(self.config.output_dir).load()
        return index, script, matches, review, automation

    def _speaker_observations(self, group_id: str) -> list[dict[str, Any]]:
        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT o.identity_id, o.confidence, o.metadata_json,
                       i.role_name, i.metadata_json AS identity_metadata_json
                FROM identity_observations AS o
                LEFT JOIN identities AS i
                  ON i.project_id=o.project_id AND i.identity_id=o.identity_id
                WHERE o.project_id=? AND o.group_id=? AND o.kind='speaker'
                ORDER BY o.confidence DESC, o.observation_id
                """,
                (self.project_id, group_id),
            ).fetchall()
        result = []
        for row in rows:
            try:
                observation_metadata = json.loads(str(row["metadata_json"] or "{}"))
            except ValueError:
                observation_metadata = {}
            try:
                identity_metadata = json.loads(str(row["identity_metadata_json"] or "{}"))
            except ValueError:
                identity_metadata = {}
            result.append(
                {
                    "identity_id": str(row["identity_id"] or ""),
                    "confidence": _float(row["confidence"], 0.0),
                    "text": str(observation_metadata.get("text", "") or "")[:700],
                    "role_name": str(row["role_name"] or ""),
                    "confirmed": bool(identity_metadata.get("human_confirmed")),
                }
            )
        return result

    def _role_suggestions(
        self,
        group_id: str,
        mapping: dict[str, Any],
        segments: dict[str, dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if mapping.get("source") not in {"human", "automatic"}:
            return []
        mapping_confidence = _float(mapping.get("confidence"), 0.0)
        if mapping.get("source") == "automatic" and mapping_confidence < 0.78:
            return []
        role_texts: dict[str, list[str]] = defaultdict(list)
        role_display: dict[str, str] = {}
        for segment_id in mapping.get("script_segment_ids", []):
            segment = segments.get(str(segment_id), {})
            speaker = str(segment.get("speaker", "") or "").strip()
            role = _normalize_text(speaker)
            text = str(segment.get("text", "") or segment.get("raw_text", "") or "")
            if role and text.strip():
                role_texts[role].append(text)
                role_display[role] = speaker
        if not role_texts:
            return []

        by_identity: dict[str, dict[str, Any]] = {}
        for observation in self._speaker_observations(group_id):
            identity_id = str(observation.get("identity_id", "") or "")
            if not identity_id or observation.get("confirmed") or observation.get("role_name"):
                continue
            row = by_identity.setdefault(
                identity_id,
                {"confidence": 0.0, "texts": []},
            )
            row["confidence"] = max(row["confidence"], _float(observation.get("confidence"), 0.0))
            text = str(observation.get("text", "") or "").strip()
            if text:
                row["texts"].append(text)

        suggestions = []
        for identity_id, observation in by_identity.items():
            observation_confidence = _float(observation.get("confidence"), 0.0)
            if observation_confidence < 0.72:
                continue
            spoken = _normalize_text(" ".join(observation.get("texts", [])))
            if len(spoken) < 4:
                continue
            scored = []
            for role, texts in role_texts.items():
                script_text = _normalize_text(" ".join(texts))
                if not script_text:
                    continue
                similarity = SequenceMatcher(None, spoken, script_text).ratio()
                scored.append((similarity, role))
            scored.sort(reverse=True)
            if not scored:
                continue
            best_score, best_role = scored[0]
            runner = scored[1][0] if len(scored) > 1 else 0.0
            threshold = 0.52 if len(scored) == 1 else 0.60
            if best_score < threshold or (len(scored) > 1 and best_score - runner < 0.12):
                continue
            confidence = min(
                0.96,
                0.45 * observation_confidence
                + 0.35 * best_score
                + 0.20 * (1.0 if mapping.get("source") == "human" else mapping_confidence),
            )
            suggestions.append(
                {
                    "identity_id": identity_id,
                    "kind": "speaker",
                    "role_name": role_display.get(best_role, best_role),
                    "confidence": round(confidence, 4),
                    "source": "script_dialogue_alignment",
                    "requires_confirmation": True,
                    "evidence": {
                        "dialogue_similarity": round(best_score, 4),
                        "speaker_cluster_confidence": round(observation_confidence, 4),
                        "mapping_source": str(mapping.get("source", "")),
                    },
                }
            )
        return suggestions

    def _deterministic_issues(
        self,
        group: dict[str, Any],
        candidates: list[dict[str, Any]],
        automation_entry: dict[str, Any],
        manual: dict[str, Any],
    ) -> tuple[int, list[dict[str, Any]]]:
        issues: list[dict[str, Any]] = []
        priority = 10
        status = str(automation_entry.get("status", "") or "")
        auto_ids = [str(value) for value in _as_list(automation_entry.get("script_segment_ids")) if str(value)]
        manual_ids = [str(value) for value in manual.get("script_segment_ids", []) if str(value)]
        if manual_ids and auto_ids and set(manual_ids) != set(auto_ids):
            issues.append(_issue("mapping_conflict", "error", "人工归集范围与当前自动确认范围不同"))
            priority = max(priority, 100)
        elif manual_ids:
            priority = max(priority, 45)
        if status == "unresolved":
            issues.append(_issue("unresolved", "warning", "自动流程没有得到可确认的剧本位置"))
            priority = max(priority, 90)
        elif status == "needs_review":
            issues.append(_issue("needs_review", "warning", "自动流程存在候选冲突，需要人工或审计补证据"))
            priority = max(priority, 82)
        if not candidates:
            issues.append(_issue("no_candidate", "warning", "当前 Take 没有可用剧本候选"))
            priority = max(priority, 60)
        elif len(candidates) > 1:
            first = _float(candidates[0].get("total_score"), 0.0)
            second = _float(candidates[1].get("total_score"), 0.0)
            if first - second < 0.08:
                issues.append(_issue("candidate_competition", "warning", f"前两名候选分差仅 {first - second:.3f}"))
                priority = max(priority, 70)
        transcript = next((str(item.get("transcript_text", "") or "") for item in candidates if item.get("transcript_text")), "")
        if not transcript.strip():
            issues.append(_issue("no_dialogue_evidence", "info", "没有可靠对白文本，后续判断应更多依赖画面和拍摄上下文"))
            priority = max(priority, 28)
        missing = 0
        for member in _as_list(group.get("members")):
            if not isinstance(member, dict):
                continue
            if not self.media_store.resolve(self.workspace_id, self.project_id, member):
                missing += 1
        if missing:
            issues.append(_issue("missing_media", "error", f"{missing} 个机位在当前 Host 无法解析本机素材"))
            priority = max(priority, 95)
        return priority, issues

    def _evidence_pack(
        self,
        group: dict[str, Any],
        candidates: list[dict[str, Any]],
        automation_entry: dict[str, Any],
        manual: dict[str, Any],
        mapping: dict[str, Any],
        segments: dict[str, dict[str, Any]],
    ) -> dict[str, Any]:
        group_id = str(group.get("group_id", "") or "")
        identity = self.identity_library.group_identities(group_id)
        semantic = self.database.semantic(self.project_id, group_id)
        return {
            "group_id": group_id,
            "take": {
                "start": _float(group.get("start"), 0.0),
                "end": _float(group.get("end"), 0.0),
                "duration": _float(group.get("duration"), 0.0),
                "kind": str(group.get("kind", "") or ""),
                "parent_group_id": str(group.get("parent_group_id", "") or ""),
                "take_index": _int(group.get("take_index"), 1),
                "split_reason": str(group.get("split_reason", "") or ""),
                "angles": [
                    {
                        "clip_id": str(member.get("clip_id", "") or ""),
                        "camera": str(member.get("camera", "") or ""),
                        "name": str(member.get("name", "") or Path(str(member.get("media_path", "") or "")).name),
                        "duration": _float(member.get("duration"), 0.0),
                        "source_start": _float(member.get("source_start"), 0.0),
                        "source_end": _float(member.get("source_end"), 0.0) if member.get("source_end") is not None else None,
                    }
                    for member in _as_list(group.get("members"))
                    if isinstance(member, dict)
                ],
            },
            "algorithm": {
                "status": str(automation_entry.get("status", "") or ""),
                "mapping_status": str(automation_entry.get("mapping_status", "") or ""),
                "mapping_source": str(automation_entry.get("mapping_source", "") or ""),
                "script_segment_ids": [str(value) for value in _as_list(automation_entry.get("script_segment_ids")) if str(value)],
                "confidence": _float(automation_entry.get("confidence"), 0.0),
                "reason": str(automation_entry.get("reason", "") or "")[:500],
            },
            "human_mapping": manual,
            "effective_mapping": mapping,
            "mapped_script": _script_excerpt(mapping.get("script_segment_ids", []), segments),
            "candidates": candidates[:5],
            "people": {
                "speakers": identity.get("speaker", []),
                "faces": identity.get("face", []),
            },
            "semantic": semantic if semantic.get("status") == "ready" else {"status": semantic.get("status", "missing")},
            "rules": {
                "individual_opinions_are_authority": False,
                "ai_audit_is_authority": False,
                "multicam_visible_person_may_differ_from_speaker": True,
            },
        }

    def _fingerprint(self, evidence: dict[str, Any]) -> str:
        return hashlib.sha1(
            json.dumps(evidence, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()[:20]

    def _angle_frames(self, group: dict[str, Any], root: Path) -> list[dict[str, Any]]:
        frames: list[dict[str, Any]] = []
        cached = self.database.frames(self.project_id, str(group.get("group_id", "") or ""))
        cached_by_clip: dict[str, dict[str, Any]] = {}
        for row in cached:
            path = Path(str(row.get("path", "")))
            clip_id = str(row.get("clip_id", "") or "")
            if clip_id and path.is_file() and clip_id not in cached_by_clip:
                cached_by_clip[clip_id] = row
        members = [member for member in _as_list(group.get("members")) if isinstance(member, dict)]
        members.sort(key=lambda item: (str(item.get("camera", "")), _float(item.get("timeline_start"), 0.0), str(item.get("clip_id", ""))))
        for member in members[:6]:
            clip_id = str(member.get("clip_id", "") or "")
            camera = str(member.get("camera", "") or "")
            cached_row = cached_by_clip.get(clip_id)
            if cached_row:
                frames.append(
                    {
                        "path": str(cached_row.get("path", "")),
                        "source_time": _float(cached_row.get("source_time"), 0.0),
                        "clip_id": clip_id,
                        "camera": camera,
                    }
                )
                continue
            media_path = self.media_store.resolve(self.workspace_id, self.project_id, member)
            if not media_path:
                continue
            start = _float(member.get("source_start"), 0.0)
            raw_end = member.get("source_end")
            end = _float(raw_end, start + _float(member.get("duration"), 0.0)) if raw_end is not None else start + _float(member.get("duration"), 0.0)
            rows = _default_extract_frames(media_path, start, end, 1, root / (clip_id or camera or "angle"))
            for row in rows[:1]:
                path = Path(str(row.get("path", "")))
                if path.is_file():
                    frames.append(
                        {
                            "path": str(path),
                            "source_time": _float(row.get("source_time"), start),
                            "clip_id": clip_id,
                            "camera": camera,
                        }
                    )
        return frames

    def _fallback_shot_intelligence(self, group: dict[str, Any]) -> dict[str, Any]:
        members = [member for member in _as_list(group.get("members")) if isinstance(member, dict)]
        if len(members) != 1:
            return {"angles": {}}
        semantic = self.database.semantic(self.project_id, str(group.get("group_id", "") or ""))
        data = _as_dict(semantic.get("data")) if semantic.get("status") == "ready" else {}
        shot = _shot_type(data.get("shot_type"))
        if shot == "unknown":
            return {"angles": {}}
        member = members[0]
        clip_id = str(member.get("clip_id", "") or "")
        return {
            "angles": {
                clip_id: {
                    "clip_id": clip_id,
                    "camera": str(member.get("camera", "") or ""),
                    "shot_type": shot,
                    "coverage_role": "unknown",
                    "visible_people": [str(value) for value in _as_list(data.get("visible_people")) if str(value)][:8],
                    "technical_issues": [],
                }
            }
        }

    def _priority_rows(
        self,
        groups: list[dict[str, Any]],
        group_matches: dict[str, Any],
        automation_groups: dict[str, Any],
        review: dict[str, Any],
        segments: dict[str, dict[str, Any]],
    ) -> list[tuple[int, dict[str, Any], list[dict[str, Any]], dict[str, Any], dict[str, Any], dict[str, Any]]]:
        rows = []
        for group in groups:
            group_id = str(group.get("group_id", "") or "")
            raw_candidates = [item for item in _as_list(_as_dict(group_matches.get(group_id)).get("candidates")) if isinstance(item, dict)]
            candidates = [_safe_candidate(item, segments) for item in raw_candidates]
            candidates.sort(key=lambda item: _float(item.get("total_score"), 0.0), reverse=True)
            automatic = _as_dict(automation_groups.get(group_id))
            manual = _manual_mapping(review, group)
            mapping = _mapping_for_group(review, automatic, group)
            priority, issues = self._deterministic_issues(group, candidates, automatic, manual)
            rows.append((priority, group, candidates, automatic, manual, mapping, issues))
        return rows

    def run(
        self,
        *,
        mode: str = "priority",
        group_ids: list[str] | None = None,
        max_groups: int = 60,
        progress: ProgressCallback | None = None,
        cancelled: CancelCallback | None = None,
    ) -> dict[str, Any]:
        if mode not in {"priority", "all"}:
            raise ValueError("audit mode 必须是 priority 或 all")
        index, script, matches, review, automation = self._inputs()
        groups = [item for item in _as_list(index.get("groups")) if isinstance(item, dict) and item.get("group_id")]
        if not groups:
            return {"status": "deferred", "reason": "项目尚未生成 Take 索引"}
        self.database.sync_take_index(
            self.project_id,
            name=self.config.name,
            input_kind=self.config.input_kind,
            config_path=str(self.config.config_path),
            index=index,
        )
        segments = {
            str(item.get("segment_id")): item
            for item in _as_list(script.get("segments"))
            if isinstance(item, dict) and item.get("segment_id")
        }
        group_matches = _as_dict(matches.get("groups"))
        automation_groups = _as_dict(automation.get("groups"))
        rows = self._priority_rows(groups, group_matches, automation_groups, review, segments)
        requested = {str(value) for value in (group_ids or []) if str(value)}
        if requested:
            rows = [row for row in rows if str(row[1].get("group_id", "")) in requested]
            rows.sort(key=lambda row: (_float(row[1].get("start"), 0.0), str(row[1].get("group_id", ""))))
        elif mode == "priority":
            rows.sort(key=lambda row: (-row[0], _float(row[1].get("start"), 0.0), str(row[1].get("group_id", ""))))
            if max_groups > 0:
                rows = rows[:max_groups]
        else:
            rows.sort(key=lambda row: (_float(row[1].get("start"), 0.0), str(row[1].get("group_id", ""))))
            if max_groups > 0:
                rows = rows[:max_groups]

        analysis_revision = _analysis_revision(self.config.output_dir)
        existing = self.store.load()
        saved_groups = dict(_as_dict(existing.get("groups")))
        processed = 0
        judged = 0
        cached = 0
        failed = 0
        changed = False
        total = len(rows)

        for priority, group, candidates, automatic, manual, mapping, deterministic_issues in rows:
            if cancelled and cancelled():
                return {
                    "status": "cancelled",
                    "processed": processed,
                    "judged": judged,
                    "cached": cached,
                    "failed": failed,
                }
            group_id = str(group.get("group_id", "") or "")
            evidence = self._evidence_pack(group, candidates, automatic, manual, mapping, segments)
            fingerprint = self._fingerprint(evidence)
            old = _as_dict(saved_groups.get(group_id))
            if old.get("evidence_fingerprint") == fingerprint and old.get("analysis_revision") == analysis_revision:
                cached += 1
                if progress:
                    progress(processed + cached + failed, total, group_id)
                continue

            role_suggestions = self._role_suggestions(group_id, mapping, segments)
            judge: dict[str, Any] = {
                "verdict": "not_run",
                "confidence": 0.0,
                "reason": "AI 审计运行时未启用或没有可用画面证据",
                "provider": "",
                "model": "",
            }
            issues = list(deterministic_issues)
            shot_intelligence = self._fallback_shot_intelligence(group)
            rough_cut = {
                "technical_usability": "unknown",
                "take_completeness": "unknown",
                "coverage_role": "unknown",
                "continuity_risk": "unknown",
            }
            algorithm_feedback = {
                "failure_class": "",
                "suspected_missing_feature": "",
                "counterexample": "",
            }

            if self.provider.enabled:
                temporary_root = Path(tempfile.mkdtemp(prefix="mirrororder-audit-"))
                try:
                    frames = self._angle_frames(group, temporary_root)
                    result = self.provider.audit(evidence, frames) if frames else None
                finally:
                    shutil.rmtree(temporary_root, ignore_errors=True)
                if result:
                    judged += 1
                    judge = {
                        "verdict": str(result.get("verdict", "insufficient_evidence") or "insufficient_evidence"),
                        "confidence": _float(result.get("confidence"), 0.0),
                        "reason": str(result.get("reason", "") or "")[:1000],
                        "provider": str(result.get("provider", "") or ""),
                        "model": str(result.get("model", "") or ""),
                    }
                    for raw_issue in _as_list(result.get("issues")):
                        if not isinstance(raw_issue, dict):
                            continue
                        code = str(raw_issue.get("code", "other") or "other")
                        if code not in FAILURE_TAXONOMY:
                            code = "other"
                        issues.append(
                            _issue(
                                code,
                                str(raw_issue.get("severity", "warning") or "warning"),
                                str(raw_issue.get("detail", "") or ""),
                                "ai_audit",
                            )
                        )
                    if judge["verdict"] == "disagree":
                        issues.append(_issue("algorithm_disagreement", "warning", judge["reason"], "ai_audit"))
                    angles = {}
                    for angle in _as_list(result.get("angles")):
                        if isinstance(angle, dict) and angle.get("clip_id"):
                            angles[str(angle["clip_id"])] = dict(angle)
                    if angles:
                        shot_intelligence = {"angles": angles}
                    rough_cut = _as_dict(result.get("rough_cut")) or rough_cut
                    algorithm_feedback = _as_dict(result.get("algorithm_feedback")) or algorithm_feedback
                elif self.provider.enabled:
                    failed += 1

            deduped_issues = []
            seen_issues: set[tuple[str, str, str]] = set()
            for item in issues:
                key = (str(item.get("code", "")), str(item.get("source", "")), str(item.get("detail", "")))
                if key in seen_issues:
                    continue
                seen_issues.add(key)
                deduped_issues.append(item)

            saved_groups[group_id] = {
                "group_id": group_id,
                "analysis_revision": analysis_revision,
                "evidence_fingerprint": fingerprint,
                "priority": priority,
                "mapping": mapping,
                "judge": judge,
                "issues": deduped_issues,
                "algorithm_feedback": algorithm_feedback,
                "role_suggestions": role_suggestions,
                "shot_intelligence": shot_intelligence,
                "rough_cut": rough_cut,
            }
            processed += 1
            changed = True
            if progress:
                progress(processed + cached + failed, total, group_id)

        current_rows = [
            row for row in saved_groups.values()
            if isinstance(row, dict) and row.get("analysis_revision") == analysis_revision
        ]
        issue_count = sum(len(_as_list(row.get("issues"))) for row in current_rows)
        disagreements = sum(
            1 for row in current_rows
            if str(_as_dict(row.get("judge")).get("verdict", "")) == "disagree"
        )
        role_suggestion_count = sum(len(_as_list(row.get("role_suggestions"))) for row in current_rows)
        shot_angle_count = sum(
            len(_as_dict(_as_dict(row.get("shot_intelligence")).get("angles")))
            for row in current_rows
        )
        summary = {
            "current_groups": len(current_rows),
            "issues": issue_count,
            "disagreements": disagreements,
            "role_suggestions": role_suggestion_count,
            "shot_angles": shot_angle_count,
            "provider_enabled": bool(self.provider.enabled),
        }
        payload = {
            "analysis_revision": analysis_revision,
            "automation_updated_at": str(automation.get("updated_at", "") or ""),
            "review_revision": _int(review.get("revision"), 0),
            "summary": summary,
            "groups": saved_groups,
        }
        if changed or existing.get("analysis_revision") != analysis_revision or existing.get("summary") != summary:
            saved = self.store.save(payload)
        else:
            saved = existing

        try:
            from .learning_dataset import write_learning_dataset

            learning = write_learning_dataset(self.config, saved)
        except Exception:
            learning = {"cases": 0, "path": ""}

        return {
            "status": "completed",
            "mode": mode,
            "selected": total,
            "processed": processed,
            "judged": judged,
            "cached": cached,
            "failed": failed,
            "audit_revision": _int(saved.get("revision"), 0),
            "summary": summary,
            "learning": learning,
        }
