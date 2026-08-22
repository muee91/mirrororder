from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

from .automation_store import AutomationStore
from .config import ProjectConfig
from .model_provider import ModelProvider
from .review_store import ReviewStore
from .vision_provider import VisionProvider


def _read_json(path: Path, fallback: object) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


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


def _candidate_ids(candidate: dict[str, Any]) -> list[str]:
    ids = candidate.get("script_segment_ids") or ([candidate.get("script_segment_id")] if candidate.get("script_segment_id") else [])
    return [str(value) for value in ids if value]


def _episodes(ids: list[str], segment_by_id: dict[str, dict[str, Any]]) -> list[int]:
    result = set()
    for segment_id in ids:
        try:
            result.add(int(segment_by_id.get(segment_id, {}).get("episode")))
        except (TypeError, ValueError):
            continue
    return sorted(value for value in result if value > 0)


def _segment_position(segment: dict[str, Any]) -> tuple[int, int]:
    try:
        episode = int(segment.get("episode", 0) or 0)
    except (TypeError, ValueError):
        episode = 0
    try:
        order = int(segment.get("order", 0) or 0)
    except (TypeError, ValueError):
        order = 0
    return episode, order


def _sequence_consistent(
    candidate: dict[str, Any],
    segment_by_id: dict[str, dict[str, Any]],
    previous: tuple[int, int] | None,
    following: tuple[int, int] | None,
) -> bool:
    ids = _candidate_ids(candidate)
    positions = [_segment_position(segment_by_id[item]) for item in ids if item in segment_by_id]
    if not positions:
        return False
    first, last = min(positions), max(positions)
    if previous and following and previous[0] == following[0] == first[0]:
        return previous <= first and last <= following
    if previous and previous[0] == first[0] and first < previous:
        return False
    if following and following[0] == last[0] and last > following:
        return False
    return True


def _editorial_state(review: dict[str, Any], group: dict[str, Any]) -> str:
    group_id = str(group.get("group_id", "") or "")
    parent = str(group.get("parent_group_id", "") or "")
    entry = review.get("groups", {}).get(group_id, {}) or review.get("groups", {}).get(parent, {})
    state = str(entry.get("state", "unreviewed") or "unreviewed") if isinstance(entry, dict) else "unreviewed"
    return state if state in {"best", "keep", "reject"} else "unreviewed"


