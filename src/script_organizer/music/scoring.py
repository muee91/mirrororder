from __future__ import annotations

import math
import re
from typing import Iterable

from .models import MusicAsset, MusicBrief, MusicCandidate, MusicSection

SYNONYMS = {
    "suspense": {"悬疑", "mystery", "tension", "thriller", "dark"},
    "mystery": {"秘密", "suspense", "investigation", "dark"},
    "danger": {"危险", "thriller", "action", "pulse", "tense"},
    "romance": {"爱情", "romantic", "warm", "love", "emotional"},
    "sad": {"悲伤", "sad", "melancholy", "emotional", "piano"},
    "comic": {"喜剧", "funny", "playful", "light", "comedy"},
    "reveal": {"反转", "reveal", "build", "dramatic", "climax"},
    "cinematic": {"电影", "score", "underscore", "soundtrack"},
}


def _tokens(values: Iterable[str]) -> set[str]:
    result: set[str] = set()
    for value in values:
        normalized = str(value).casefold()
        result.update(item for item in re.split(r"[,，;/|\s_\-.]+", normalized) if item)
        for key, synonyms in SYNONYMS.items():
            if key in normalized or any(term in normalized for term in synonyms):
                result.add(key)
    return result


def _semantic(brief: MusicBrief, asset: MusicAsset, section: MusicSection) -> float:
    wanted = _tokens((*brief.tags, brief.purpose, brief.text))
    offered = _tokens((*asset.tags, *asset.moods, *asset.styles, asset.title, *section.tags, section.kind))
    if not wanted or not offered:
        return 0.0
    overlap = wanted & offered
    return min(1.0, len(overlap) / max(2.0, math.sqrt(len(wanted) * len(offered))))


def _duration_fit(brief: MusicBrief, section: MusicSection) -> float:
    if brief.duration <= 0 or section.duration <= 0:
        return 0.0
    ratio = min(brief.duration, section.duration) / max(brief.duration, section.duration)
    if section.duration >= brief.duration:
        return min(1.0, 0.72 + 0.28 * ratio)
    return 0.45 * ratio


def _dialogue_fit(brief: MusicBrief, asset: MusicAsset) -> float:
    vocal_penalty = asset.vocal_probability * (0.55 + 0.45 * brief.dialogue_density)
    energy_penalty = max(0.0, asset.energy - max(0.35, brief.target_energy)) * brief.dialogue_density * 0.65
    return max(0.0, min(1.0, 1.0 - vocal_penalty - energy_penalty))


def _energy_fit(brief: MusicBrief, asset: MusicAsset) -> float:
    return max(0.0, 1.0 - abs(asset.energy - brief.target_energy))


def _best_section(brief: MusicBrief, asset: MusicAsset) -> tuple[MusicSection, dict[str, float]]:
    sections = asset.sections or (MusicSection(0.0, asset.duration, "full", ()),)
    best = sections[0]
    best_scores = {"semantic": 0.0, "duration": 0.0}
    best_value = -1.0
    for section in sections:
        semantic = _semantic(brief, asset, section)
        duration = _duration_fit(brief, section)
        value = semantic * 0.7 + duration * 0.3
        if value > best_value:
            best_value = value
            best = section
            best_scores = {"semantic": semantic, "duration": duration}
    return best, best_scores


