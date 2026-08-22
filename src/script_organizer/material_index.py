from __future__ import annotations

import hashlib
import json
import os
import tempfile
from collections import defaultdict
from dataclasses import replace
from pathlib import Path
from typing import Any

from .alignment import align_blocks
from .config import ProjectConfig
from .fcpxml_reader import build_multicam_groups, read_fcpxml
from .media_reader import read_media_directory
from .matcher import (
    build_line_index,
    build_script_window_index,
    context_only_candidate,
    match_group,
    normalize_text,
    rescue_scene_prefix_candidates,
)
from .models import Candidate, MulticamGroup
from .known_text_alignment import align_known_text
from .review_store import ReviewStore
from .script_parser import ScriptDocument, parse_script
from .transcript import TranscriptStore, transcribe_with_faster_whisper


ANALYSIS_CACHE_VERSION = 3


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _read_json(path: Path, fallback: Any) -> Any:
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return fallback


def _candidate_from_payload(item: object) -> Candidate | None:
    if not isinstance(item, dict):
        return None
    group_id = str(item.get("group_id", "") or "")
    if not group_id:
        return None
    return Candidate(
        group_id=group_id,
        script_segment_id=str(item.get("script_segment_id")) if item.get("script_segment_id") else None,
        total_score=float(item.get("total_score", 0) or 0),
        dialogue_score=float(item.get("dialogue_score", 0) or 0),
        sequence_score=float(item.get("sequence_score", 0) or 0),
        context_score=float(item.get("context_score", 0) or 0),
        margin=float(item.get("margin", 0) or 0),
        method=str(item.get("method", "") or ""),
        confidence=str(item.get("confidence", "context_only") or "context_only"),
        evidence=tuple(str(value) for value in item.get("evidence", []) if value),
        script_segment_ids=tuple(str(value) for value in item.get("script_segment_ids", []) if value),
        transcript_clip_id=str(item.get("transcript_clip_id")) if item.get("transcript_clip_id") else None,
        transcript_text=str(item.get("transcript_text", "") or ""),
        relative_start=float(item["relative_start"]) if item.get("relative_start") is not None else None,
        relative_end=float(item["relative_end"]) if item.get("relative_end") is not None else None,
        alignment=dict(item.get("alignment", {})) if isinstance(item.get("alignment", {}), dict) else {},
        context_episodes=tuple(int(value) for value in item.get("context_episodes", []) if str(value).isdigit()),
    )


