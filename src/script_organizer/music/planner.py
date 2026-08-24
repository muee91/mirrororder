from __future__ import annotations

import json
import math
import re
from collections import defaultdict
from typing import Any

from ..config import ProjectConfig
from ..script_parser import parse_script
from .models import MusicBrief

TAG_RULES: tuple[tuple[tuple[str, ...], tuple[str, ...], str, float], ...] = (
    (("悬疑", "秘密", "调查", "怀疑", "跟踪", "真相", "发现"), ("suspense", "mystery", "cinematic"), "tension", 0.62),
    (("危险", "威胁", "追", "杀", "打", "枪", "逃", "绑架"), ("danger", "thriller", "pulse"), "danger", 0.82),
    (("爱", "喜欢", "拥抱", "亲吻", "恋", "心动"), ("romance", "warm", "emotional"), "romance", 0.38),
    (("哭", "死", "离开", "分手", "失去", "难过", "悲"), ("sad", "emotional", "piano"), "emotion", 0.34),
    (("笑", "搞笑", "尴尬", "误会", "逗", "喜剧"), ("comic", "light", "playful"), "comedy", 0.48),
    (("反转", "原来", "竟然", "没想到", "揭晓", "曝光"), ("reveal", "dramatic", "build"), "reveal", 0.72),
)


def _read_script(config: ProjectConfig) -> list[dict[str, Any]]:
    path = config.output_dir / "script.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        rows = payload.get("segments", []) if isinstance(payload, dict) else []
        if isinstance(rows, list) and rows:
            return [item for item in rows if isinstance(item, dict)]
    except (OSError, ValueError):
        pass
    return [item.to_dict() for item in parse_script(config.script).segments]


def _tags_for(text: str) -> tuple[tuple[str, ...], str, float]:
    tags = {"instrumental", "underscore", "dialogue-friendly"}
    purpose = "underscore"
    energy = 0.42
    matched = False
    for words, rule_tags, rule_purpose, rule_energy in TAG_RULES:
        if any(word in text for word in words):
            matched = True
            tags.update(rule_tags)
            purpose = rule_purpose
            energy = max(energy, rule_energy)
    if not matched:
        tags.update(("neutral", "cinematic"))
    return tuple(sorted(tags)), purpose, energy


def _dialogue_density(rows: list[dict[str, Any]]) -> float:
    if not rows:
        return 0.0
    dialogue = sum(1 for item in rows if str(item.get("type", "")) == "dialogue")
    return min(1.0, dialogue / max(1, len(rows)))


def build_music_briefs(
    config: ProjectConfig,
    *,
    episode: int | None = None,
    timeline_seconds: float | None = None,
    scene_windows: dict[tuple[int, str], dict[str, Any]] | None = None,
) -> list[MusicBrief]:
    """Build scene-level music briefs.

    V1 may supply scene_windows derived from assembly_timeline.v1. When a scene
    has a real assembly window, that timing is authoritative for the music cue.
    Missing scenes retain the V0 estimated timing so incomplete assemblies remain
    inspectable without pretending those estimates are production truth.
    """

    segments = _read_script(config)
    grouped: dict[tuple[int, str], list[dict[str, Any]]] = defaultdict(list)
    order: list[tuple[int, str]] = []
    for row in segments:
        try:
            row_episode = int(row.get("episode", 0) or 0)
        except (TypeError, ValueError):
            continue
        if episode is not None and row_episode != episode:
            continue
        scene_id = str(row.get("scene_id", "UNKNOWN") or "UNKNOWN")
        key = (row_episode, scene_id)
        if key not in grouped:
            order.append(key)
        grouped[key].append(row)
    if not order:
        return []

    weights = []
    for key in order:
        text = " ".join(str(item.get("text", "") or "") for item in grouped[key]).strip()
        weights.append(max(1.0, math.sqrt(max(1, len(re.sub(r"\s+", "", text))))))

    if timeline_seconds is not None and timeline_seconds > 0:
        total = max(1.0, sum(weights))
        durations = [max(3.0, timeline_seconds * weight / total) for weight in weights]
        scale = timeline_seconds / sum(durations)
        durations = [value * scale for value in durations]
    else:
        durations = [max(8.0, min(45.0, 5.0 + weight * 3.0)) for weight in weights]

    briefs: list[MusicBrief] = []
    cursor = 0.0
    windows = scene_windows or {}
    for index, key in enumerate(order):
        ep, scene_id = key
        rows = grouped[key]
        text = " ".join(str(item.get("text", "") or "") for item in rows).strip()
        tags, purpose, energy = _tags_for(text)
        density = _dialogue_density(rows)
        if density >= 0.6:
            energy = min(energy, 0.55)

        window = windows.get(key, {})
        if window and float(window.get("duration", 0.0) or 0.0) > 0:
            start = max(0.0, float(window.get("start", 0.0) or 0.0))
            end = max(start, float(window.get("end", start) or start))
        else:
            duration = durations[index]
            start = cursor
            end = cursor + duration

        briefs.append(
            MusicBrief(
                cue_id=f"MUSIC-E{ep:03d}-{index + 1:03d}",
                episode=ep,
                scene_id=scene_id,
                text=text[:1200],
                start=start,
                end=end,
                purpose=purpose,
                tags=tags,
                target_energy=energy,
                dialogue_density=density,
            )
        )
        cursor = max(cursor, end)
    return briefs
