from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


_MAX_TAKE_INDEX = 100_000
_MAX_EPISODE = 9_999
_MAX_PLAN_COUNT = 80
_MAX_TOTAL_TAKES = 400


@dataclass(frozen=True)
class RoughPlacementPlan:
    take_start: int
    take_end: int
    episode: int

    @property
    def take_count(self) -> int:
        return self.take_end - self.take_start + 1

    def to_dict(self) -> dict[str, int]:
        return {
            "take_start": self.take_start,
            "take_end": self.take_end,
            "episode": self.episode,
            "take_count": self.take_count,
        }


_TAKE_PREFIX = r"(?:take|t|镜头|素材|序号|条目)?\s*"
_RANGE = r"(?P<start>\d{1,6})(?:\s*(?:-|~|～|—|–|到|至)\s*(?P<end>\d{1,6}))?"
_EPISODE = r"(?:第\s*)?(?P<episode>\d{1,4})\s*集"

# Explicit wording gets first priority. It covers the production phrases most
# likely to be copied from a handwritten slate or typed while looking at one.
_EXPLICIT = re.compile(
    rf"{_TAKE_PREFIX}{_RANGE}\s*(?:先|暂时|大概|粗略|粗)?\s*(?:归到|归入|归|放到|放进|放|算到|属于|对应|->|→|=>|=|/|：|:)\s*{_EPISODE}",
    re.IGNORECASE,
)

# Compact notation intentionally requires the first numeric range not to be an
# episode range itself. Examples: `1-10 第1集`, `T11~20 EP2`.
_COMPACT = re.compile(
    rf"{_TAKE_PREFIX}{_RANGE}(?!\s*集)\s*(?:[,，;；/|]\s*)?(?:ep\s*)?{_EPISODE}",
    re.IGNORECASE,
)


def _clean(text: object) -> str:
    value = str(text or "").strip()
    value = value.replace("－", "-").replace("―", "—")
    return re.sub(r"\s+", " ", value)[:4000]


def _plan(match: re.Match[str]) -> RoughPlacementPlan:
    start = int(match.group("start"))
    end = int(match.group("end") or start)
    episode = int(match.group("episode"))
    if start <= 0 or end <= 0 or start > _MAX_TAKE_INDEX or end > _MAX_TAKE_INDEX:
        raise ValueError("Take 序号必须在 1 到 100000 之间")
    if end < start:
        start, end = end, start
    if episode <= 0 or episode > _MAX_EPISODE:
        raise ValueError("集数必须在 1 到 9999 之间")
    return RoughPlacementPlan(start, end, episode)


def parse_rough_placement_text(text: object) -> list[RoughPlacementPlan]:
    """Parse coarse Take-range-to-episode notes without guessing script lines.

    This parser deliberately handles only explicit coarse placement facts. It
    never infers a scene, dialogue line, editorial state, Best/Keep/Reject, or
    character identity. A handwritten note can therefore stay approximate:

    - ``1-10 第1集；11-20 第2集``
    - ``镜头1-10先放第1集，11到20归第2集``
    - ``Take 3 -> 第1集``
    """

    raw = _clean(text)
    if not raw:
        return []

    matches: list[tuple[int, int, re.Match[str]]] = []
    occupied: list[tuple[int, int]] = []
    for pattern in (_EXPLICIT, _COMPACT):
        for match in pattern.finditer(raw):
            span = match.span()
            if any(span[0] < right and span[1] > left for left, right in occupied):
                continue
            occupied.append(span)
            matches.append((span[0], span[1], match))
    matches.sort(key=lambda row: (row[0], row[1]))

    plans: list[RoughPlacementPlan] = []
    seen_ranges: set[tuple[int, int]] = set()
    total_takes = 0
    for _left, _right, match in matches:
        plan = _plan(match)
        key = (plan.take_start, plan.take_end)
        if key in seen_ranges:
            continue
        # Overlapping ranges assigned to different episodes are almost always a
        # transcription mistake. Require the user to make the ambiguity explicit
        # instead of silently letting the later phrase win.
        for existing in plans:
            overlaps = plan.take_start <= existing.take_end and existing.take_start <= plan.take_end
            if overlaps and existing.episode != plan.episode:
                raise ValueError(
                    f"Take {max(plan.take_start, existing.take_start)} 附近被同时分到第"
                    f" {existing.episode} 集和第 {plan.episode} 集，请拆开后重试"
                )
        seen_ranges.add(key)
        plans.append(plan)
        total_takes += plan.take_count
        if len(plans) > _MAX_PLAN_COUNT or total_takes > _MAX_TOTAL_TAKES:
            raise ValueError("一次粗归集最多处理 80 个范围、400 个 Take")

    return plans


def resolve_rough_plans(
    plans: list[RoughPlacementPlan],
    groups: list[dict[str, Any]],
) -> dict[str, Any]:
    """Resolve logical Take indexes to current group ids, including split Takes."""

    by_take: dict[int, list[str]] = {}
    for ordinal, raw in enumerate(groups, start=1):
        if not isinstance(raw, dict):
            continue
        group_id = str(raw.get("group_id", "") or "").strip()
        if not group_id:
            continue
        try:
            take_index = int(raw.get("take_index", ordinal) or ordinal)
        except (TypeError, ValueError):
            take_index = ordinal
        if take_index > 0:
            by_take.setdefault(take_index, []).append(group_id)

    assignments: list[dict[str, Any]] = []
    missing: list[int] = []
    seen_group_ids: set[str] = set()
    for plan in plans:
        group_ids: list[str] = []
        plan_missing: list[int] = []
        for take_index in range(plan.take_start, plan.take_end + 1):
            resolved = by_take.get(take_index, [])
            if not resolved:
                missing.append(take_index)
                plan_missing.append(take_index)
                continue
            for group_id in resolved:
                if group_id not in seen_group_ids:
                    seen_group_ids.add(group_id)
                    group_ids.append(group_id)
        assignments.append(
            {
                **plan.to_dict(),
                "group_ids": group_ids,
                "resolved_groups": len(group_ids),
                "missing_take_indices": plan_missing,
            }
        )

    return {
        "plans": assignments,
        "resolved_groups": len(seen_group_ids),
        "missing_take_indices": sorted(set(missing)),
        "group_ids": list(seen_group_ids),
    }


__all__ = ["RoughPlacementPlan", "parse_rough_placement_text", "resolve_rough_plans"]