def _manual_mapping(
    group: dict[str, Any],
    review: dict[str, Any],
    segment_by_id: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    """Return only explicit human mapping evidence.

    Editorial group state (Best/Keep/Reject) is intentionally NOT mapping
    evidence. This prevents a Reject click from being misread as confirmation of
    an automatic script candidate.
    """
    group_id = str(group.get("group_id", "") or "")
    parent = str(group.get("parent_group_id", "") or "")
    placement = review.get("placements", {}).get(group_id, {}) or review.get("placements", {}).get(parent, {})
    ids: list[str] = []
    episode_ids: list[int] = []
    if isinstance(placement, dict):
        ids.extend(str(value) for value in placement.get("script_segment_ids", []) if value)
        for value in placement.get("episode_ids", []):
            try:
                episode_ids.append(int(value))
            except (TypeError, ValueError):
                pass
    for segment_id, rows in review.get("assignments", {}).items():
        if not isinstance(rows, dict):
            continue
        if group_id in rows or (parent and parent in rows):
            ids.append(str(segment_id))
    ids = list(dict.fromkeys(value for value in ids if value in segment_by_id))
    episode_ids = sorted(set(episode_ids) | set(_episodes(ids, segment_by_id)))
    if not ids and not episode_ids:
        return None
    return {
        "status": "human_override",
        "mapping_status": "confirmed" if ids else "episode_only",
        "mapping_source": "human",
        "script_segment_ids": ids,
        "episode_ids": episode_ids,
        "confidence": 1.0,
        "reason": "人工归集范围优先于自动映射" if ids else "人工仅确认集数，未强行绑定具体剧本行",
        "editorial_state": _editorial_state(review, group),
    }


def _candidate_payload(candidate: dict[str, Any], segment_by_id: dict[str, dict[str, Any]], index: int) -> dict[str, Any]:
    ids = _candidate_ids(candidate)
    text = "\n".join(
        str(segment_by_id[item].get("raw_text", "") or segment_by_id[item].get("text", ""))
        for item in ids if item in segment_by_id
    )
    return {
        "candidate_id": str(candidate.get("candidate_id", "") or f"candidate_{index}"),
        "script_segment_ids": ids,
        "episode_ids": _episodes(ids, segment_by_id),
        "script_text": text,
        "confidence_class": str(candidate.get("confidence", "")),
        "total_score": float(candidate.get("total_score", 0) or 0),
        "dialogue_score": float(candidate.get("dialogue_score", 0) or 0),
        "sequence_score": float(candidate.get("sequence_score", 0) or 0),
        "margin": float(candidate.get("margin", 0) or 0),
    }


def _vision_rows(row: dict[str, Any], segment_by_id: dict[str, dict[str, Any]]) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    result = []
    for segment_id in [str(value) for value in row.get("context_segment_ids", []) if str(value) in segment_by_id][:12]:
        segment = segment_by_id[segment_id]
        if str(segment.get("type", "")) == "scene_heading":
            continue
        candidate_id = f"vision:{segment_id}"
        candidate = {"candidate_id": candidate_id, "script_segment_ids": [segment_id]}
        public = {
            "candidate_id": candidate_id,
            "script_segment_ids": [segment_id],
            "episode_ids": _episodes([segment_id], segment_by_id),
            "segment_type": str(segment.get("type", "")),
            "script_text": str(segment.get("raw_text", "") or segment.get("text", "")),
        }
        result.append((candidate, public))
    return result


def _preferred_visual_member(group: dict[str, Any]) -> dict[str, Any] | None:
    priority = {"B": 0, "C": 1, "A": 2}
    members = [item for item in group.get("members", []) if isinstance(item, dict)]
    members.sort(key=lambda item: (
        priority.get(str(item.get("camera", "")).upper(), 99),
        -float(item.get("duration", 0) or 0),
        str(item.get("media_path", "")),
    ))
    return next((item for item in members if Path(str(item.get("media_path", ""))).is_file()), None)


def _try_visual_rescue(
    vision: VisionProvider,
    group: dict[str, Any],
    row: dict[str, Any],
    segment_by_id: dict[str, dict[str, Any]],
    previous: tuple[int, int] | None,
    following: tuple[int, int] | None,
    editorial_state: str,
) -> dict[str, Any] | None:
    if not vision.config.enabled or (previous is None and following is None):
        return None
    rows = _vision_rows(row, segment_by_id)
    member = _preferred_visual_member(group)
    if not rows or member is None:
        return None
    start = float(member.get("source_start", 0) or 0)
    raw_end = member.get("source_end")
    end = float(raw_end) if raw_end is not None else start + float(member.get("duration", 0) or 0)
    frames = vision.extract_frames(str(member.get("media_path", "")), start, end)
    if not frames:
        return None
    try:
        result = vision.rescue({
            "group_id": str(group.get("group_id", "")),
            "camera": str(member.get("camera", "")),
            "take_time": {"start": group.get("start"), "end": group.get("end")},
            "candidates": [public for _candidate, public in rows],
            "previous_confirmed_script_position": previous,
            "following_confirmed_script_position": following,
            "rule": "仅从给定 candidates 选择；禁止搜索或发明其它剧本位置",
        }, frames)
    finally:
        shutil.rmtree(frames[0].parent, ignore_errors=True)
    if not result or not result.get("candidate_id") or float(result.get("confidence", 0) or 0) < vision.config.min_confidence:
        return None
    selected = next(((candidate, public) for candidate, public in rows if public["candidate_id"] == result["candidate_id"]), None)
    if selected is None or not _sequence_consistent(selected[0], segment_by_id, previous, following):
        return None
    candidate, public = selected
    return {
        "status": "ai_confirmed",
        "mapping_status": "confirmed",
        "mapping_source": "vision_rescue",
        "candidate_id": public["candidate_id"],
        "script_segment_ids": _candidate_ids(candidate),
        "episode_ids": public["episode_ids"],
        "confidence": float(result.get("confidence", 0) or 0),
        "reason": str(result.get("reason", "") or "视觉二审通过顺序复核"),
        "evidence": {
            "visual_summary": str(result.get("visual_summary", "") or ""),
            "camera": str(member.get("camera", "")),
            "sequence_consistent": True,
        },
        "editorial_state": editorial_state,
    }


def resolve_project(
    config: ProjectConfig,
    provider: ModelProvider | None = None,
    vision_provider: VisionProvider | None = None,
) -> dict[str, Any]:
    index = _read_json(config.output_dir / "material_index.json", {})
    script = _read_json(config.output_dir / "script.json", {})
    matches = _read_json(config.output_dir / "matches.json", {})
    if not isinstance(index, dict) or not isinstance(script, dict) or not isinstance(matches, dict):
        raise ValueError("项目分析结果不完整，不能执行自动决策")
    groups = [item for item in index.get("groups", []) if isinstance(item, dict) and item.get("group_id")]
    segments = [item for item in script.get("segments", []) if isinstance(item, dict) and item.get("segment_id")]
    segment_by_id = {str(item["segment_id"]): item for item in segments}
    review = ReviewStore(config.output_dir / "review.json").load()
    provider = provider or ModelProvider()
    vision_provider = vision_provider or VisionProvider()
    group_rows = matches.get("groups", {}) if isinstance(matches.get("groups", {}), dict) else {}
    decisions: dict[str, Any] = {}
    ordered_groups = sorted(groups, key=lambda item: (float(item.get("start", 0) or 0), str(item.get("group_id", ""))))

    anchors: dict[int, tuple[int, int]] = {}
    for group_index, group in enumerate(ordered_groups):
        group_id = str(group["group_id"])
        manual = _manual_mapping(group, review, segment_by_id)
        if manual is not None:
            decisions[group_id] = manual
            ids = manual.get("script_segment_ids", [])
            if ids and ids[0] in segment_by_id:
                anchors[group_index] = _segment_position(segment_by_id[ids[0]])
            continue
        row = group_rows.get(group_id, {}) if isinstance(group_rows.get(group_id, {}), dict) else {}
        candidates = [item for item in row.get("candidates", []) if isinstance(item, dict)]
        usable = [item for item in candidates if item.get("confidence") != "context_only" and _candidate_ids(item)]
        top = usable[0] if usable else None
        if top:
            score = float(top.get("total_score", 0) or 0)
            dialogue = float(top.get("dialogue_score", 0) or 0)
            margin = float(top.get("margin", 0) or 0)
            if str(top.get("confidence", "")) == "exact_dialogue" and score >= config.high_confidence and dialogue >= 0.80 and margin >= config.minimum_margin:
                ids = _candidate_ids(top)
                decisions[group_id] = {
                    "status": "auto_confirmed",
                    "mapping_status": "confirmed",
                    "mapping_source": "deterministic",
                    "candidate_id": str(top.get("candidate_id", "") or ""),
                    "script_segment_ids": ids,
                    "episode_ids": _episodes(ids, segment_by_id),
                    "confidence": min(0.99, max(score, dialogue)),
                    "reason": "高置信度对白匹配 + 候选间隔通过",
                    "evidence": {"total_score": score, "dialogue_score": dialogue, "margin": margin},
                    "editorial_state": _editorial_state(review, group),
                }
                anchors[group_index] = _segment_position(segment_by_id[ids[0]])

    anchor_indexes = sorted(anchors)
    for group_index, group in enumerate(ordered_groups):
        group_id = str(group["group_id"])
        if group_id in decisions:
            continue
        row = group_rows.get(group_id, {}) if isinstance(group_rows.get(group_id, {}), dict) else {}
        candidates = [item for item in row.get("candidates", []) if isinstance(item, dict)]
        usable = [item for item in candidates if item.get("confidence") != "context_only" and _candidate_ids(item)]
        previous_index = next((value for value in reversed(anchor_indexes) if value < group_index), None)
        following_index = next((value for value in anchor_indexes if value > group_index), None)
        previous = anchors.get(previous_index) if previous_index is not None else None
        following = anchors.get(following_index) if following_index is not None else None
        editorial = _editorial_state(review, group)

        if not usable:
            vision = _try_visual_rescue(vision_provider, group, row, segment_by_id, previous, following, editorial)
            if vision is not None:
                decisions[group_id] = vision
                ids = vision.get("script_segment_ids", [])
                if ids and ids[0] in segment_by_id:
                    anchors[group_index] = _segment_position(segment_by_id[ids[0]])
                    anchor_indexes = sorted(set(anchor_indexes + [group_index]))
                continue
            decisions[group_id] = {
                "status": "unresolved",
                "mapping_status": "unresolved",
                "mapping_source": "deterministic",
                "script_segment_ids": [],
                "episode_ids": [int(value) for value in row.get("context_episodes", []) if str(value).isdigit()],
                "confidence": 0.0,
                "reason": "没有可靠对白候选，视觉救援也未形成可验证结论",
                "editorial_state": editorial,
            }
            continue

        top = usable[0]
        public_candidates = [_candidate_payload(item, segment_by_id, idx) for idx, item in enumerate(usable[:5])]
        model_result = provider.rescue({
            "group_id": group_id,
            "take_time": {"start": group.get("start"), "end": group.get("end")},
            "transcript": str(top.get("transcript_text", "") or ""),
            "candidates": public_candidates,
            "previous_confirmed_script_position": previous,
            "following_confirmed_script_position": following,
            "rule": "只能从 candidates 选择；证据不足返回空 candidate_id",
        }) if provider.config.enabled else None
        chosen = None
        chosen_public = None
        if model_result and model_result.get("candidate_id"):
            for candidate, public in zip(usable[:5], public_candidates):
                if public["candidate_id"] == model_result["candidate_id"]:
                    chosen, chosen_public = candidate, public
                    break
        if chosen is not None and chosen_public is not None:
            model_confidence = float(model_result.get("confidence", 0) or 0)
            local_support = chosen_public["total_score"] >= config.possible_confidence * 0.78 or chosen_public["dialogue_score"] >= 0.55
            if model_confidence >= provider.config.min_confidence and local_support and _sequence_consistent(chosen, segment_by_id, previous, following):
                ids = _candidate_ids(chosen)
                decisions[group_id] = {
                    "status": "ai_confirmed",
                    "mapping_status": "confirmed",
                    "mapping_source": "model_rescue",
                    "candidate_id": chosen_public["candidate_id"],
                    "script_segment_ids": ids,
                    "episode_ids": chosen_public["episode_ids"],
                    "confidence": model_confidence,
                    "reason": str(model_result.get("reason", "") or "文本模型二审通过本地复核"),
                    "evidence": {
                        "model_confidence": model_confidence,
                        "local_total_score": chosen_public["total_score"],
                        "local_dialogue_score": chosen_public["dialogue_score"],
                        "sequence_consistent": True,
                    },
                    "editorial_state": editorial,
                }
                anchors[group_index] = _segment_position(segment_by_id[ids[0]])
                anchor_indexes = sorted(set(anchor_indexes + [group_index]))
                continue

        ids = _candidate_ids(top)
        decisions[group_id] = {
            "status": "needs_review",
            "mapping_status": "ambiguous",
            "mapping_source": "model_rescue" if provider.config.enabled else "deterministic",
            "candidate_id": str(top.get("candidate_id", "") or ""),
            "script_segment_ids": ids,
            "episode_ids": _episodes(ids, segment_by_id),
            "confidence": float(top.get("total_score", 0) or 0),
            "reason": "候选存在歧义，未达到自动映射门槛",
            "evidence": {
                "total_score": float(top.get("total_score", 0) or 0),
                "dialogue_score": float(top.get("dialogue_score", 0) or 0),
                "margin": float(top.get("margin", 0) or 0),
            },
            "editorial_state": editorial,
        }

    model_public = provider.config.public()
    model_public["vision_enabled"] = vision_provider.config.enabled
    model_public["vision_model"] = vision_provider.config.model
    return AutomationStore(config.output_dir).save(_analysis_revision(config.output_dir), decisions, model_public)
