from __future__ import annotations

from dataclasses import replace

from .models import Candidate, MulticamGroup, ScriptSegment


ScriptSpan = tuple[int, int]


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


def _candidate_span(candidate: Candidate, positions: dict[str, int]) -> ScriptSpan | None:
    ids = candidate.script_segment_ids or ((candidate.script_segment_id,) if candidate.script_segment_id else ())
    values = sorted(positions[segment_id] for segment_id in ids if segment_id in positions)
    if not values:
        return None
    return values[0], values[-1]


def _span_overlap(left: ScriptSpan, right: ScriptSpan) -> float:
    start = max(left[0], right[0])
    end = min(left[1], right[1])
    if end < start:
        return 0.0
    overlap = end - start + 1
    shortest = min(left[1] - left[0] + 1, right[1] - right[0] + 1)
    return overlap / max(1, shortest)


def _transition(last_span: ScriptSpan | None, span: ScriptSpan | None) -> tuple[float, float]:
    """Score a transition between script ranges.

    Repeated or strongly overlapping ranges are normal in short-drama takes,
    small forward gaps are cheap, and backwards jumps remain possible but are
    deliberately expensive.  A gap candidate leaves the previous script span
    unchanged and receives a small penalty.
    """
    if span is None:
        return -0.12, 0.0
    if last_span is None:
        return 0.0, 0.65

    overlap = _span_overlap(last_span, span)
    if overlap > 0:
        # Same-line and same-range retakes should remain attractive.  Partial
        # overlap gets a slightly lower consistency but is still preferable to
        # treating a long Take as a backwards jump merely because its start is
        # before the previous range end.
        penalty = -0.035 - (1.0 - overlap) * 0.035
        consistency = min(0.98, 0.76 + overlap * 0.20)
        return penalty, consistency

    if span[0] > last_span[1]:
        skipped = span[0] - last_span[1] - 1
        penalty = -min(0.38, max(0, skipped) * 0.018)
        consistency = max(0.62, 1.0 - min(0.38, skipped * 0.025))
        return penalty, consistency

    # Disjoint backwards movement.  This is legal because crews do pickups and
    # jump around the script, but it must not beat a coherent forward path on
    # weak text evidence.
    backwards = max(1, last_span[0] - span[1])
    return -min(1.8, 0.34 + 0.22 * backwards), 0.20


def align_block(
    groups: list[MulticamGroup],
    candidates_by_group: dict[str, list[Candidate]],
    script_segments: list[ScriptSegment],
) -> dict[str, Candidate | None]:
    """Range-aware monotonic many-to-one DP.

    Multiple Takes may map to the same script range, a Take may cover several
    consecutive script segments, and unmatched Takes are represented by gaps.
    State is the last selected script span rather than a single start position,
    so a candidate covering S14-S19 naturally advances the next Take from S19.
    """
    positions = {segment.segment_id: index for index, segment in enumerate(script_segments)}
    # state: last script span -> (score, selected candidates by group)
    states: dict[ScriptSpan | None, tuple[float, dict[str, Candidate | None]]] = {None: (0.0, {})}
    for group in groups:
        next_states: dict[ScriptSpan | None, tuple[float, dict[str, Candidate | None]]] = {}
        options = list(candidates_by_group.get(group.group_id, [])) + [None]
        for last_span, (score, path) in states.items():
            for candidate in options:
                span = _candidate_span(candidate, positions) if candidate else None
                transition_score, consistency = _transition(last_span, span)
                base = candidate.total_score if candidate else 0.0
                option_score = score + base + transition_score
                state_span = last_span if span is None else span
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
                    if span is not None:
                        if span[0] == span[1]:
                            evidence.append("拍摄块内按剧本顺序对齐")
                        else:
                            evidence.append("拍摄块内按剧本连续范围对齐")
                    else:
                        evidence.append("未进入顺序对齐的剧本位置")
                    selected[group.group_id] = replace(
                        candidate,
                        total_score=total_score,
                        sequence_score=sequence_score,
                        confidence=confidence,
                        evidence=tuple(dict.fromkeys(evidence)),
                    )
                previous = next_states.get(state_span)
                if previous is None or option_score > previous[0]:
                    next_states[state_span] = (option_score, selected)
        # Keep the state space bounded while retaining the best ranges.
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
            # An explicit compatibility override is a human decision. The
            # sequence DP may prefer an automatic repeated-take candidate, so
            # never let alignment silently replace the override.
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
            chosen_ids = chosen.script_segment_ids or ((chosen.script_segment_id,) if chosen.script_segment_id else ())
            rest = [
                candidate
                for candidate in current
                if (candidate.script_segment_ids or ((candidate.script_segment_id,) if candidate.script_segment_id else ())) != chosen_ids
            ]
            result[group.group_id] = [chosen] + rest
            metadata["aligned_groups"] += 1
    return result, metadata
