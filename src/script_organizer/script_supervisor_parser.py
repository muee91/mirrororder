from __future__ import annotations

import re
from typing import Any

from .model_registry import AssistantLanguageModel
from .script_supervisor_store import SHOT_TYPES, TAKE_STATUSES


SHOT_ALIASES = {
    "全景": "wide",
    "大全": "wide",
    "全身": "full",
    "中景": "medium",
    "中近景": "medium_closeup",
    "近景": "closeup",
    "特写": "extreme_closeup",
    "大特写": "extreme_closeup",
    "细节": "insert",
    "插入": "insert",
}


def _text(value: object, limit: int = 2000) -> str:
    return str(value or "").strip()[:limit]


def _first(pattern: str, text: str) -> str:
    match = re.search(pattern, text, re.IGNORECASE)
    return (match.group(1).strip() if match else "")


def deterministic_parse(text: str, previous: dict[str, Any] | None = None) -> dict[str, Any]:
    raw = _text(text)
    prior = previous if isinstance(previous, dict) else {}
    inherit = bool(re.search(r"(?:同上|上一条|照上条|和上条一样)", raw))
    result: dict[str, Any] = {
        "episode": prior.get("episode") if inherit else None,
        "scene": str(prior.get("scene", "") or "") if inherit else "",
        "shot": str(prior.get("shot", "") or "") if inherit else "",
        "take_number": prior.get("take_number") if inherit else None,
        "status": str(prior.get("status", "unmarked") or "unmarked") if inherit else "unmarked",
        "note": raw,
        "angle_shots": {},
        "range_hint": "",
        "inherit_previous": inherit,
        "parser": "deterministic",
    }

    episode = _first(r"(?:第\s*)?(\d{1,4})\s*集", raw)
    scene = _first(r"(?:第\s*)?([0-9]+[A-Za-z]?)\s*场", raw)
    shot = _first(r"(?:第\s*)?([0-9]+[A-Za-z]?)\s*镜", raw)
    take = _first(r"(?:第\s*)?([0-9]+)\s*(?:次|条|take\b|t\b)", raw)
    if episode:
        result["episode"] = int(episode)
    if scene:
        result["scene"] = scene
    if shot:
        result["shot"] = shot
    if take:
        result["take_number"] = int(take)

    if re.search(r"\bNG\b|废条|不能用|不要用|作废", raw, re.IGNORECASE):
        result["status"] = "ng"
    elif re.search(r"部分可用|前半段|后半段|前面可用|后面可用|只要前|只要后|只用前|只用后", raw):
        result["status"] = "partial"
    elif re.search(r"\bOK\b|可用|过了|这条过|能用|采用", raw, re.IGNORECASE):
        result["status"] = "usable"

    if re.search(r"前半段|前面可用|只要前|只用前", raw):
        result["range_hint"] = "first_half"
    elif re.search(r"后半段|后面可用|只要后|只用后", raw):
        result["range_hint"] = "second_half"

    camera_pattern = r"([A-Za-z][A-Za-z0-9_-]{0,7}|A机|B机|C机)\s*(?:机位|机)?\s*(大全|大特写|中近景|全景|全身|中景|近景|特写|细节|插入)"
    for camera, label in re.findall(camera_pattern, raw, re.IGNORECASE):
        clean_camera = camera.upper().replace("机", "")
        shot_type = SHOT_ALIASES.get(label, "unknown")
        if shot_type in SHOT_TYPES:
            result["angle_shots"][clean_camera] = shot_type

    if not result["angle_shots"]:
        generic = next((label for label in SHOT_ALIASES if label in raw), "")
        if generic:
            result["generic_shot"] = SHOT_ALIASES[generic]

    return result


def _sanitize_model(payload: dict[str, Any], fallback: dict[str, Any]) -> dict[str, Any]:
    result = dict(fallback)
    try:
        episode = payload.get("episode")
        if episode not in {None, ""}:
            episode = int(episode)
            if episode > 0:
                result["episode"] = episode
    except (TypeError, ValueError):
        pass
    for key in ("scene", "shot"):
        value = _text(payload.get(key), 80)
        if value:
            result[key] = value
    try:
        take = payload.get("take_number")
        if take not in {None, ""}:
            take = int(take)
            if take > 0:
                result["take_number"] = take
    except (TypeError, ValueError):
        pass
    status = _text(payload.get("status"), 40)
    if status in TAKE_STATUSES:
        result["status"] = status
    note = _text(payload.get("note"), 2000)
    if note:
        result["note"] = note
    range_hint = _text(payload.get("range_hint"), 40)
    if range_hint in {"", "first_half", "second_half", "needs_viewing"}:
        result["range_hint"] = range_hint
    raw_angles = payload.get("angle_shots", {}) if isinstance(payload.get("angle_shots"), dict) else {}
    angle_shots = dict(result.get("angle_shots", {}))
    for camera, shot_type in raw_angles.items():
        clean_camera = _text(camera, 20).upper().replace("机", "")
        clean_shot = _text(shot_type, 40)
        if clean_camera and clean_shot in SHOT_TYPES:
            angle_shots[clean_camera] = clean_shot
    result["angle_shots"] = angle_shots
    generic = _text(payload.get("generic_shot"), 40)
    if generic in SHOT_TYPES:
        result["generic_shot"] = generic
    result["parser"] = "assistant_model"
    return result


def parse_supervisor_text(
    text: str,
    *,
    previous: dict[str, Any] | None = None,
    allow_model: bool = True,
) -> dict[str, Any]:
    base = deterministic_parse(text, previous)
    if not allow_model:
        return base
    model = AssistantLanguageModel()
    if not model.enabled:
        return base
    system = """
你是影视后期场记转录器。只从用户原话提取结构事实，不做创意决定。
返回 JSON：episode(int|null), scene(string), shot(string), take_number(int|null),
status(unmarked|usable|partial|ng), note(string),
angle_shots(object: camera -> unknown|wide|full|medium|medium_closeup|closeup|extreme_closeup|insert),
generic_shot(同上枚举或空), range_hint(""|first_half|second_half|needs_viewing)。
禁止编造秒数、人物身份、Best/Keep/Reject、剧本归集或素材采用结论。
若用户说“前半段/后半段”，只能输出 range_hint，不得猜时间码。
""".strip()
    payload = model.complete_json(
        system=system,
        context={"utterance": _text(text), "previous": previous or {}, "deterministic": base},
        temperature=0.0,
    )
    return _sanitize_model(payload, base) if isinstance(payload, dict) else base
