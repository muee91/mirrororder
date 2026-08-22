from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from dataclasses import replace
from difflib import SequenceMatcher

from .config import ProjectConfig
from .models import Candidate, MulticamGroup, ScriptSegment, Transcript
from .transcript import slice_transcript


TRADITIONAL = str.maketrans("這個對於與說我你他們沒時會來為是嗎啊哪還兩萬錢進貨單據證據開店真實看見買單裡頭發票後給過這種樣子從業務員號碼電話聲音邊境署現場門戶內東西裡讓別人問題辦法開始發現轉賬報答應該還有這樣", "这个对于与说我你他们没时会来为是吗啊哪还两万钱进货单据证据开店真实看见买单里头发票后给过这种样子从业务员号码电话声音边境署现场门户内东西里让别人问题办法开始发现转账报答应该还有这样")
COMMANDS = ("321", "开始", "预备", "停", "卡", "再来", "再来一次", "走位", "不动", "休息")


def normalize_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKC", str(text or "")).translate(TRADITIONAL).lower()
    for old, new in (("咋", "怎么"), ("啥", "什么"), ("哪儿", "哪里"), ("这儿", "这里"), ("那儿", "那里")):
        normalized = normalized.replace(old, new)
    normalized = re.sub(r"\s+", "", normalized)
    normalized = re.sub(r"[，。！？；：、,.!?;:（）()【】\[\]“”‘’\"'·…—_\-]", "", normalized)
    normalized = re.sub(r"(.)\1{2,}", r"\1\1", normalized)
    return normalized


def _is_command(text: str) -> bool:
    normalized = normalize_text(text)
    return bool(normalized) and len(normalized) <= 18 and any(token in normalized for token in COMMANDS)


def _similar(left: str, right: str) -> float:
    if not left or not right:
        return 0.0
    ratio = SequenceMatcher(None, left, right, autojunk=False).ratio()
    matcher = SequenceMatcher(None, left, right, autojunk=False)
    lcs_length = sum(block.size for block in matcher.get_matching_blocks())
    lcs = lcs_length / max(1, min(len(left), len(right)))
    keywords = {token for token in re.findall(r"[\u4e00-\u9fff]{2,}|[a-z0-9]+", left) if len(token) >= 2}
    keyword_hits = sum(1 for token in keywords if token in right) / max(1, len(keywords))
    length = min(len(left), len(right)) / max(1, max(len(left), len(right)))
    return ratio * 0.40 + lcs * 0.30 + keyword_hits * 0.20 + length * 0.10


def _windows(transcript: Transcript, limit: int = 120) -> list[tuple[float, str]]:
    segments = list(transcript.segments)
    if not segments and transcript.text:
        return [(0.0, transcript.text)]
    result = []
    for index in range(len(segments)):
        for width in (1, 2, 3, 4):
            chunk = segments[index : index + width]
            if not chunk:
                continue
            text = "".join(item.text for item in chunk).strip()
            if text and not _is_command(text):
                result.append((chunk[0].start, text))
    unique: dict[str, tuple[float, str]] = {}
    for start, text in result:
        key = normalize_text(text)
        if len(key) >= 5 and key not in unique:
            unique[key] = (start, text)
    ordered = sorted(unique.values(), key=lambda item: item[0])
    if len(ordered) <= limit:
        return ordered
    # Keep coverage across a long take instead of keeping only its opening.
    indexes = [round(index * (len(ordered) - 1) / max(1, limit - 1)) for index in range(limit)]
    return [ordered[index] for index in indexes]


def _script_windows(segments: list[ScriptSegment]) -> list[tuple[ScriptSegment, tuple[ScriptSegment, ...], str]]:
    result = []
    for index, segment in enumerate(segments):
        for width in (1, 2, 3, 4):
            chunk = segments[index : index + width]
            if not chunk or any(item.type == "scene_heading" for item in chunk):
                continue
            if not any(item.type == "dialogue" for item in chunk):
                continue
            text = "".join(item.text for item in chunk)
            if text:
                result.append((segment, tuple(chunk), text))
    return result


