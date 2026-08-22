from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .automation_store import AutomationStore
from .config import ProjectConfig
from .model_provider import ModelProvider
from .review_store import ReviewStore


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


def _manual_group_ids(review: dict[str, Any], groups: list[dict[str, Any]]) -> set[str]:
    direct = {str(value) for value in review.get("groups", {})}
    direct.update(str(value) for value in review.get("placements", {}))
    for rows in review.get("assignments", {}).values():
        if isinstance(rows, dict):
            direct.update(str(value) for value in rows)
    result = set(direct)
    for group in groups:
        if str(group.get("parent_group_id", "") or "") in direct:
            result.add(str(group.get("group_id", "") or ""))
    return result


def _manual_entry(
    group: dict[str, Any],
    review: dict[str, Any],
    candidates: list[dict[str, Any]],
    segment_by_id: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    group_id = str(group.get("group_id", "") or "")
    parent_id = str(group.get("parent_group_id", "") or "")
    placement = review.get("placements", {}).get(group_id, {}) or review.get("placements", {}).get(parent_id, {})
    ids = [str(value) for value in placement.get("script_segment_ids", []) if value] if isinstance(placement, dict) else []
    if not ids and candidates:
        ids = _candidate_ids(candidates[0])
    group_review = review.get("groups", {}).get(group_id, {}) or review.get("groups", {}).get(parent_id, {})
    state = str(group_review.get("state", "keep") or "keep") if isinstance(group_review, dict) else "keep"
    return {
        "status": "human_override",
        "state": state if state in {"best", "keep", "reject"} else "keep",
        "decision_source": "human",
        "script_segment_ids": ids,
        "episode_ids": _episodes(ids, segment_by_id),
        "confidence": 1.0,
        "reason": "人工审核或人工归集优先于自动判断",
    }


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


def _candidate_payload(
    candidate: dict[str, Any],
    segment_by_id: dict[str, dict[str, Any]],
    index: int,
) -> dict[str, Any]:
    ids = _candidate_ids(candidate)
    text = "\n".join(
        str(segment_by_id[item].get("raw_text", "") or segment_by_id[item].get("text", ""))
        for item in ids
        if item in segment_by_id
    )
    candidate_id = str(candidate.get("candidate_id", "") or f"candidate_{index}")
    return {
        "candidate_id": candidate_id,
        "script_segment_ids": ids,
        "episode_ids": _episodes(ids, segment_by_id),
        "script_text": text,
        "confidence_class": str(candidate.get("confidence", "")),
        "total_score": float(candidate.get("total_score", 0) or 0),
        "dialogue_score": float(candidate.get("dialogue_score", 0) or 0),
        "sequence_score": float(candidate.get("sequence_score", 0) or 0),
        "margin": float(candidate.get("margin", 0) or 0),
    }


def resolve_project(config: ProjectConfig, provider: ModelProvider | None = None) -> dict[str, Any]:
    index = _read_json(config.output_dir / "material_index.json", {})
    script = _read_json(config.output_dir / "script.json", {})
    matches = _read_json(config.output_dir / "matches.json", {})
    if not isinstance(index, dict) or not isinstance(script, dict) or not isinstance(matches, dict):
        raise ValueError("项目分析结果不完整，不能执行自动决策")
    groups = [item for item in index.get("groups", []) if isinstance(item, dict) and item.get("group_id")]
    segments = [item for item in script.get("segments", []) if isinstance(item, dict) and item.get("segment_id")]
    segment_by_id = {str(item["segment_id"]): item for item in segments}
    review = ReviewStore(config.output_dir / "review.json").load()
    manual_ids = _manual_group_ids(review, groups)
    provider = provider or ModelProvider()

    group_rows = matches.get("groups", {}) if isinstance(matches.get("groups", {}), dict) else {}
    decisions: dict[str, Any] = {}
    ordered_groups = sorted(groups, key=lambda item: (float(item.get("start", 0) or 0), str(item.get("group_id", ""))))

    anchors: dict[int, tuple[int, int]] = {}
    for group_index, group in enumerate(ordered_groups):
        group_id = str(group["group_id"])
        row = group_rows.get(group_id, {}) if isinstance(group_rows.get(group_id, {}), dict) else {}
        candidates = [item for item in row.get("candidates", []) if isinstance(item, dict)]
        if group_id in manual_ids:
            entry = _manual_entry(group, review, candidates, segment_by_id)
            decisions[group_id] = entry
            ids = entry.get("script_segment_ids", [])
            if ids and ids[0] in segment_by_id:
                anchors[group_index] = _segment_position(segment_by_id[ids[0]])
            continue
        usable = [item for item in candidates if item.get("confidence") != "context_only" and _candidate_ids(item)]
        top = usable[0] if usable else None
        if top:
            score = float(top.get("total_score", 0) or 0)
            dialogue = float(top.get("dialogue_score", 0) or 0)
            margin = float(top.get("margin", 0) or 0)
            exact = str(top.get("confidence", "")) == "exact_dialogue"
            if exact and score >= config.high_confidence and dialogue >= 0.80 and margin >= config.minimum_margin:
                ids = _candidate_ids(top)
                decisions[group_id] = {
                    "status": "auto_confirmed",
                    "state": "keep",
                    "decision_source": "deterministic",
                    "candidate_id": str(top.get("candidate_id", "") or ""),
                    "script_segment_ids": ids,
                    "episode_ids": _episodes(ids, segment_by_id),
                    "confidence": min(0.99, max(score, dialogue)),
                    "reason": "高置信度对白匹配 + 足够候选间隔，自动确认剧本归属",
                    "evidence": {
                        "total_score": score,
                        "dialogue_score": dialogue,
                        "sequence_score": float(top.get("sequence_score", 0) or 0),
                        "margin": margin,
                    },
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

        if not usable:
            decisions[group_id] = {
                "status": "unresolved",
                "state": "unreviewed",
                "decision_source": "deterministic",
                "script_segment_ids": [],
                "episode_ids": [int(value) for value in row.get("context_episodes", []) if str(value).isdigit()],
                "confidence": 0.0,
                "reason": "没有可复核的对白候选；保留为异常/无对白队列，不伪造剧本归属",
            }
            continue

        top = usable[0]
        top_score = float(top.get("total_score", 0) or 0)
        top_dialogue = float(top.get("dialogue_score", 0) or 0)
        model_candidates = [_candidate_payload(item, segment_by_id, idx) for idx, item in enumerate(usable[:5])]
        model_result = None
        if provider.config.enabled:
            model_result = provider.rescue({
                "group_id": group_id,
                "take_time": {"start": group.get("start"), "end": group.get("end")},
                "transcript": str(top.get("transcript_text", "") or ""),
                "candidates": model_candidates,
                "previous_confirmed_script_position": previous,
                "following_confirmed_script_position": following,
                "rule": "只能从 candidates 选择；证据不足返回空 candidate_id",
            })

        chosen = None
        chosen_public = None
        if model_result and model_result.get("candidate_id"):
            for candidate, public in zip(usable[:5], model_candidates):
                if public["candidate_id"] == model_result["candidate_id"]:
                    chosen, chosen_public = candidate, public
                    break
        if chosen is not None and chosen_public is not None:
            model_confidence = float(model_result.get("confidence", 0) or 0)
            minimum_local_support = (
                chosen_public["total_score"] >= config.possible_confidence * 0.78
                or chosen_public["dialogue_score"] >= 0.55
            )
            sequence_ok = _sequence_consistent(chosen, segment_by_id, previous, following)
            if model_confidence >= provider.config.min_confidence and minimum_local_support and sequence_ok:
                ids = _candidate_ids(chosen)
                decisions[group_id] = {
                    "status": "ai_confirmed",
                    "state": "keep",
                    "decision_source": "model_rescue",
                    "candidate_id": chosen_public["candidate_id"],
                    "script_segment_ids": ids,
                    "episode_ids": chosen_public["episode_ids"],
                    "confidence": model_confidence,
                    "reason": str(model_result.get("reason", "") or "大模型二审后通过确定性复核"),
                    "evidence": {
                        "model_confidence": model_confidence,
                        "local_total_score": chosen_public["total_score"],
                        "local_dialogue_score": chosen_public["dialogue_score"],
                        "sequence_consistent": True,
                    },
                }
                anchors[group_index] = _segment_position(segment_by_id[ids[0]])
                anchor_indexes = sorted(set(anchor_indexes + [group_index]))
                continue

        ids = _candidate_ids(top)
        status = "needs_review" if top_score > 0 or top_dialogue > 0 else "unresolved"
        reason = "候选存在歧义，未达到自动确认门槛"
        if provider.config.enabled and model_result:
            reason = "模型二审结果未通过本地分数/顺序复核，转人工异常队列"
        elif provider.config.enabled:
            reason = "模型二审不可用或无可靠选择，转人工异常队列"
        decisions[group_id] = {
            "status": status,
            "state": "unreviewed",
            "decision_source": "model_rescue" if provider.config.enabled else "deterministic",
            "candidate_id": str(top.get("candidate_id", "") or ""),
            "script_segment_ids": ids,
            "episode_ids": _episodes(ids, segment_by_id),
            "confidence": top_score,
            "reason": reason,
            "evidence": {
                "total_score": top_score,
                "dialogue_score": top_dialogue,
                "margin": float(top.get("margin", 0) or 0),
            },
        }

    return AutomationStore(config.output_dir).save(
        _analysis_revision(config.output_dir),
        decisions,
        provider.config.public(),
    )
