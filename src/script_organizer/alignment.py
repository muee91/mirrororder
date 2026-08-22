from __future__ import annotations

from dataclasses import replace

from .models import Candidate, MulticamGroup, ScriptSegment


def split_shooting_blocks(groups: list[MulticamGroup], gap_minutes: float = 20.0) -> list[list[MulticamGroup]]:
    ordered = sorted(groups, key=lambda group: (group.start, group.group_id))
    blocks: list[list[MulticamGroup]] = []
    gap_seconds = max(0.0, gap_minutes) * 60.0
    for group in ordered:
        if not blocks or group.start - blocks[-1][-1].end > gap_seconds:
            blocks.append([group])
        else:
            blocks[-1].append(group)
    return blocks


def _candidate_position(candidate: Candidate, positions: dict[str, int]) -> int | None:
    ids = candidate.script_segment_ids or ((candidate.script_segment_id,) if candidate.script_segment_id else ())
    values = [positions[segment_id] for segment_id in ids if segment_id in positions]
    return min(values) if values else None


def _transition(last_position: int, position: int | None) -> tuple[float, float]:
    if position is None:
        return -0.12, 0.0
    if last_position < 0:
        return 0.0, 0.65
    delta = position - last_position
    if delta == 0:
        return -0.035, 0.72
    if delta > 0:
        return -min(0.20, max(0, delta - 1) * 0.012), max(0.72, 1.0 - min(0.28, (delta - 1) * 0.02))
    return -0.42 * abs(delta), 0.20


def align_block(
    groups: list[MulticamGroup],
    candidates_by_group: dict[str, list[Candidate]],
    script_segments: list[ScriptSegment],
) -> dict[str, Candidate | None]:
    """Monotonic many-to-one DP: repeats are allowed, gaps are allowed."""
    positions = {segment.segment_id: index for index, segment in enumerate(script_segments)}
    # state: last script position -> (score, selected candidates by group)
    states: dict[int, tuple[float, dict[str, Candidate | None]]] = {-1: (0.0, {})}
    for group in groups:
        next_states: dict[int, tuple[float, dict[str, Candidate | None]]] = {}
        options = list(candidates_by_group.get(group.group_id, [])) + [None]
        for last_position, (score, path) in states.items():
            for candidate in options:
                position = _candidate_position(candidate, positions) if candidate else None
                transition_score, consistency = _transition(last_position, position)
                base = candidate.total_score if candidate else 0.0
                option_score = score + base + transition_score
                state_position = last_position if position is None else position
                selected = dict(path)
                if candidate is None:
                    selected[group.group_id] = None
                else:
                    sequence_score = round(max(candidate.sequence_score, consistency), 4)
                    total_score = min(1.0, round(candidate.total_score * 0.78 + sequence_score * 0.22, 4))
                    confidence = candidate.confidence
                    if confidence == "exact_dialogue" and (candidate.margin < 0.08 or sequence_score < 0.70):
                        confidence = "possible_dialogue"
                    evidence = list(candidate.evidence)
                    evidence.append(
                        "拍摄块内按剧本顺序对齐"
                        if position is not None
                        else "未进入顺序对齐的剧本位置"
                    )
                    selected[group.group_id] = replace(
                        candidate,
                        total_score=total_score,
                        sequence_score=sequence_score,
                        confidence=confidence,
                        evidence=tuple(dict.fromkeys(evidence)),
                    )
                previous = next_states.get(state_position)
                if previous is None or option_score > previous[0]:
                    next_states[state_position] = (option_score, selected)
        # Keep the state space bounded while retaining the best positions.
        states = dict(sorted(next_states.items(), key=lambda item: item[1][0], reverse=True)[:160])
    if not states:
        return {group.group_id: None for group in groups}
    return max(states.values(), key=lambda item: item[0])[1]


def align_blocks(
    groups: list[MulticamGroup],
    candidates_by_group: dict[str, list[Candidate]],
    script_segments: list[ScriptSegment],
    gap_minutes: float = 20.0,
) -> tuple[dict[str, list[Candidate]], dict[str, object]]:
    result = {group_id: list(candidates) for group_id, candidates in candidates_by_group.items()}
    metadata = {"blocks": [], "aligned_groups": 0, "gaps": 0}
    for index, block in enumerate(split_shooting_blocks(groups, gap_minutes), start=1):
        selected = align_block(block, candidates_by_group, script_segments)
        metadata["blocks"].append(
            {"block": index, "start": float(block[0].start), "end": float(block[-1].end), "groups": len(block)}
        )
        for group in block:
            # An explicit compatibility override is a human decision.  The
            # monotonic DP may prefer an automatic candidate from a repeated
            # take (especially when the next group jumps back in script
            # order), so never let sequence alignment silently replace the
            # override. This also preserves cross-episode manual ranges.
            manual = next(
                (
                    candidate
                    for candidate in candidates_by_group.get(group.group_id, [])
                    if candidate.confidence == "manual"
                ),
                None,
            )
            chosen = manual or selected.get(group.group_id)
            if chosen is None:
                metadata["gaps"] += 1
                continue
            current = result.get(group.group_id, [])
            rest = [candidate for candidate in current if candidate.script_segment_id != chosen.script_segment_id]
            result[group.group_id] = [chosen] + rest
            metadata["aligned_groups"] += 1
    return result, metadata
