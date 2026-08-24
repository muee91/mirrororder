from __future__ import annotations

import re
from typing import Any

from .model_registry import AssistantLanguageModel
from .script_supervisor_store import SHOT_TYPES, TAKE_STATUSES


SHOT_ALIASES = {
    "大远景": "wide",
    "远景": "wide",
    "全景": "wide",
    "大全": "wide",
    "全身": "full",
    "半身": "medium",
    "中景": "medium",
    "中近景": "medium_closeup",
    "近景": "closeup",
    "特写": "extreme_closeup",
    "大特写": "big_closeup",
    "细节": "insert",
    "插入": "insert",
}

# Short forms are only accepted directly after a camera label. Treating a bare
# “中” or “近” as a generic shot type would create too many false positives in
# free-form Chinese notes.
CAMERA_SHORT_SHOTS = {
    "全": "wide",
    "远": "wide",
    "中": "medium",
    "中近": "medium_closeup",
    "近": "closeup",
    "特": "extreme_closeup",
}
CHINESE_DIGITS = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def _text(value: object, limit: int = 2000) -> str:
    return str(value or "").strip()[:limit]


def _first(pattern: str, text: str) -> str:
    match = re.search(pattern, text, re.IGNORECASE)
    return (match.group(1).strip() if match else "")


def _positive_int(value: object) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _positive_int_text(value: object) -> int | None:
    text = _text(value, 16)
    direct = _positive_int(text)
    if direct is not None:
        return direct
    if not text or any(character not in CHINESE_DIGITS and character != "十" for character in text):
        return None
    if "十" not in text:
        return CHINESE_DIGITS.get(text)
    left, right = text.split("十", 1)
    tens = CHINESE_DIGITS.get(left, 1) if left else 1
    ones = CHINESE_DIGITS.get(right, 0) if right else 0
    number = tens * 10 + ones
    return number if number > 0 else None


def deterministic_parse(text: str, previous: dict[str, Any] | None = None) -> dict[str, Any]:
    raw = _text(text)
    prior = previous if isinstance(previous, dict) else {}
    inherit_all = bool(re.search(r"(?:同上|上一条|照上条|和上条一样|同前)", raw))
    same_scene = bool(re.search(r"(?:同场|接上场|还是这场)", raw))
    next_take = bool(re.search(r"(?:下一条|再一条|再来一条|又一条|下一次)", raw))

    inherit_episode = inherit_all or same_scene or next_take
    inherit_scene = inherit_all or same_scene or next_take
    inherit_shot = inherit_all or next_take
    prior_take = _positive_int(prior.get("take_number"))

    result: dict[str, Any] = {
        "episode": prior.get("episode") if inherit_episode else None,
        "scene": str(prior.get("scene", "") or "") if inherit_scene else "",
        "shot": str(prior.get("shot", "") or "") if inherit_shot else "",
        "take_number": (prior_take + 1) if next_take and prior_take is not None else (prior.get("take_number") if inherit_all else None),
        "status": str(prior.get("status", "unmarked") or "unmarked") if inherit_all else "unmarked",
        "note": raw,
        "angle_shots": {},
        "range_hint": "",
        "inherit_previous": bool(inherit_all or same_scene or next_take),
        "parser": "deterministic",
    }

    # Common handwritten compact form: `12-3-2` => scene 12, shot 3, take 2.
    compact = re.search(
        r"(?<!\d)([0-9]+[A-Za-z]?)\s*[-/]\s*([0-9]+[A-Za-z]?)\s*[-/]\s*([0-9]+)(?!\d)",
        raw,
        re.IGNORECASE,
    )
    if compact:
        result["scene"] = compact.group(1)
        result["shot"] = compact.group(2)
        result["take_number"] = int(compact.group(3))

    episode = _first(r"(?:第\s*)?(\d{1,4})\s*集", raw) or _first(r"\b(?:EP|E)\s*0*(\d{1,4})\b", raw)
    scene = _first(r"(?:第\s*)?([0-9]+[A-Za-z]?)\s*场", raw) or _first(r"\b(?:SC|S)\s*0*([0-9]+[A-Za-z]?)\b", raw)
    shot = _first(r"(?:第\s*)?([0-9]+[A-Za-z]?)\s*镜", raw)
    take = (
        _first(r"第\s*([0-9]+|[零一二两三四五六七八九十]+)\s*(?:次|条)", raw)
        or _first(r"([0-9]+)\s*(?:次|条|take\b|t\b)", raw)
        or _first(r"\b(?:TAKE|T)\s*0*(\d+)\b", raw)
    )
    if episode:
        result["episode"] = int(episode)
    if scene:
        result["scene"] = scene
    if shot:
        result["shot"] = shot
    if take:
        result["take_number"] = _positive_int_text(take)

    if re.search(r"\bNG\b|废条|不能用|不要用|作废|穿帮废", raw, re.IGNORECASE):
        result["status"] = "ng"
    elif re.search(r"部分可用|前半段|后半段|前面可用|后面可用|只要前|只要后|只用前|只用后", raw):
        result["status"] = "partial"
    elif re.search(r"\bOK\b|可用|过了|这条过|能用|采用|可留", raw, re.IGNORECASE):
        result["status"] = "usable"

    if re.search(r"前半段|前面可用|只要前|只用前", raw):
        result["range_hint"] = "first_half"
    elif re.search(r"后半段|后面可用|只要后|只用后", raw):
        result["range_hint"] = "second_half"
    elif re.search(r"看片再定|看片确认|范围待定|待看片", raw):
        result["range_hint"] = "needs_viewing"

    long_labels = "|".join(sorted((re.escape(label) for label in SHOT_ALIASES), key=len, reverse=True))
    camera_pattern = rf"([A-Za-z][A-Za-z0-9_-]{{0,7}}|A机|B机|C机)\s*(?:机位|机)?\s*({long_labels}|中近|全|远|中|近|特)"
    for camera, label in re.findall(camera_pattern, raw, re.IGNORECASE):
        clean_camera = camera.upper().replace("机", "")
        shot_type = SHOT_ALIASES.get(label) or CAMERA_SHORT_SHOTS.get(label) or "unknown"
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
你是影视后期场记转录器。用户拿到的手写场记可能很粗略；只提取原话明确存在的结构事实，缺失字段必须留空，不要求补齐，不做创意决定。
返回 JSON：episode(int|null), scene(string), shot(string), take_number(int|null),
status(unmarked|usable|partial|ng), note(string),
angle_shots(object: camera -> unknown|wide|full|medium|medium_closeup|closeup|extreme_closeup|big_closeup|insert),
generic_shot(同上枚举或空), range_hint(""|first_half|second_half|needs_viewing)。
允许理解常见粗记法，例如 EP3、S12、12-3-2、B近、同场下一条，但不得把猜测写成事实。
禁止编造秒数、人物身份、Best/Keep/Reject、剧本归集或素材采用结论。
若用户说“前半段/后半段”，只能输出 range_hint，不得猜时间码。
""".strip()
    payload = model.complete_json(
        system=system,
        context={"utterance": _text(text), "previous": previous or {}, "deterministic": base},
        temperature=0.0,
    )
    return _sanitize_model(payload, base) if isinstance(payload, dict) else base