def score_candidate(
    brief: MusicBrief,
    asset: MusicAsset,
    *,
    allow_unverified: bool = False,
) -> MusicCandidate:
    eligible = asset.license.eligible or allow_unverified
    if not eligible:
        return MusicCandidate(
            cue_id=brief.cue_id,
            asset_id=asset.asset_id,
            source_start=0.0,
            source_end=0.0,
            score=0.0,
            scores={},
            eligible=False,
            rejection_reason="license_gate",
        )
    section, local = _best_section(brief, asset)
    dialogue = _dialogue_fit(brief, asset)
    energy = _energy_fit(brief, asset)
    semantic = local["semantic"]
    duration = local["duration"]
    score = semantic * 0.40 + duration * 0.20 + dialogue * 0.22 + energy * 0.18
    source_start = section.start
    source_end = min(section.end, source_start + brief.duration)
    if source_end - source_start < min(brief.duration, 1.0) and asset.duration > 0:
        source_start = max(0.0, min(section.start, asset.duration - brief.duration))
        source_end = min(asset.duration, source_start + brief.duration)
    return MusicCandidate(
        cue_id=brief.cue_id,
        asset_id=asset.asset_id,
        source_start=source_start,
        source_end=source_end,
        score=score,
        scores={
            "semantic": semantic,
            "duration": duration,
            "dialogue": dialogue,
            "energy": energy,
        },
        eligible=True,
    )


def rank_candidates(
    brief: MusicBrief,
    assets: list[MusicAsset],
    *,
    top_k: int = 5,
    allow_unverified: bool = False,
) -> list[MusicCandidate]:
    rows = [score_candidate(brief, asset, allow_unverified=allow_unverified) for asset in assets]
    rows = [item for item in rows if item.eligible]
    rows.sort(key=lambda item: (-item.score, item.asset_id, item.source_start))
    return rows[: max(1, top_k)]


def _transition(previous: MusicCandidate, current: MusicCandidate, by_id: dict[str, MusicAsset]) -> float:
    if previous.asset_id == current.asset_id:
        return 0.12
    left = by_id.get(previous.asset_id)
    right = by_id.get(current.asset_id)
    if left is None or right is None:
        return 0.0
    left_tags = _tokens((*left.tags, *left.moods, *left.styles))
    right_tags = _tokens((*right.tags, *right.moods, *right.styles))
    shared = len(left_tags & right_tags)
    bonus = min(0.06, shared * 0.015)
    if left.bpm and right.bpm:
        ratio = min(left.bpm, right.bpm) / max(left.bpm, right.bpm)
        bonus += max(0.0, ratio - 0.8) * 0.15
    return min(0.10, bonus)


def choose_global_path(
    briefs: list[MusicBrief],
    candidates_by_cue: dict[str, list[MusicCandidate]],
    assets: list[MusicAsset],
) -> list[MusicCandidate | None]:
    if not briefs:
        return []
    by_id = {item.asset_id: item for item in assets}
    states: list[dict[int, tuple[float, int | None]]] = []
    for index, brief in enumerate(briefs):
        options = candidates_by_cue.get(brief.cue_id, [])
        if not options:
            states.append({})
            continue
        current: dict[int, tuple[float, int | None]] = {}
        if index == 0 or not states[index - 1]:
            for option_index, option in enumerate(options):
                current[option_index] = (option.score, None)
        else:
            previous_options = candidates_by_cue.get(briefs[index - 1].cue_id, [])
            for option_index, option in enumerate(options):
                best_score = -1.0
                best_previous: int | None = None
                for previous_index, (path_score, _) in states[index - 1].items():
                    if previous_index >= len(previous_options):
                        continue
                    score = path_score + option.score + _transition(previous_options[previous_index], option, by_id)
                    if score > best_score:
                        best_score = score
                        best_previous = previous_index
                current[option_index] = (best_score, best_previous)
        states.append(current)

    result: list[MusicCandidate | None] = [None] * len(briefs)
    last_index = next((index for index in range(len(briefs) - 1, -1, -1) if states[index]), None)
    if last_index is None:
        return result
    option_index = max(states[last_index], key=lambda key: states[last_index][key][0])
    for index in range(last_index, -1, -1):
        options = candidates_by_cue.get(briefs[index].cue_id, [])
        if not options or option_index not in states[index]:
            option_index = None
            continue
        result[index] = options[option_index]
        option_index = states[index][option_index][1]
        if option_index is None and index > 0:
            earlier = next((j for j in range(index - 1, -1, -1) if states[j]), None)
            if earlier is not None and earlier == index - 1:
                option_index = max(states[earlier], key=lambda key: states[earlier][key][0])
    return result