def build_script_window_index(segments: list[ScriptSegment]) -> dict[str, list[tuple[ScriptSegment, tuple[ScriptSegment, ...], str, str]]]:
    index: dict[str, list[tuple[ScriptSegment, tuple[ScriptSegment, ...], str, str]]] = {}
    for segment, script_chunk, text in _script_windows(segments):
        normalized = normalize_text(text)
        for size in (4, 3, 2):
            grams = {normalized[position : position + size] for position in range(max(0, len(normalized) - size + 1))}
            for gram in grams:
                if gram:
                    index.setdefault(f"{size}:{gram}", []).append((segment, script_chunk, text, normalized))
    return index


def build_line_index(segments: list[ScriptSegment]) -> dict[str, list[tuple[ScriptSegment, str, set[str]]]]:
    """Build a tolerant line-level index for actor variants and noisy ASR."""
    index: dict[str, list[tuple[ScriptSegment, str, set[str]]]] = defaultdict(list)
    for segment in segments:
        if segment.type != "dialogue":
            continue
        normalized = normalize_text(segment.text)
        if len(normalized) < 4:
            continue
        grams = {normalized[position : position + 2] for position in range(len(normalized) - 1)}
        row = (segment, normalized, grams)
        for gram in grams:
            index[gram].append(row)
    return dict(index)


def _fuzzy_line_matches(
    text: str,
    line_index: dict[str, list[tuple[ScriptSegment, str, set[str]]]],
    limit: int = 8,
    minimum_length: int = 6,
    minimum_shared_grams: int = 2,
    minimum_score: float | None = None,
) -> list[tuple[float, ScriptSegment]]:
    """Return local dialogue matches, including imperfect spoken variants."""
    normalized = normalize_text(text)
    if len(normalized) < minimum_length or len(set(normalized)) < min(4, minimum_length):
        return []
    grams = {normalized[index : index + 2] for index in range(len(normalized) - 1)}
    # Prefer rare fragments for retrieval.  Common two-character phrases
    # ("现在", "你们", "不用"...) fan out to hundreds of script lines and
    # were the main source of the full-project slowdown.
    rare_grams = sorted(
        grams,
        key=lambda gram: (len(line_index.get(gram, [])) or 10**9, gram),
    )[:16]
    retrieval_grams = [gram for gram in rare_grams if line_index.get(gram)]
    if len(retrieval_grams) < 2:
        retrieval_grams = [gram for gram in grams if line_index.get(gram)]
    possible: dict[str, tuple[ScriptSegment, str, set[str], int]] = {}
    for gram in retrieval_grams:
        for segment, normalized_script, script_grams in line_index.get(gram, []):
            shared = len(grams & script_grams)
            current = possible.get(segment.segment_id)
            if current is None or shared > current[3]:
                possible[segment.segment_id] = (segment, normalized_script, script_grams, shared)

    scored: list[tuple[float, ScriptSegment]] = []
    for segment, normalized_script, script_grams, shared in possible.values():
        if shared < minimum_shared_grams:
            continue
        ratio = SequenceMatcher(None, normalized, normalized_script, autojunk=False).ratio()
        coverage = shared / max(1, min(len(grams), len(script_grams)))
        score = ratio * 0.65 + coverage * 0.35
        threshold = 0.42 if len(normalized) >= 10 else (0.45 if minimum_length < 6 else 0.50)
        if minimum_score is not None:
            threshold = max(threshold, minimum_score)
        if score >= threshold:
            scored.append((score, segment))
    scored.sort(key=lambda item: (item[0], item[1].segment_id), reverse=True)
    return scored[:limit]


