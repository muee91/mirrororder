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


def _duration_fit(target: float, actual: float) -> float:
    if target <= 0 or actual <= 0:
        return 0.0
    ratio = min(target, actual) / max(target, actual)
    if actual >= target:
        return min(1.0, 0.76 + 0.24 * ratio)
    return 0.52 * ratio


def _dialogue_fit(brief: MusicBrief, asset: MusicAsset) -> float:
    vocal_penalty = asset.vocal_probability * (0.55 + 0.45 * brief.dialogue_density)
    energy_penalty = max(0.0, asset.energy - max(0.35, brief.target_energy)) * brief.dialogue_density * 0.65
    return max(0.0, min(1.0, 1.0 - vocal_penalty - energy_penalty))


def _window_energy(asset: MusicAsset, section: MusicSection, start: float, end: float) -> float:
    values = [
        value
        for time_value, value in asset.energy_curve
        if start <= time_value < end
    ]
    if values:
        return sum(values) / len(values)
    if section.energy is not None:
        return section.energy
    return asset.energy


def _energy_fit(brief: MusicBrief, value: float) -> float:
    return max(0.0, 1.0 - abs(value - brief.target_energy))


def _nearest(value: float, anchors: tuple[float, ...], tolerance: float) -> tuple[float | None, float | None]:
    if not anchors:
        return None, None
    candidate = min(anchors, key=lambda item: abs(item - value))
    error = abs(candidate - value)
    if error > tolerance:
        return None, None
    return candidate, error


def _bounded(values: list[float], limit: int = 72) -> list[float]:
    if len(values) <= limit:
        return values
    step = max(1, len(values) // limit)
    sampled = values[::step]
    if values[-1] not in sampled:
        sampled.append(values[-1])
    return sampled[:limit]


def _start_anchors(asset: MusicAsset, section: MusicSection, target_duration: float) -> list[tuple[float, str, float]]:
    latest = max(section.start, section.end - max(0.5, min(target_duration, section.duration)))
    anchors: list[tuple[float, str, float]] = [(section.start, section.boundary_source or "section", 0.0)]
    downbeats = _bounded([value for value in asset.downbeats if section.start <= value <= latest])
    if downbeats:
        anchors.extend((value, "downbeat", 0.0) for value in downbeats)
    else:
        beats = _bounded([value for value in asset.beats if section.start <= value <= latest], limit=48)
        anchors.extend((value, "beat", 0.0) for value in beats)
    unique: dict[float, tuple[float, str, float]] = {}
    for item in anchors:
        unique.setdefault(round(item[0], 6), item)
    return list(unique.values())


def _snap_end(
    asset: MusicAsset,
    section: MusicSection,
    start: float,
    target_duration: float,
) -> tuple[float, str, float | None]:
    desired = min(section.end, start + target_duration)
    minimum = start + min(target_duration * 0.72, max(0.5, target_duration - 1.5))
    for anchors, label, tolerance in (
        (asset.downbeats, "downbeat", 1.25),
        (asset.beats, "beat", 0.75),
    ):
        snapped, error = _nearest(desired, anchors, tolerance)
        if snapped is not None and snapped > start and snapped >= minimum and snapped <= section.end + 1e-6:
            return snapped, label, error
    return desired, section.boundary_source or "section", 0.0 if abs(desired - section.end) < 1e-6 else None


def _boundary_score(start_source: str, end_source: str) -> float:
    weights = {
        "downbeat": 1.0,
        "beat": 0.78,
        "energy+downbeat": 0.82,
        "metadata": 0.65,
        "energy": 0.55,
        "analysis": 0.50,
        "duration": 0.35,
        "section": 0.35,
        "full": 0.25,
    }
    return (weights.get(start_source, 0.35) + weights.get(end_source, 0.35)) / 2.0


def _best_window(
    brief: MusicBrief,
    asset: MusicAsset,
) -> tuple[MusicSection, float, float, dict[str, float], str, bool, float | None]:
    sections = asset.sections or (MusicSection(0.0, asset.duration, "full", (), None, "full"),)
    best_section = sections[0]
    best_start = best_section.start
    best_end = min(best_section.end, best_start + brief.duration)
    best_scores = {"semantic": 0.0, "duration": 0.0, "energy": 0.0, "boundary": 0.0}
    best_source = best_section.boundary_source
    best_aligned = False
    best_error: float | None = None
    best_value = -1.0

    for section in sections:
        semantic = _semantic(brief, asset, section)
        for start, start_source, start_error in _start_anchors(asset, section, brief.duration):
            end, end_source, end_error = _snap_end(asset, section, start, brief.duration)
            actual = max(0.0, end - start)
            duration = _duration_fit(brief.duration, actual)
            energy_value = _window_energy(asset, section, start, end)
            energy = _energy_fit(brief, energy_value)
            boundary = _boundary_score(start_source, end_source)
            value = semantic * 0.40 + duration * 0.20 + energy * 0.20 + boundary * 0.20
            if value > best_value:
                best_value = value
                best_section = section
                best_start = start
                best_end = end
                best_scores = {
                    "semantic": semantic,
                    "duration": duration,
                    "energy": energy,
                    "boundary": boundary,
                }
                best_source = f"{start_source}->{end_source}"
                best_aligned = start_source in {"beat", "downbeat"} or end_source in {"beat", "downbeat"}
                errors = [item for item in (start_error, end_error) if item is not None]
                best_error = sum(errors) if errors else None
    return best_section, best_start, best_end, best_scores, best_source, best_aligned, best_error


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

    _section, source_start, source_end, local, boundary_source, beat_aligned, alignment_error = _best_window(brief, asset)
    dialogue = _dialogue_fit(brief, asset)
    semantic = local["semantic"]
    duration = local["duration"]
    energy = local["energy"]
    boundary = local["boundary"]
    score = semantic * 0.34 + duration * 0.14 + dialogue * 0.18 + energy * 0.18 + boundary * 0.16
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
            "boundary": boundary,
        },
        eligible=True,
        boundary_source=boundary_source,
        beat_aligned=beat_aligned,
        alignment_error=alignment_error,
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
        continuation_gap = current.source_start - previous.source_end
        if -1.0 <= continuation_gap <= 8.0:
            return 0.15
        return 0.11
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