def _script_analysis_key(script_segments: list, config: ProjectConfig) -> str:
    payload = {
        "version": ANALYSIS_CACHE_VERSION,
        "segments": [
            [segment.segment_id, segment.episode, segment.scene_id, segment.type, segment.text, segment.raw_text]
            for segment in script_segments
        ],
        "matching": {
            "high": config.high_confidence,
            "possible": config.possible_confidence,
            "margin": config.minimum_margin,
            "max_candidates": config.max_candidates,
            "max_windows": config.max_transcript_windows,
            "max_window_candidates": config.max_window_candidates,
            "camera_priority": config.asr_camera_priority,
        },
    }
    return hashlib.sha1(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def _group_analysis_key(
    group: MulticamGroup,
    transcripts: dict,
    script_key: str,
    override: object,
) -> str:
    transcript_rows = []
    for member in group.members:
        transcript = transcripts.get(member.clip_id)
        if transcript:
            transcript_rows.append(
                [
                    member.clip_id,
                    transcript.fingerprint,
                    transcript.text,
                    [[segment.start, segment.end, segment.text] for segment in transcript.segments],
                ]
            )
        else:
            transcript_rows.append([member.clip_id, None])
    payload = {
        "script": script_key,
        "group": [
            group.group_id,
            group.parent_group_id,
            group.take_index,
            [
                [
                    member.clip_id,
                    float(member.timeline_start),
                    float(member.timeline_end),
                    float(member.source_start),
                    float(member.source_end) if member.source_end is not None else None,
                ]
                for member in group.members
            ],
        ],
        "transcripts": transcript_rows,
        "override": override if isinstance(override, dict) else {},
    }
    return hashlib.sha1(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def _group_structure_payload(group: MulticamGroup) -> dict[str, Any]:
    return {
        "group_id": group.group_id,
        "start": float(group.start),
        "end": float(group.end),
        "duration": float(group.duration),
        "members": [member.to_dict() for member in group.members],
        "cameras": list(group.cameras),
        "kind": group.kind,
        "parent_group_id": group.parent_group_id,
        "take_index": group.take_index,
        "split_reason": group.split_reason,
    }


def _stored_group_matches(group: MulticamGroup, item: object) -> bool:
    if not isinstance(item, dict):
        return False
    expected = _group_structure_payload(group)
    return all(item.get(key) == value for key, value in expected.items())


def _candidates_from_payload(items: object, group_id: str) -> list[Candidate] | None:
    if not isinstance(items, list):
        return None
    result = []
    for item in items:
        candidate = _candidate_from_payload(item)
        if candidate is None or candidate.group_id != group_id:
            return None
        result.append(candidate)
    return result


def _without_scene_headings(candidate: Candidate, segment_by_id: dict[str, object]) -> Candidate:
    """Keep scene headings as metadata, never as material coverage."""
    ids = candidate.script_segment_ids or ((candidate.script_segment_id,) if candidate.script_segment_id else ())
    filtered_ids = tuple(
        segment_id
        for segment_id in ids
        if getattr(segment_by_id.get(segment_id), "type", "") != "scene_heading"
    )
    script_segment_id = candidate.script_segment_id
    if script_segment_id and getattr(segment_by_id.get(script_segment_id), "type", "") == "scene_heading":
        script_segment_id = filtered_ids[-1] if filtered_ids else None
    return replace(
        candidate,
        script_segment_id=script_segment_id,
        script_segment_ids=filtered_ids,
    )


def _without_scene_headings_map(
    candidates_by_group: dict[str, list[Candidate]],
    script_segments: list,
) -> dict[str, list[Candidate]]:
    segment_by_id = {segment.segment_id: segment for segment in script_segments}
    return {
        group_id: [_without_scene_headings(candidate, segment_by_id) for candidate in candidates]
        for group_id, candidates in candidates_by_group.items()
    }


def _rescue_adjacent_scene_prefixes(
    groups: list[MulticamGroup],
    matches: dict[str, list[Candidate]],
    local_matches: dict[str, list[Candidate]],
    transcripts: dict,
    script_segments: list,
    config: ProjectConfig,
    max_distance: int = 2,
) -> int:
    """Use a same-scene anchor to rescue a Take immediately before it.

    This prevents a short repeated ASR fragment in an opening Take from
    winning an unrelated episode, while keeping action/short-line coverage
    honest until an editor confirms it.
    """
    segment_by_id = {segment.segment_id: segment for segment in script_segments}
    anchors: list[tuple[int, tuple[int, str], str]] = []
    for index, group in enumerate(groups):
        candidate = next(
            (
                item
                for item in local_matches.get(group.group_id, [])
                if item.confidence in {"exact_dialogue", "manual"}
                and item.script_segment_id in segment_by_id
            ),
            None,
        )
        if candidate:
            segment = segment_by_id[candidate.script_segment_id]
            anchors.append((index, (segment.episode, segment.scene_id), candidate.script_segment_id))

    rescued = 0
    for index, group in enumerate(groups):
        following = next(
            (item for item in anchors if index < item[0] <= index + max_distance),
            None,
        )
        if not following:
            continue
        scene_key = following[1]
        existing_same_scene = [
            candidate
            for candidate in local_matches.get(group.group_id, [])
            if any(
                segment_by_id.get(segment_id)
                and (segment_by_id[segment_id].episode, segment_by_id[segment_id].scene_id) == scene_key
                for segment_id in (candidate.script_segment_ids or ((candidate.script_segment_id,) if candidate.script_segment_id else ()))
            )
        ]
        if existing_same_scene:
            continue
        candidates = rescue_scene_prefix_candidates(
            group,
            transcripts,
            script_segments,
            config,
            scene_key,
            following[2],
        )
        if not candidates:
            continue
        # A scene-constrained rescue outranks an unrelated repeated phrase.
        local_matches[group.group_id] = candidates + existing_same_scene
        matches[group.group_id] = list(local_matches[group.group_id])
        rescued += 1
    return rescued


def _prewarm_candidates(items: object, group_id: str, keep_manual: bool) -> list[Candidate] | None:
    """Reuse old final dialogue evidence once, but always rebuild context."""
    candidates = _candidates_from_payload(items, group_id)
    if candidates is None:
        return None
    return [
        candidate
        for candidate in candidates
        if candidate.confidence != "context_only"
        and (keep_manual or candidate.confidence != "manual")
    ]


def _load_overrides(config: ProjectConfig) -> dict[str, Any]:
    if not config.compat_overrides or not config.compat_overrides.exists():
        return {}
    try:
        with config.compat_overrides.open(encoding="utf-8") as handle:
            raw = json.load(handle)
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


def _candidate_from_override(group: MulticamGroup, item: dict[str, Any]) -> Candidate | None:
    if not item:
        return None
    segment_ids = item.get("script_segment_ids") or item.get("script_segments") or []
    if not isinstance(segment_ids, list):
        segment_ids = []
    context_episodes = item.get("context_episodes") or item.get("episodes") or []
    if not isinstance(context_episodes, list):
        context_episodes = []
    try:
        context_episodes = tuple(sorted({int(value) for value in context_episodes}))
    except (TypeError, ValueError):
        context_episodes = ()
    evidence = item.get("evidence") or ["项目兼容覆盖层提供的人工/历史证据"]
    if not isinstance(evidence, list):
        evidence = [str(evidence)]
    if not segment_ids and not context_episodes and not item.get("evidence"):
        return None
    if not segment_ids:
        return context_only_candidate(group, None, [str(value) for value in evidence], context_episodes)
    segment_id = str(segment_ids[0])
    return Candidate(
        group_id=group.group_id,
        script_segment_id=segment_id,
        total_score=float(item.get("total_score", 1.0)),
        dialogue_score=float(item.get("dialogue_score", 1.0)),
        sequence_score=float(item.get("sequence_score", 1.0)),
        context_score=float(item.get("context_score", 1.0)),
        margin=float(item.get("margin", 1.0)),
        method="legacy_override",
        confidence="manual",
        evidence=tuple(str(value) for value in evidence),
        script_segment_ids=tuple(str(value) for value in segment_ids),
        transcript_clip_id=item.get("transcript_clip_id"),
        transcript_text=str(item.get("transcript_text", "")),
        context_episodes=context_episodes,
    )


def _context_for_groups(groups: list[MulticamGroup], matches: dict[str, list[Candidate]]) -> dict[str, list[str]]:
    exact_by_order = []
    for group in groups:
        candidates = matches.get(group.group_id, [])
        exact_by_order.append((group, candidates[0].script_segment_id if candidates and candidates[0].confidence in {"exact_dialogue", "manual"} else None))
    context: dict[str, list[str]] = defaultdict(list)
    for index, (group, segment_id) in enumerate(exact_by_order):
        if segment_id or index == 0 or index == len(exact_by_order) - 1:
            continue
        previous = next((item[1] for item in reversed(exact_by_order[:index]) if item[1]), None)
        following = next((item[1] for item in exact_by_order[index + 1 :] if item[1]), None)
        if previous and previous == following:
            context[group.group_id] = [previous]
    return dict(context)


def _add_scene_context_candidates(
    groups: list[MulticamGroup],
    matches: dict[str, list[Candidate]],
    script_segments: list,
) -> dict[str, list[Candidate]]:
    """Place dialogue-free groups near reliable anchors without inventing a line."""
    segment_by_id = {segment.segment_id: segment for segment in script_segments}
    scene_segments: defaultdict[tuple[int, str], list[str]] = defaultdict(list)
    for segment in script_segments:
        scene_segments[(segment.episode, segment.scene_id)].append(segment.segment_id)
    anchors: list[tuple[int, Candidate]] = []
    for index, group in enumerate(groups):
        top = next(
            (
                candidate
                for candidate in matches.get(group.group_id, [])
                if candidate.script_segment_id and candidate.confidence in {"exact_dialogue", "manual"}
            ),
            None,
        )
        if top:
            anchors.append((index, top))
    for index, group in enumerate(groups):
        if matches.get(group.group_id):
            continue
        previous = next((item for item in reversed(anchors) if item[0] < index), None)
        following = next((item for item in anchors if item[0] > index), None)
        candidate_anchor = None
        if previous and following:
            previous_segment = segment_by_id.get(previous[1].script_segment_id)
            following_segment = segment_by_id.get(following[1].script_segment_id)
            if (
                previous_segment
                and following_segment
                and previous_segment.episode == following_segment.episode
                and previous_segment.scene_id == following_segment.scene_id
                and index - previous[0] <= 5
                and following[0] - index <= 5
            ):
                candidate_anchor = previous_segment
        elif previous and index - previous[0] <= 2:
            candidate_anchor = segment_by_id.get(previous[1].script_segment_id)
        elif following and following[0] - index <= 2:
            candidate_anchor = segment_by_id.get(following[1].script_segment_id)
        if not candidate_anchor:
            continue
        candidate = context_only_candidate(
            group,
            None,
            [
                f"前后可靠对白锚点位于第{candidate_anchor.episode}集 {candidate_anchor.scene_id}",
                "仅归为此场附近素材，不绑定具体台词或动作",
            ],
            (candidate_anchor.episode,),
        )
        matches[group.group_id] = [candidate]
    return matches


def _add_episode_context_candidates(
    groups: list[MulticamGroup],
    matches: dict[str, list[Candidate]],
    script_segments: list,
    max_neighbor_groups: int = 12,
) -> dict[str, list[Candidate]]:
    """Give dialogue-free groups a nearby episode context without fake lines."""
    segment_by_id = {segment.segment_id: segment for segment in script_segments}
    anchors: list[tuple[int, int]] = []
    for index, group in enumerate(groups):
        candidate = next(
            (
                item
                for item in matches.get(group.group_id, [])
                if item.script_segment_id and item.confidence in {"exact_dialogue", "manual"}
            ),
            None,
        )
        if candidate:
            segment = segment_by_id.get(candidate.script_segment_id)
            if segment:
                anchors.append((index, segment.episode))
    for index, group in enumerate(groups):
        if matches.get(group.group_id):
            continue
        previous = next((item for item in reversed(anchors) if item[0] < index), None)
        following = next((item for item in anchors if item[0] > index), None)
        episodes: list[int] = []
        if previous and following:
            previous_distance = index - previous[0]
            following_distance = following[0] - index
            if previous[1] == following[1]:
                if previous_distance <= max_neighbor_groups and following_distance <= max_neighbor_groups:
                    episodes = [previous[1]]
            elif previous_distance <= 3 and following_distance <= 3:
                if abs(previous[1] - following[1]) <= 2:
                    episodes = sorted({previous[1], following[1]})
                else:
                    # A short slate/preparation clip at a distant episode
                    # boundary belongs with the following setup when the two
                    # anchors are equally close; do not claim a 17–32 range.
                    episodes = [
                        previous[1]
                        if previous_distance < following_distance
                        else following[1]
                    ]
            elif min(previous_distance, following_distance) <= max_neighbor_groups:
                episodes = [previous[1] if previous_distance <= following_distance else following[1]]
        elif previous and index - previous[0] <= max_neighbor_groups:
            episodes = [previous[1]]
        elif following and following[0] - index <= max_neighbor_groups:
            episodes = [following[1]]
        if not episodes:
            continue
        matches[group.group_id] = [
            context_only_candidate(
                group,
                None,
                [
                    "依据同一拍摄顺序中相邻的可靠对白锚点",
                    f"仅作为第{''.join(str(value) + '、' for value in episodes).rstrip('、')}集附近素材候选",
                    "不绑定具体台词；可能是空镜、口令或准备片",
                ],
                tuple(episodes),
            )
        ]
    return matches


def _script_gap_metadata(
    script_segments: list,
    matches: dict[str, list[Candidate]],
    review: dict[str, Any],
    minimum_segments: int = 4,
) -> list[dict[str, Any]]:
    """Describe long script blocks with no material-level correspondence.

    A context-only candidate is deliberately not considered coverage here:
    it can identify a nearby episode, but it must not make a script line look
    matched.  The result is diagnostic metadata for the editor and for the
    next targeted review/ASR pass; it never creates a candidate or a review
    decision.
    """
    covered: set[str] = set()
    for candidates in matches.values():
        for candidate in candidates:
            if candidate.confidence == "context_only":
                continue
            covered.update(
                candidate.script_segment_ids
                or ((candidate.script_segment_id,) if candidate.script_segment_id else ())
            )
    for placement in review.get("placements", {}).values():
        if isinstance(placement, dict):
            covered.update(str(value) for value in placement.get("script_segment_ids", []) if value)
    for assignments in review.get("assignments", {}).values():
        if isinstance(assignments, dict) and assignments:
            covered.add(str(next(iter(review.get("assignments", {})), "")))

    by_scene: defaultdict[tuple[int, str], list] = defaultdict(list)
    for segment in script_segments:
        if segment.type != "scene_heading":
            by_scene[(segment.episode, segment.scene_id)].append(segment)

    gaps: list[dict[str, Any]] = []
    for (episode, scene_id), segments in by_scene.items():
        run: list = []
        for segment in segments + [None]:
            if segment is not None and segment.segment_id not in covered:
                run.append(segment)
                continue
            if len(run) >= minimum_segments:
                dialogue = [item for item in run if item.type == "dialogue"]
                gaps.append(
                    {
                        "gap_id": f"E{episode:03d}-{scene_id}-L{run[0].order:04d}-L{run[-1].order:04d}",
                        "episode": episode,
                        "scene_id": scene_id,
                        "start_order": run[0].order,
                        "end_order": run[-1].order,
                        "segment_ids": [item.segment_id for item in run],
                        "segment_count": len(run),
                        "dialogue_count": len(dialogue),
                        "action_count": sum(item.type == "action" for item in run),
                        "reason": "连续剧本段没有对白、可能对白或人工归集素材候选",
                    }
                )
            run = []
    return sorted(gaps, key=lambda item: (item["episode"], item["start_order"]))


def _gap_rescue_group_ids(
    groups: list[MulticamGroup],
    transcripts: dict,
    script_segments: list,
    previous_matches: dict,
) -> set[str]:
    """Find only cached groups whose ASR contains text from prior script gaps.

    This is intentionally a targeted prefilter for the weak-sequence rescue.
    It does not create a candidate by itself: the matcher still requires
    multiple same-scene lines to progress in both audio time and script order.
    """
    gaps = previous_matches.get("script_gaps", []) if isinstance(previous_matches, dict) else []
    if not isinstance(gaps, list) or not gaps:
        return set()
    segment_by_id = {segment.segment_id: segment for segment in script_segments}
    clip_to_group = {
        member.clip_id: group.group_id
        for group in groups
        for member in group.members
    }
    transcript_grams: dict[str, set[str]] = defaultdict(set)
    for clip_id, transcript in transcripts.items():
        text = normalize_text(getattr(transcript, "text", ""))
        if len(text) < 6:
            continue
        transcript_grams[clip_id] = {text[index : index + 6] for index in range(len(text) - 5)}

    rescue_ids: set[str] = set()
    for gap in gaps:
        if not isinstance(gap, dict):
            continue
        for segment_id in gap.get("segment_ids", []):
            segment = segment_by_id.get(str(segment_id))
            if not segment or segment.type != "dialogue":
                continue
            text = normalize_text(segment.text)
            if len(text) < 6:
                continue
            grams = {text[index : index + 6] for index in range(len(text) - 5)}
            for clip_id, available in transcript_grams.items():
                if grams & available and clip_id in clip_to_group:
                    rescue_ids.add(clip_to_group[clip_id])
    return rescue_ids


def analyze(config: ProjectConfig, affected_group_ids: set[str] | None = None) -> dict[str, Any]:
    config.ensure_output()
    previous_index = _read_json(config.output_dir / "material_index.json", {})
    previous_script = _read_json(config.output_dir / "script.json", {})
    previous_matches = _read_json(config.output_dir / "matches.json", {})
    if config.is_fcpxml:
        if config.fcpxml is None:
            raise ValueError("FCPXML 项目缺少 input.fcpxml")
        clips = read_fcpxml(config.fcpxml)
    elif config.is_media_directory:
        if config.media_root is None:
            raise ValueError("媒体目录项目缺少 media.root")
        clips = read_media_directory(config.media_root, config.camera_patterns, config.media_timeline_mode)
    else:
        raise ValueError(f"不支持的 input.kind: {config.input_kind}")
    groups = build_multicam_groups(clips, config.minimum_overlap_seconds, config.split_bridge_ratio)
    script = parse_script(config.script)
    store = TranscriptStore(config.transcript_dir)
    transcripts = {}
    clip_by_id = {clip.clip_id: clip for clip in clips}
    cached_transcripts = {}
    for clip in clips:
        transcript = store.load(clip)
        if transcript:
            cached_transcripts[clip.clip_id] = transcript
            if transcript.text.strip() or transcript.segments:
                transcripts[clip.clip_id] = transcript
    missing_transcript_groups = [
        group.group_id
        for group in groups
        if not any(member.clip_id in transcripts for member in group.members)
    ]
    preferred_missing_groups = []
    if config.asr_ensure_preferred_camera:
        priority = {camera: index for index, camera in enumerate(config.asr_camera_priority)}
        for group in groups:
            members = sorted(group.members, key=lambda member: (priority.get(member.camera, 999), member.name))
            preferred = next((member for member in members if member.exists), None)
            if preferred and preferred.clip_id not in transcripts:
                preferred_missing_groups.append(group.group_id)
    transcribe_groups = set(missing_transcript_groups) | set(preferred_missing_groups)
    asr_error = ""
    if config.asr_backend != "cache" and transcribe_groups:
        try:
            from faster_whisper import WhisperModel  # type: ignore
            model = WhisperModel(config.asr_model, device=config.asr_device, compute_type="auto")
            remaining_groups = []
            priority = {camera: index for index, camera in enumerate(config.asr_camera_priority)}
            for group in groups:
                if group.group_id not in transcribe_groups:
                    continue
                members = sorted(
                    group.members,
                    key=lambda member: (priority.get(member.camera, 999), -float(member.duration), member.name),
                )
                success = False
                for member in members:
                    clip = clip_by_id[member.clip_id]
                    if not clip.exists:
                        continue
                    if clip.clip_id in transcripts:
                        success = True
                        break
                    try:
                        transcript = transcribe_with_faster_whisper(clip, store, model, config.asr_language)
                    except Exception:
                        continue
                    if transcript.text.strip() or transcript.segments:
                        transcripts[clip.clip_id] = transcript
                        cached_transcripts[clip.clip_id] = transcript
                        success = True
                        break
                if not success:
                    remaining_groups.append(group.group_id)
            missing_transcript_groups = remaining_groups
        except ImportError:
            asr_error = "faster-whisper 未安装；保留为缺失 transcript"

    script_segments = list(script.segments)
    script_payload = script.to_dict()
    script_key = _script_analysis_key(script_segments, config)
    script_window_index = build_script_window_index(script_segments)
    script_line_index = build_line_index(script_segments)
    rescue_group_ids = _gap_rescue_group_ids(groups, transcripts, script_segments, previous_matches)
    if affected_group_ids is not None:
        rescue_group_ids &= affected_group_ids
    matches: dict[str, list[Candidate]] = {}
    local_matches: dict[str, list[Candidate]] = {}
    group_analysis_keys: dict[str, str] = {}
    cache_reused = 0
    cache_prewarmed = 0
    cache_recomputed = 0
    cache_targeted_rescued = 0
    scene_prefix_rescued = 0
    overrides = _load_overrides(config)
    group_overrides = overrides.get("groups", {}) if isinstance(overrides.get("groups", {}), dict) else {}
    previous_group_rows = (
        previous_matches.get("groups", {})
        if isinstance(previous_matches, dict) and isinstance(previous_matches.get("groups", {}), dict)
        else {}
    )
    previous_group_items = previous_index.get("groups", []) if isinstance(previous_index, dict) else []
    previous_groups = {
        str(item.get("group_id")): item
        for item in previous_group_items
        if isinstance(item, dict) and item.get("group_id")
    }
    same_previous_sources = (
        isinstance(previous_index, dict)
        and previous_index.get("source", {}).get("kind") == config.input_kind
        and previous_index.get("source", {}).get("fcpxml") == (str(config.fcpxml) if config.fcpxml else "")
        and previous_index.get("source", {}).get("media_root") == (str(config.media_root) if config.media_root else "")
        and previous_index.get("source", {}).get("script") == str(config.script)
        and previous_script == script_payload
    )
    existing_group_ids = {group.group_id for group in groups}
    if affected_group_ids is not None and not affected_group_ids.issubset(existing_group_ids):
        raise ValueError("增量分析包含未知 group_id")
    for group in groups:
        override = group_overrides.get(group.group_id, {})
        analysis_key = _group_analysis_key(group, transcripts, script_key, override)
        group_analysis_keys[group.group_id] = analysis_key
        previous_row = previous_group_rows.get(group.group_id, {})
        auto: list[Candidate] | None = None
        targeted_rescue = group.group_id in rescue_group_ids
        if targeted_rescue:
            cache_targeted_rescued += 1
        if affected_group_ids is not None and group.group_id not in affected_group_ids:
            if not same_previous_sources or not _stored_group_matches(group, previous_groups.get(group.group_id)):
                raise ValueError("输入、剧本或Take结构变化后不能只重算部分Take")
            auto = _candidates_from_payload(previous_row.get("local_candidates"), group.group_id)
            if auto is None:
                raise ValueError("缺少未受影响Take的缓存，不能执行局部分析")
            cache_reused += 1
        if not targeted_rescue and isinstance(previous_row, dict) and previous_row.get("analysis_key") == analysis_key:
            cached = _candidates_from_payload(previous_row.get("local_candidates"), group.group_id)
            if auto is None and cached is not None:
                auto = cached
                cache_reused += 1
        if (
            auto is None
            and not targeted_rescue
            and same_previous_sources
            and _stored_group_matches(group, previous_groups.get(group.group_id))
            and isinstance(previous_row, dict)
            and not previous_row.get("analysis_key")
        ):
            auto = _prewarm_candidates(
                previous_row.get("candidates"),
                group.group_id,
                keep_manual=False,
            )
            if auto is not None:
                if isinstance(override, dict):
                    manual = _candidate_from_override(group, override)
                    if manual:
                        auto.insert(0, manual)
                cache_prewarmed += 1
        if auto is None:
            auto = match_group(
                group,
                transcripts,
                script_segments,
                config,
                script_window_index,
                script_line_index,
                preserve_coherent_weak=targeted_rescue,
            )
            if isinstance(override, dict):
                manual = _candidate_from_override(group, override)
                if manual:
                    auto.insert(0, manual)
            cache_recomputed += 1
        local_matches[group.group_id] = auto[: config.max_candidates]
        matches[group.group_id] = list(local_matches[group.group_id])
    scene_prefix_rescued = _rescue_adjacent_scene_prefixes(
        groups,
        matches,
        local_matches,
        transcripts,
        script_segments,
        config,
    )
    # Cached candidates from earlier analyses may still contain a scene heading
    # in a long range. Normalize both cached and newly computed candidates
    # before alignment and serialization, without forcing unrelated Takes to
    # rerun their ASR matching.
    local_matches = _without_scene_headings_map(local_matches, script_segments)
    matches = _without_scene_headings_map(matches, script_segments)
    matches, alignment_metadata = align_blocks(
        groups,
        matches,
        script_segments,
        config.shooting_block_gap_minutes,
    )
    matches = _without_scene_headings_map(matches, script_segments)
    matches = _add_scene_context_candidates(groups, matches, script_segments)
    matches = _add_episode_context_candidates(groups, matches, script_segments)
    if config.enable_known_text_alignment:
        group_by_id = {group.group_id: group for group in groups}
        segment_by_id = {segment.segment_id: segment for segment in script_segments}
        for group_id, candidates in list(matches.items()):
            group = group_by_id[group_id]
            member = next((item for item in group.members if item.exists), None)
            if not member:
                continue
            updated = []
            for candidate in candidates:
                ids = candidate.script_segment_ids or ((candidate.script_segment_id,) if candidate.script_segment_id else ())
                known_text = "".join(segment_by_id[item].text for item in ids if item in segment_by_id)
                alignment = align_known_text(member.media_path, known_text, config.stable_ts_model) if known_text else {"method": "stable-ts", "status": "not_run"}
                updated.append(replace(candidate, script_segment_ids=tuple(ids), alignment=alignment))
            matches[group_id] = updated
    context = {
        group_id: list(candidate.script_segment_ids)
        for group_id, candidates in matches.items()
        for candidate in candidates[:1]
        if candidate.confidence == "context_only"
    }

    unusable_transcript_groups = [
        group.group_id
        for group in groups
        if not any(member.clip_id in transcripts for member in group.members)
    ]
    missing_media = [clip.clip_id for clip in clips if not clip.exists]
    script_issues = [] if script_segments else ["没有解析出剧本段落"]
    matched_group_ids = {
        group_id
        for group_id, candidates in matches.items()
        if any(candidate.confidence != "context_only" for candidate in candidates)
    }
    context_group_ids = {
        group_id
        for group_id, candidates in matches.items()
        if group_id not in matched_group_ids
        and any(candidate.confidence == "context_only" for candidate in candidates)
    }
    review = ReviewStore(config.output_dir / "review.json").load()
    manual_group_ids = set(review.get("groups", {}))
    manual_group_ids.update(review.get("placements", {}))
    for assignments in review.get("assignments", {}).values():
        manual_group_ids.update(assignments)
    script_gaps = _script_gap_metadata(script_segments, matches, review)
    errors = {
        "missing_media": missing_media,
        "missing_transcripts": missing_transcript_groups,
        "unusable_transcripts": unusable_transcript_groups,
        "script_issues": script_issues,
        "fcpxml_issues": [],
        "asr_backend_error": [asr_error] if asr_error else [],
    }
    group_payloads = []
    for group in groups:
        payload = group.to_dict()
        payload["analysis_key"] = group_analysis_keys[group.group_id]
        group_payloads.append(payload)
    index_payload = {
        "version": 2,
        "project": config.name,
        "source": {
            "kind": config.input_kind,
            "fcpxml": str(config.fcpxml) if config.fcpxml else "",
            "media_root": str(config.media_root) if config.media_root else "",
            "script": str(config.script),
        },
        "clips": [clip.to_dict() for clip in clips],
        "groups": group_payloads,
        "errors": errors,
        "stats": {
            "clips": len(clips),
            "groups": len(groups),
            "multicam_groups": sum(group.kind == "multicam" for group in groups),
            "single_camera_groups": sum(group.kind == "single-camera" for group in groups),
            "missing_media": len(missing_media),
            "missing_transcripts": len(missing_transcript_groups),
            "unusable_transcripts": len(unusable_transcript_groups),
            "cached_transcript_clips": len(transcripts),
            "shooting_blocks": len(alignment_metadata.get("blocks", [])),
            "matched_groups": len(matched_group_ids),
            "context_only_groups": len(context_group_ids),
            "unknown_groups": max(0, len(groups) - len(matched_group_ids | context_group_ids | manual_group_ids)),
            "script_gap_blocks": len(script_gaps),
            "script_gap_segments": sum(item["segment_count"] for item in script_gaps),
            "script_gap_dialogue_segments": sum(item["dialogue_count"] for item in script_gaps),
            "analysis_cache_reused_groups": cache_reused,
            "analysis_cache_prewarmed_groups": cache_prewarmed,
            "analysis_cache_recomputed_groups": cache_recomputed,
            "analysis_cache_targeted_rescued_groups": cache_targeted_rescued,
            "scene_prefix_rescued_groups": scene_prefix_rescued,
        },
    }
    matches_payload = {
        "version": 2,
        "groups": {
            group_id: {
                "candidates": [candidate.to_dict() for candidate in candidates],
                "local_candidates": [candidate.to_dict() for candidate in local_matches[group_id]],
                "analysis_key": group_analysis_keys[group_id],
                "context_segment_ids": context.get(group_id, []),
                "context_episodes": [
                    episode
                    for candidate in candidates[:1]
                    for episode in candidate.context_episodes
                ],
            }
            for group_id, candidates in matches.items()
        },
        "by_segment": {
            segment.segment_id: [
                candidate.to_dict()
                for group_id, candidates in matches.items()
                for candidate in candidates
                if segment.segment_id in (candidate.script_segment_ids or ((candidate.script_segment_id,) if candidate.script_segment_id else ()))
            ]
            for segment in script_segments
        },
        "script_gaps": script_gaps,
        "sequence_alignment": alignment_metadata,
        "analysis_cache": {
            "version": ANALYSIS_CACHE_VERSION,
            "script_key": script_key,
            "reused_groups": cache_reused,
            "prewarmed_groups": cache_prewarmed,
            "recomputed_groups": cache_recomputed,
            "targeted_rescued_groups": cache_targeted_rescued,
            "scene_prefix_rescued_groups": scene_prefix_rescued,
            "affected_group_ids": sorted(affected_group_ids) if affected_group_ids is not None else [],
        },
    }
    _write_json(config.output_dir / "material_index.json", index_payload)
    _write_json(config.output_dir / "script.json", script_payload)
    _write_json(config.output_dir / "matches.json", matches_payload)
    return {"index": index_payload, "script": script_payload, "matches": matches_payload}