def rescue_scene_prefix_candidates(
    group: MulticamGroup,
    transcripts: dict[str, Transcript],
    script_segments: list[ScriptSegment],
    config: ProjectConfig,
    scene_key: tuple[int, str],
    anchor_segment_id: str,
) -> list[Candidate]:
    """Recover a short opening line only inside a known neighboring scene.

    This is deliberately narrower than normal fuzzy matching. It is used when
    a Take sits immediately before a reliable same-scene anchor, so a short
    ASR fragment such as “你的菜牛肉” can support the scene's opening line
    without allowing a repeated phrase from another episode to win globally.
    """
    positions = {segment.segment_id: index for index, segment in enumerate(script_segments)}
    anchor_position = positions.get(anchor_segment_id)
    if anchor_position is None:
        return []
    scene_lines = [
        segment
        for segment in script_segments
        if segment.type == "dialogue"
        and (segment.episode, segment.scene_id) == scene_key
        and 0 < anchor_position - positions.get(segment.segment_id, anchor_position) <= 5
    ]
    if not scene_lines:
        return []
    line_index = build_line_index(scene_lines)
    priority = {camera: index for index, camera in enumerate(config.asr_camera_priority)}
    rows_by_segment: dict[str, list[dict[str, object]]] = defaultdict(list)
    for member in group.members:
        if member.clip_id not in transcripts:
            continue
        transcript = slice_transcript(
            transcripts[member.clip_id],
            float(member.source_start),
            float(member.source_end) if member.source_end is not None else None,
        )
        for relative_start, asr_text in _windows(transcript, config.max_transcript_windows):
            normalized_length = len(normalize_text(asr_text))
            if (
                normalized_length < 5
                or _is_command(asr_text)
                or sum("\u4e00" <= char <= "\u9fff" for char in asr_text) < 4
            ):
                continue
            for score, segment in _fuzzy_line_matches(
                asr_text,
                line_index,
                limit=3,
                minimum_length=5,
                minimum_shared_grams=1,
                minimum_score=0.47,
            ):
                rows_by_segment[segment.segment_id].append(
                    {
                        "score": score,
                        "relative_start": relative_start,
                        "text": asr_text,
                        "member": member,
                        "transcript": transcript,
                    }
                )
    if not rows_by_segment:
        return []

    # The first scene-local hit is more useful than a later repeated phrase
    # from the same long bridge recording.
    rows = sorted(
        (row for values in rows_by_segment.values() for row in values),
        key=lambda row: (float(row["relative_start"]), -float(row["score"])),
    )
    best = rows[0]
    segment = next(segment for segment in scene_lines if segment.segment_id == next(
        segment_id
        for segment_id, values in rows_by_segment.items()
        if best in values
    ))
    support = max(0, len(rows_by_segment[segment.segment_id]) - 1)
    total = min(1.0, float(best["score"]) + min(0.08, support * 0.04))
    member = best["member"]
    evidence = [
        "同场景可靠对白锚点前的开场近邻素材",
        f"短对白片段与第{segment.episode}集 {segment.scene_id} 的剧本文本弱匹配",
        f"代表音频：{member.name}",
        "仅作为场景前段候选；动作和极短台词仍需看片确认",
    ]
    return [
        Candidate(
            group_id=group.group_id,
            script_segment_id=segment.segment_id,
            total_score=round(total, 4),
            dialogue_score=round(min(1.0, total + 0.04), 4),
            sequence_score=round(total, 4),
            context_score=0.0,
            margin=0.0,
            method="scene_prefix_dialogue",
            confidence="possible_dialogue",
            evidence=tuple(evidence),
            script_segment_ids=(segment.segment_id,),
            transcript_clip_id=member.clip_id,
            transcript_text=str(best["text"]),
            relative_start=float(best["relative_start"]),
            alignment={"method": "scene_prefix_asr", "status": "not_run", "camera": member.camera},
        )
    ]


def _merge_adjacent_candidates(
    candidates: list[Candidate],
    script_segments: list[ScriptSegment],
) -> list[Candidate]:
    """Merge one Take's time-ordered hits into a script range.

    A long multicamera Take can start on the last line of one episode and
    continue into the next episode.  Treating those hits as competing
    one-line candidates makes the higher-scoring first phrase hide the real
    continuation.  Only merge hits that are both close in the script and
    monotonic in the Take's audio; unrelated repeated phrases remain separate.
    """
    if len(candidates) < 2:
        return candidates

    positions = {segment.segment_id: index for index, segment in enumerate(script_segments)}
    ordered_indexes = sorted(
        range(len(candidates)),
        key=lambda index: positions.get(candidates[index].script_segment_id or "", 10**9),
    )
    remaining = set(ordered_indexes)
    chains: list[list[Candidate]] = []
    while remaining:
        best_chain: list[int] = []
        chains_ending_at: dict[int, list[int]] = {}
        for current_index in ordered_indexes:
            if current_index not in remaining:
                continue
            current = candidates[current_index]
            current_position = positions.get(current.script_segment_id or "")
            current_start = current.relative_start
            best_ending = [current_index]
            for previous_index in ordered_indexes:
                if previous_index == current_index or previous_index not in remaining:
                    continue
                previous_chain = chains_ending_at.get(previous_index)
                if not previous_chain:
                    continue
                previous = candidates[previous_index]
                previous_position = positions.get(previous.script_segment_id or "")
                previous_start = previous.relative_start
                position_gap = (
                    current_position - previous_position
                    if previous_position is not None and current_position is not None
                    else None
                )
                time_gap = (
                    current_start - previous_start
                    if previous_start is not None and current_start is not None
                    else None
                )
                if (
                    position_gap is not None
                    and 0 < position_gap <= 5
                    and time_gap is not None
                    and -0.4 <= time_gap <= 45.0
                    and len(previous_chain) + 1 > len(best_ending)
                ):
                    best_ending = [*previous_chain, current_index]
            chains_ending_at[current_index] = best_ending
            if len(best_ending) > len(best_chain):
                best_chain = best_ending
        if len(best_chain) < 2:
            chains.extend([[candidates[index]] for index in sorted(remaining)])
            break
        chains.append([candidates[index] for index in best_chain])
        remaining.difference_update(best_chain)

    merged: list[Candidate] = []
    for chain in chains:
        if len(chain) == 1:
            merged.append(chain[0])
            continue
        first = chain[0]
        last = chain[-1]
        first_position = positions.get(first.script_segment_id or "")
        last_position = positions.get(last.script_segment_id or "")
        if first_position is None or last_position is None or first_position >= last_position:
            merged.extend(chain)
            continue
        script_range = tuple(
            segment.segment_id
            for segment in script_segments[first_position : last_position + 1]
            if segment.type != "scene_heading"
        )
        cameras = list(dict.fromkeys(
            str(candidate.alignment.get("camera"))
            for candidate in chain
            if candidate.alignment.get("camera")
        ))
        evidence = list(dict.fromkeys(item for candidate in chain for item in candidate.evidence))
        evidence.append(
            "同一 Take 内对白按时间递进覆盖剧本范围："
            f"第{first_segment_episode(script_segments, first_position)}集第"
            f"{script_segments[first_position].order}段 → 第"
            f"{script_segments[last_position].episode}集第{script_segments[last_position].order}段"
        )
        evidence.append("范围末端作为主归属；前段集数保留为跨集证据")
        transcript_text = " / ".join(
            dict.fromkeys(candidate.transcript_text for candidate in chain if candidate.transcript_text)
        )
        max_total = max(candidate.total_score for candidate in chain)
        continuity_bonus = min(0.08, 0.04 * (len(chain) - 1))
        total_score = min(1.0, max_total + continuity_bonus)
        dialogue_score = min(1.0, max(candidate.dialogue_score for candidate in chain) + continuity_bonus)
        merged.append(
            Candidate(
                group_id=first.group_id,
                script_segment_id=last.script_segment_id,
                total_score=round(total_score, 4),
                dialogue_score=round(dialogue_score, 4),
                sequence_score=round(min(1.0, max(candidate.sequence_score for candidate in chain) + continuity_bonus), 4),
                context_score=0.0,
                margin=round(max(candidate.margin for candidate in chain), 4),
                method="dialogue_sequence",
                confidence=(
                    "exact_dialogue"
                    if total_score >= 0.82 and dialogue_score >= 0.80 and max(candidate.margin for candidate in chain) >= 0.08
                    else "possible_dialogue"
                ),
                evidence=tuple(evidence),
                script_segment_ids=script_range,
                transcript_clip_id=last.transcript_clip_id,
                transcript_text=transcript_text,
                relative_start=min(
                    candidate.relative_start
                    for candidate in chain
                    if candidate.relative_start is not None
                ),
                relative_end=max(
                    candidate.relative_end
                    for candidate in chain
                    if candidate.relative_end is not None
                ) if any(candidate.relative_end is not None for candidate in chain) else None,
                alignment={
                    "method": "asr_sequence",
                    "status": "not_run",
                    "camera": cameras[-1] if cameras else "",
                    "cameras": cameras,
                },
            )
        )
    return sorted(
        merged,
        key=lambda candidate: (
            candidate.total_score,
            positions.get(candidate.script_segment_id or "", -1),
        ),
        reverse=True,
    )


def first_segment_episode(segments: list[ScriptSegment], position: int) -> int:
    """Small display helper kept separate from the range construction above."""
    return segments[position].episode


def match_group(
    group: MulticamGroup,
    transcripts: dict[str, Transcript],
    script_segments: list[ScriptSegment],
    config: ProjectConfig,
    script_window_index: dict[str, list[tuple[ScriptSegment, tuple[ScriptSegment, ...], str, str]] ] | None = None,
    line_index: dict[str, list[tuple[ScriptSegment, str, set[str]]]] | None = None,
    preserve_coherent_weak: bool = False,
) -> list[Candidate]:
    """Return explainable group-to-script candidates from all camera audio.

    A multicamera group can span an episode boundary or contain useful
    dialogue on different cameras.  Selecting one representative transcript
    loses those cases, so each available member is matched independently and
    evidence is merged by script segment.  Camera priority only breaks ties;
    it never suppresses a useful later fragment from another camera.
    """
    priority = {camera: index for index, camera in enumerate(config.asr_camera_priority)}
    available = [
        (
            member,
            slice_transcript(
                transcripts[member.clip_id],
                float(member.source_start),
                float(member.source_end) if member.source_end is not None else None,
            ),
        )
        for member in group.members
        if member.clip_id in transcripts
    ]
    available = [(member, transcript) for member, transcript in available if transcript.text.strip() or transcript.segments]
    if not available:
        return []

    # segment_id -> best local evidence per camera
    by_segment: dict[str, list[dict[str, object]]] = defaultdict(list)
    line_index = line_index or build_line_index(script_segments)
    for member, transcript in available:
        best_for_camera: dict[str, dict[str, object]] = {}
        for relative_start, asr_text in _windows(transcript, config.max_transcript_windows):
            for score, segment in _fuzzy_line_matches(asr_text, line_index):
                # Keep the old editor-view rescue path only for a reasonably
                # long local fragment.  Very short phrases such as “不用” or
                # “二十万” occur throughout the script and otherwise crowd a
                # real later-camera match out of max_candidates.
                normalized_length = len(normalize_text(asr_text))
                if score < config.possible_confidence and normalized_length < 10:
                    continue
                row = {
                    "score": score,
                    "relative_start": relative_start,
                    "segment": segment,
                    "text": asr_text,
                    "member": member,
                    "transcript": transcript,
                }
                previous = best_for_camera.get(segment.segment_id)
                if previous is None or score > float(previous["score"]):
                    best_for_camera[segment.segment_id] = row
        for row in best_for_camera.values():
            by_segment[str(row["segment"].segment_id)].append(row)

    scored: list[tuple[float, float, ScriptSegment, str, object, list[dict[str, object]]]] = []
    for rows in by_segment.values():
        rows.sort(
            key=lambda row: (
                float(row["score"]),
                -priority.get(row["member"].camera, 999),
            ),
            reverse=True,
        )
        best = rows[0]
        raw_score = float(best["score"])
        support_bonus = min(0.08, max(0, len(rows) - 1) * 0.04)
        scored.append(
            (
                min(1.0, raw_score + support_bonus),
                float(best["relative_start"]),
                best["segment"],
                str(best["text"]),
                best["member"],
                rows,
            )
        )
    scored.sort(key=lambda item: (item[0], item[3]), reverse=True)

    candidates: list[Candidate] = []
    for index, (total, relative_start, segment, asr_text, representative_member, rows) in enumerate(scored):
        next_score = scored[index + 1][0] if index + 1 < len(scored) else 0.0
        margin = max(0.0, total - next_score)
        dialogue_score = min(1.0, total + (0.04 if segment.type == "dialogue" else 0.0))
        # Keep the old editor-view floor for long, local spoken variants.  A
        # candidate below the normal threshold is still labelled possible,
        # never exact, and remains subject to human review.
        if total >= config.high_confidence and dialogue_score >= 0.80 and margin >= config.minimum_margin:
            confidence, method = "exact_dialogue", "dialogue"
        elif total >= min(0.42, config.possible_confidence):
            confidence, method = "possible_dialogue", "dialogue"
        else:
            continue

        transcript = next(row["transcript"] for row in rows if row["member"].clip_id == representative_member.clip_id)
        evidence = ["组内局部对白与剧本台词模糊匹配", f"代表音频：{representative_member.name}"]
        other_sources = [
            f"{row['member'].camera}机片段：{row['member'].name}"
            for row in rows
            if row["member"].clip_id != representative_member.clip_id
        ]
        if other_sources:
            evidence.append("同组其他机位也有对白线索：" + "、".join(dict.fromkeys(other_sources)))
        if margin >= config.minimum_margin:
            evidence.append("候选之间有可解释的分数间隔")
        candidates.append(
            Candidate(
                group_id=group.group_id,
                script_segment_id=segment.segment_id,
                total_score=round(total, 4),
                dialogue_score=round(dialogue_score, 4),
                sequence_score=round(total, 4),
                context_score=0.0,
                margin=round(margin, 4),
                method=method,
                confidence=confidence,
                evidence=tuple(evidence),
                script_segment_ids=(segment.segment_id,),
                transcript_clip_id=representative_member.clip_id,
                transcript_text=asr_text,
                relative_start=relative_start,
                relative_end=(
                    min(
                        float(representative_member.duration),
                        relative_start + (transcript.segments[-1].end - transcript.segments[0].start),
                    )
                    if transcript.segments
                    else None
                ),
                alignment={"method": "asr", "status": "not_run", "camera": representative_member.camera},
            )
        )
        # Keep a wider temporary pool.  A later-camera weak continuation can
        # sit below generic short-phrase hits and still be the important
        # cross-episode evidence after local sequence filtering below.
        if not preserve_coherent_weak and len(candidates) >= config.max_candidates * 3:
            break

    candidates = _merge_adjacent_candidates(candidates, script_segments)
    positions = {segment.segment_id: index for index, segment in enumerate(script_segments)}
    segment_by_id = {segment.segment_id: segment for segment in script_segments}
    coherent_weak_ids: set[int] = set()
    updated_candidates: list[Candidate] = []
    for candidate in candidates:
        ids = candidate.script_segment_ids or ((candidate.script_segment_id,) if candidate.script_segment_id else ())
        dialogue_segments = [
            segment_by_id[item]
            for item in ids
            if item in segment_by_id and segment_by_id[item].type == "dialogue"
        ]
        scenes = {(segment.episode, segment.scene_id) for segment in dialogue_segments}
        if (
            preserve_coherent_weak
            and
            candidate.method == "dialogue_sequence"
            and len(dialogue_segments) >= 2
            and len(scenes) == 1
            and candidate.total_score >= 0.42
        ):
            evidence = list(candidate.evidence)
            evidence.append("同一 Take 内多条弱对白按时间和剧本顺序递进，保留供人工复核")
            candidate = replace(candidate, evidence=tuple(dict.fromkeys(evidence)))
            coherent_weak_ids.add(id(candidate))
        updated_candidates.append(candidate)
    candidates = updated_candidates
    strong = [candidate for candidate in candidates if candidate.total_score >= config.possible_confidence]
    if strong:
        anchor_positions = [positions[candidate.script_segment_id] for candidate in strong if candidate.script_segment_id in positions]
        if anchor_positions:
            primary_camera = strong[0].alignment.get("camera")
            candidates = [
                candidate
                for candidate in candidates
                if candidate.total_score >= config.possible_confidence
                or id(candidate) in coherent_weak_ids
                or (
                    candidate.alignment.get("camera") != primary_camera
                    and any(abs(positions.get(candidate.script_segment_id, 10**9) - anchor) <= 12 for anchor in anchor_positions)
                )
            ]
    else:
        # Do not discard every candidate merely because it falls below the
        # normal possible-dialogue threshold. Long, local ASR windows often
        # contain real actor variants but score lower after Chinese ASR noise
        # and omitted words. Keep them as possible_dialogue so the sequence
        # alignment and human review can use the evidence. Short production
        # commands and isolated phrases remain excluded by the length floor.
        candidates = [
            candidate
            for candidate in candidates
            if candidate.total_score >= min(0.42, config.possible_confidence)
            and len(normalize_text(candidate.transcript_text)) >= 12
        ]
    return candidates[: config.max_candidates]


def context_only_candidate(
    group: MulticamGroup,
    script_segment_id: str | None,
    evidence: list[str],
    context_episodes: tuple[int, ...] = (),
) -> Candidate:
    return Candidate(
        group_id=group.group_id,
        script_segment_id=script_segment_id,
        total_score=0.0,
        dialogue_score=0.0,
        sequence_score=0.0,
        context_score=0.5,
        margin=0.0,
        method="context_only",
        confidence="context_only",
        evidence=tuple(evidence),
        context_episodes=tuple(context_episodes),
    )
