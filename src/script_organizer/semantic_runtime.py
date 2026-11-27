from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from itertools import chain
from math import isfinite
from pathlib import PurePosixPath
from typing import Any, Iterator
from urllib.parse import parse_qs

from .agent_tools import CachedProjectEvidence, _read
from .assistant_store import _basename
from .editorial_store import EditorialStore
from .device_runtime_settings import load_runtime_settings
from .review_store import ReviewStore
from .semantic_encoder import SemanticEmbeddingConfig, SemanticEncoder
from .semantic_index import ProjectSemanticIndexer, SEMANTIC_SOURCES
from .semantic_search import SemanticSearcher, safe_search_payload
from .transcript import slice_transcript
from .vision_provider import VisionProviderConfig


_INSTALLED = False
_REFRESH_TASKS = {
    "prepare_project",
    "incremental_analyze",
    "transcribe",
    "evidence_extract",
    "auto_resolve",
}
_SHOT_TYPES = {
    "特写": ("extreme_closeup", "big_closeup", "closeup", "close-up", "close_up", "mcu_cu", "特写", "大特写", "极特写"),
    "近景": ("medium_closeup", "closeup", "近景", "中近景"),
    "中景": ("medium", "medium_wide", "中景"),
    "全景": ("wide", "full", "long", "establishing", "全景", "远景", "大远景", "空镜"),
}
SHOT_TYPE_LABELS = {code: label for label, codes in reversed(tuple(_SHOT_TYPES.items())) for code in codes}
_SHOT_CUE = re.compile("|".join(
    re.escape(code) if not code.isascii() else rf"(?<![a-z0-9_.-]){re.escape(code)}(?![a-z0-9_.-])"
    for code in sorted(SHOT_TYPE_LABELS, key=len, reverse=True)
), re.IGNORECASE)
_CAMERA_CUE = re.compile(
    r"(?<![a-z0-9])(?:([abc])\s*机(?:位)?|(aux)(?:\s*机(?:位)?)?(?![a-z0-9_.-]))", re.IGNORECASE,
)
_STATUS_LABELS = {"ng": "NG", "partial": "部分可用", "usable": "可用", "best": "Best", "unmapped": "未归集"}
_STATUS_CUE = re.compile(r"部分可用|未归集|(?<![a-z0-9_.-])(?:NG|Best)(?![a-z0-9_.-])", re.IGNORECASE)
_STATUS_CODES = {"ng": "ng", "部分可用": "partial", "best": "best", "未归集": "unmapped"}
_QUOTED = re.compile(r"""“([^”]+)”|"([^"]+)"|「([^」]+)」|‘([^’]+)’|(?<![a-zA-Z0-9])'([^']+)'""")
_STEWARD_CUES = (
    "进度", "概况", "汇总", "总结", "整体", "缺口", "漏拍", "没拍", "未归集", "待处理",
    "冲突", "演员", "角色", "人物", "选片", "审阅", "任务", "怎么了", "卡住",
)
_QUERY_PREFIX = re.compile(
    r"^(?:小镜|请问|请|帮我|帮忙|给我|找一下|找找|找出|查一下|查查|查找|找|搜一下|搜索|"
    r"还有没有|有没有|哪条|哪个|哪些|那句|这句|一句|某句|项目里|项目中|还有|以及|并且|同时|的)+"
)
_QUERY_SUFFIX = re.compile(r"(?:说的|说过|说了|那句|这句|一句|某句|台词|对白|片段|素材|镜头|画面|一下|吗|呢|吧|的)+$")
_SPOKEN_LINE = re.compile(r"^(?:说过|说了|说的|说|讲)(.+?)(?=(?:那句|这句|的)?(?:对白|台词)$)")
_QUERY_TOKENS = re.compile(r"[^\s，。！？、；：,!?;:（）()\[\]【】]+")


@dataclass(frozen=True)
class SearchIntent:
    cleaned_query: str
    tokens: tuple[str, ...]
    quoted_phrases: tuple[str, ...]
    shot_types: frozenset[str]
    camera: str
    statuses: frozenset[str]
    wants_dialogue: bool
    wants_visual: bool
    wants_steward: bool


def _parse_search_intent(text: str) -> SearchIntent:
    tokens: list[str] = []
    quotes: list[str] = []
    shot_types: set[str] = set()
    statuses: set[str] = set()
    camera = ""
    wants_dialogue = wants_visual = wants_steward = False
    cursor = 0
    for quote in [*_QUOTED.finditer(text), None]:
        unquoted = text[cursor:quote.start() if quote else len(text)]
        wants_dialogue |= any(cue in unquoted for cue in ("台词", "对白", "说", "讲"))
        wants_visual |= any(cue in unquoted for cue in ("画面", "表情", "动作", "景别"))
        wants_steward |= any(cue in unquoted for cue in _STEWARD_CUES)
        for match in _SHOT_CUE.finditer(unquoted):
            shot_types.update(_SHOT_TYPES[SHOT_TYPE_LABELS[match[0].casefold()]])
        for match in _STATUS_CUE.finditer(unquoted):
            statuses.add(_STATUS_CODES[match[0].casefold()])
        match_camera = _CAMERA_CUE.search(unquoted)
        if match_camera and not camera:
            camera = (match_camera[1] or match_camera[2]).upper()
        cleaned = _CAMERA_CUE.sub(" ", _SHOT_CUE.sub(" ", _STATUS_CUE.sub(" ", unquoted)))
        for match in _QUERY_TOKENS.finditer(cleaned):
            token = _QUERY_PREFIX.sub("", match[0])
            spoken = _SPOKEN_LINE.match(token)
            token = _QUERY_SUFFIX.sub("", spoken[1] if spoken else token)
            if token in ("说", "讲"):
                continue
            if token and token not in _STEWARD_CUES:
                tokens.append(token)
        if quote:
            phrase = next(part for part in quote.groups() if part is not None)
            if phrase.strip():
                quotes.append(phrase)
                tokens.append(phrase)
            cursor = quote.end()
    return SearchIntent(
        cleaned_query=" ".join(tokens), tokens=tuple(dict.fromkeys(tokens)), quoted_phrases=tuple(quotes),
        shot_types=frozenset(shot_types), camera=camera, statuses=frozenset(statuses),
        wants_dialogue=wants_dialogue or bool(quotes), wants_visual=wants_visual or bool(shot_types),
        wants_steward=wants_steward or bool(statuses & {"ng", "partial", "unmapped"}),
    )


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _workspace_for_service(service: Any) -> Any:
    workspace = getattr(service, "workspace", None)
    if workspace is not None:
        return workspace
    current = getattr(service, "current", None)
    if current is None:
        raise RuntimeError("请求尚未选择工作区")
    return current.workspace


def _searcher(service: Any, project_id: str, *, read_only: bool = False, device_only: bool = False) -> SemanticSearcher:
    project = service.project(project_id)
    workspace = _workspace_for_service(service)
    encoder = SemanticEncoder(device_only=True) if device_only else None
    return SemanticSearcher(workspace.workspace_id, project_id, project.config, read_only=read_only, encoder=encoder)


def _deterministic_answer(retrieval: dict[str, Any], *, steward: dict[str, Any] | None = None) -> str:
    results = [row for row in _as_list(retrieval.get("results")) if isinstance(row, dict)]
    lines = []
    if steward:
        gaps, slate, editorial, review, identities, tasks = (
            steward[key] for key in ("script_gaps", "slate", "editorial", "review", "identities", "tasks")
        )
        lines.extend([
            "项目总览",
            f"剧本缺口 {gaps['count']} 处。",
            f"场记 NG {slate['ng']} 条，部分可用 {slate['partial']} 条，可用 {slate['usable']} 条。",
            f"归集已完成 {review['mapped']} 组，未归集 {review['unmapped']} 组，已排除 {review['excluded']} 组，人工归集冲突 {review['human_conflicts']} 组。",
            f"选片 Best {editorial['best']} 组，Keep {editorial['keep']} 组，Reject {editorial['reject']} 组，待决定 {editorial['undecided']} 组，待处理团队意见 {editorial['pending_team_opinions']} 组。",
        ])
        for gap in gaps["samples"][:2]:
            location = " · ".join(str(value) for value in (
                f"第{gap['episode']}集" if gap["episode"] else "", gap["scene"] or gap["scene_id"], gap["speaker"],
            ) if value)
            detail = " · ".join(filter(None, (location, gap["text"])))
            if detail:
                lines.append(f"缺口示例 · {detail}")
        for entry in slate["highlights"][:3]:
            label = _STATUS_LABELS.get(entry["status"], "场记")
            detail = " · ".join(filter(None, (_take_label(entry, entry["group_id"], ""), entry["note"])))
            if detail:
                lines.append(f"{label} · {detail}")
        names = "、".join(
            " · ".join(filter(None, dict.fromkeys((row["role_name"], row["label"]))))
            for row in identities["confirmed"][:8]
        )
        lines.append(f"已确认身份：{names or '暂无'}。待确认 {identities['unconfirmed_count']} 项。")
        lines.append(f"排队或运行中 {len(tasks['active'])} 项，近期失败 {len(tasks['failed'])} 项。")
        for task in tasks["active"][:2] + tasks["failed"][:2]:
            label = {"queued": "排队", "running": "运行中", "failed": "失败"}[task["status"]]
            detail = " · ".join(task[key] for key in ("type", "stage", "message") if task.get(key))
            lines.append(f"{label} · {detail}" if detail else label)
    if not results:
        return "\n".join(lines) or "没有找到相关的画面、对白或场记证据。"
    lines.append(f"找到 {len(results)} 条相关制作证据")
    for index, row in enumerate(results[:6], start=1):
        metadata = _as_dict(row.get("metadata"))
        camera = metadata.get("camera")
        snippet = str(row.get("snippet", "") or "").strip()
        where = [
            row.get("source_label") or "素材", metadata.get("take_label") or _take_label({}, row.get("group_id"), ""),
            f"{camera} 机" if camera else "", metadata.get("shot_type_label"),
        ]
        if metadata.get("time_basis") in ("take_relative", "source") and row.get("end", 0) > row.get("start", 0):
            where.append(f"{row['start']:.3f}–{row['end']:.3f} 秒")
        lines.append(f"{index}. {' · '.join(map(str, filter(None, where)))}：{snippet[:260]}")
    return "\n".join(lines)


def _suggest_actions(
    intent: SearchIntent, evidence: CachedProjectEvidence, steward: dict[str, Any], *,
    has_results: bool, strong_visual: bool, vision_enabled: bool,
) -> list[dict[str, Any]]:
    coverage = steward["index_coverage"]
    actions = []
    if intent.wants_dialogue and coverage["total_clips"] and not coverage["transcribed_clips"]:
        actions.append({
            "action": "submit_task", "task_type": "transcribe", "label": "启动语音转写",
            "description": "项目尚未生成实拍对白转写，转写完成后即可按台词精确检索到秒。", "targets": {},
        })
    if intent.wants_visual and coverage["total_groups"] and not coverage["visual_indexed_groups"] and not strong_visual:
        if vision_enabled:
            actions.append({
                "action": "submit_task", "task_type": "evidence_extract", "label": "提取画面与景别证据",
                "description": "为镜头生成景别与画面分析后，即可直接搜特写、动作和表情。",
                "targets": {"group_ids": list(evidence.groups)[:12]},
            })
        else:
            actions.append({
                "action": "open_settings", "label": "前往设置配置视觉模型",
                "description": "配置视觉模型后，即可自动识别特写/近景、人物动作与画面内容。",
            })
    if not has_results and not coverage["semantic_documents"] and (coverage["transcribed_clips"] or steward["slate"]["with_notes"]):
        actions.append({
            "action": "submit_task", "task_type": "semantic_index", "label": "刷新语义索引",
            "description": "把已有转写与场记写入本地检索索引，加快后续提问检索。", "targets": {},
        })
    return actions


def _append_filename_matches(project: Any, payload: dict[str, Any], text: str, limit: int) -> None:
    """Search existing clip names even when no semantic index has been built."""
    results = payload["results"]
    matched_clips = {row.get("clip_id") for row in results}
    needle = text.casefold()
    for clip in project.index.get("clips", []):
        if len(results) >= limit:
            break
        if not isinstance(clip, dict):
            continue
        clip_id = clip.get("clip_id")
        name = PurePosixPath(str(clip.get("name") or "").replace(chr(92), "/")).name
        if not clip_id or clip_id in matched_clips or not name or needle not in name.casefold():
            continue
        results.append({
            "document_id": f"file:{clip_id}", "group_id": "", "clip_id": clip_id,
            "media_id": str(clip.get("media_id") or ""), "source": "file", "source_label": "文件名",
            "score": 0.0, "keyword_rank": None, "vector_rank": None, "vector_similarity": None,
            "start": 0.0, "end": 0.0, "snippet": name,
            "metadata": {"file_name": name, "camera": str(clip.get("camera") or "")},
        })
        matched_clips.add(clip_id)
    payload["summary"]["returned"] = len(results)


def _text_match(value: object, terms: tuple[str, ...]) -> bool:
    haystack = str(value or "").casefold()
    return any(term.strip().casefold() in haystack for term in terms if term.strip())


def _file_name(clip: dict[str, Any]) -> str:
    return _basename(clip.get("file_name") or clip.get("name") or clip.get("display_name"))


def _shot_type(value: object) -> str:
    return str(value or "").strip().casefold()


def _angle_facts(
    evidence: CachedProjectEvidence, group_id: str, clip_id: str, slate: dict[str, Any],
) -> tuple[str, str]:
    automatic = _as_dict(_as_dict(evidence.shots.get(group_id, {}).get("angles")).get(clip_id))
    human = _as_dict(_as_dict(slate.get("angles")).get(clip_id))
    shot = _shot_type(human.get("shot_type"))
    if shot in ("", "unknown"):
        shot = _shot_type(automatic.get("shot_type"))
    snippet = " · ".join(dict.fromkeys(
        str(value) for value in (
            SHOT_TYPE_LABELS.get(shot, shot), human.get("note"), automatic.get("summary"),
            automatic.get("description"), automatic.get("coverage_role"),
        ) if value and value != "unknown"
    ))
    return (shot if shot != "unknown" else ""), snippet


def _take_label(slate: dict[str, Any], group_id: str, file_name: str) -> str:
    number = slate.get("take_number")
    scene, shot = str(slate.get("scene") or ""), str(slate.get("shot") or "")
    location = "".join(
        value if value.endswith(suffix) else value + suffix
        for value, suffix in ((scene, "场"), (shot, "镜")) if value
    )
    return " · ".join(
        value for value in (f"Take {number}" if number else "", location) if value
    ) or file_name or (f"Take {group_id}" if group_id else "")


def _evidence_row(
    source: str, key: str, snippet: str, *, group_id: str = "", clip: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None, start: float = 0.0, end: float = 0.0,
) -> dict[str, Any]:
    clip = clip or {}
    return {
        "document_id": f"{source}:{key}", "group_id": group_id,
        "clip_id": clip.get("clip_id") or "", "media_id": clip.get("media_id") or "",
        "source": source, "source_label": _RESULT_LABELS[source], "snippet": snippet,
        "start": start, "end": end, "metadata": metadata or {}, "score": 0.0,
        "keyword_rank": None, "vector_rank": None, "vector_similarity": None,
    }


_RESULT_LABELS = {"file": "文件名", "visual": "画面", "speech": "对白", "slate": "场记", "script": "剧本"}
_SOURCE_ORDER = {source: index for index, source in enumerate(("file", "slate", "script", "visual", "speech"))}


def _group_statuses(evidence: CachedProjectEvidence, group_id: str, slate_status: str) -> set[str]:
    statuses = {slate_status}
    if evidence.editorial_states.get(group_id) == "best":
        statuses.add("best")
    if group_id in evidence.unmapped:
        statuses.add("unmapped")
    return statuses


def _cached_speech(
    evidence: CachedProjectEvidence, intent: SearchIntent, group_id: str, clip: dict[str, Any],
) -> Iterator[dict[str, Any]]:
    if not intent.tokens:
        return
    transcript = evidence.transcript_for(clip)
    if transcript is None:
        return
    try:
        start = float(clip.get("source_start") or 0)
        end = float(clip["source_end"]) if clip.get("source_end") is not None else None
    except (TypeError, ValueError, OverflowError):
        return
    transcript = slice_transcript(transcript, start, end)
    terms = intent.quoted_phrases or intent.tokens
    key = f"{group_id}:{clip['clip_id']}"
    for index, segment in enumerate(transcript.segments):
        if _text_match(segment.text, terms) and isfinite(segment.start) and isfinite(segment.end):
            yield _evidence_row(
                "speech", f"{key}:{index}", segment.text, group_id=group_id, clip=clip,
                start=segment.start, end=segment.end, metadata={"time_basis": "take_relative"},
            )
    if not transcript.segments and _text_match(transcript.text, terms):
        yield _evidence_row("speech", key, transcript.text, group_id=group_id, clip=clip)


def _direct_matches(evidence: CachedProjectEvidence, intent: SearchIntent) -> Iterator[dict[str, Any]]:
    grouped_clips = {clip_id for _, clip_id in evidence.members}
    occurrences = dict(evidence.members)
    occurrences.update({("", clip_id): row for clip_id, row in evidence.clips.items() if clip_id not in grouped_clips})
    for (group_id, clip_id), clip in occurrences.items():
        camera = str(clip.get("camera") or "").upper()
        if intent.camera and intent.camera != camera:
            continue
        key = f"{group_id}:{clip_id}"
        slate = _as_dict(evidence.slate_entries.get(group_id))
        shot, visual = _angle_facts(evidence, group_id, clip_id, slate)
        file_name = _file_name(clip)
        statuses = _group_statuses(evidence, group_id, str(slate.get("status") or ""))
        if file_name and _text_match(file_name, intent.tokens):
            yield _evidence_row("file", key, file_name, group_id=group_id, clip=clip)
        if (
            shot in intent.shot_types
            or (visual and _text_match(visual, intent.tokens))
            or (not intent.shot_types and bool(intent.statuses & statuses & {"best", "unmapped"}))
            or (intent.camera and not intent.shot_types and not (intent.tokens or intent.statuses))
        ):
            status_text = " · ".join(_STATUS_LABELS[status] for status in ("best", "unmapped") if status in statuses & intent.statuses)
            yield _evidence_row(
                "visual", key, visual or status_text or f"{camera} 机画面", group_id=group_id, clip=clip,
                metadata={"shot_type": shot},
            )
        yield from _cached_speech(evidence, intent, group_id, clip)

    if not intent.camera:
        for group_id, shot in evidence.shots.items():
            summary = str(shot.get("summary") or "")
            if _text_match(summary, intent.tokens):
                yield _evidence_row("visual", group_id, summary, group_id=group_id)

    for record_id, slate in evidence.slate_records.items():
        group_id = slate.get("source_group_id") or ""
        status = slate.get("status") or ""
        snippet = " · ".join(str(slate[key]) for key in ("scene", "shot", "note") if slate.get(key))
        if status in intent.statuses:
            label = _STATUS_LABELS[status]
            snippet = f"{label} · {snippet}" if snippet else label
        attachments = _as_list(slate.get("attachments"))
        selected = {}
        for attachment in attachments:
            clip_id = attachment.get("clip_id") or ""
            clip = {
                **attachment, **evidence.clips.get(clip_id, {}),
                **evidence.members.get((group_id, clip_id), {}),
            }
            camera = str(clip.get("camera") or "").upper()
            if intent.camera and camera != intent.camera:
                continue
            if not selected or clip_id == slate.get("preferred_clip_id"):
                selected = clip
            shot = _shot_type(attachment.get("shot_type"))
            note = str(attachment.get("note") or "")
            if shot in intent.shot_types or _text_match(note, intent.tokens):
                yield _evidence_row(
                    "visual", f"{group_id}:{clip_id or clip.get('media_id', '')}", " · ".join(
                        part for part in (SHOT_TYPE_LABELS.get(shot, shot), note) if part and part != "unknown"
                    ),
                    group_id=group_id, clip=clip, metadata={
                        "file_name": _file_name(clip), "camera": camera, "shot_type": shot if shot != "unknown" else "",
                        "record_id": record_id, "slate_status": status,
                    },
                )
        attached = bool(selected)
        if not attached and intent.camera:
            group = evidence.groups.get(group_id, {})
            selected = next((
                evidence.members[group_id, member["clip_id"]]
                for member in _as_list(group.get("members"))
                if isinstance(member, dict) and (group_id, member.get("clip_id")) in evidence.members
                and str(member.get("camera") or "").upper() == intent.camera
            ), {})
        if (selected or not intent.camera) and (_text_match(snippet, intent.tokens) or status in intent.statuses):
            usable = _as_dict(slate.get("usable_range"))
            metadata = {"record_id": record_id, "slate_status": status, "camera": selected.get("camera"),
                        "file_name": _file_name(selected)}
            # A group annotation can locate a camera in that Take, while a
            # source-relative range requires an explicitly attached source.
            if usable and attached:
                metadata["time_basis"] = "source"
            yield _evidence_row(
                "slate", record_id, snippet, group_id=group_id, clip=selected, metadata=metadata,
                start=usable.get("start", 0.0) if attached else 0.0,
                end=usable.get("end", 0.0) if attached else 0.0,
            )

    for segment_id, segment in evidence.segments.items():
        speaker, text = segment.get("speaker"), segment.get("text") or ""
        if _text_match(text, intent.tokens) or _text_match(speaker, intent.tokens):
            snippet = f"{speaker}：{text}" if speaker else str(text)
            yield _evidence_row("script", segment_id, snippet, metadata={"segment_id": segment_id})


def _enrich_result(evidence: CachedProjectEvidence, row: dict[str, Any]) -> dict[str, Any]:
    group_id, clip_id = row.get("group_id") or "", row.get("clip_id") or ""
    metadata = _as_dict(row.get("metadata"))
    clip = evidence.members.get((group_id, clip_id), evidence.clips.get(clip_id, {}))
    entry = _as_dict(evidence.slate_entries.get(group_id))
    slate = _as_dict(evidence.slate_records.get(metadata.get("record_id"))) or entry
    group_visual = row.get("source") == "visual" and metadata.get("member_count", 0) not in (0, 1)
    shot, _ = _angle_facts(evidence, group_id, clip_id, entry) if clip_id and not group_visual else ("", "")
    shot = _shot_type(metadata.get("shot_type") or shot)
    file_name = _file_name(clip) or _basename(metadata.get("file_name"))
    camera = "" if group_visual else str(clip.get("camera") or metadata.get("camera") or "").upper()
    slate_status = slate.get("status") or metadata.get("slate_status") or metadata.get("status")
    extra = {
        "file_name": file_name,
        "camera": camera,
        "shot_type": shot if shot != "unknown" else "",
        "shot_type_label": SHOT_TYPE_LABELS.get(shot, ""),
        "take_label": _take_label(slate, group_id, file_name) if group_id or file_name or slate else "",
        "slate_status": slate_status if slate_status in ("ng", "partial", "usable") else "",
    }
    if row.get("source") == "slate" and row.get("end", 0) > row.get("start", 0) and (clip_id or row.get("media_id")):
        extra["time_basis"] = "source"
    snippet = " ".join(str(row.get("snippet") or "").split())
    return {
        **row, "media_id": row.get("media_id") or clip.get("media_id") or "",
        "snippet": snippet, "metadata": {**metadata, **extra},
    }


def _result_key(row: dict[str, Any]) -> tuple[Any, ...]:
    source, group_id, clip_id = row["source"], row.get("group_id"), row.get("clip_id") or row.get("media_id")
    if source == "speech":
        return source, group_id, clip_id, round(row["start"], 3), round(row["end"], 3)
    if source == "slate":
        return source, row["metadata"].get("record_id") or row.get("document_id")
    if source == "visual" and row["metadata"].get("member_count", 0) not in (0, 1):
        return source, group_id, None
    return source, group_id, clip_id or row.get("document_id")


def _fuse_project_results(
    evidence: CachedProjectEvidence, intent: SearchIntent, indexed: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], bool]:
    rows: dict[tuple[Any, ...], tuple[tuple[Any, ...], dict[str, Any]]] = {}
    strong_visual = False
    for raw in chain(indexed, _direct_matches(evidence, intent)):
        row = _enrich_result(evidence, raw)
        source, metadata = row["source"], row["metadata"]
        camera_match = bool(intent.camera and intent.camera == metadata.get("camera"))
        if intent.camera and not camera_match and source != "script":
            continue
        phrase_match = _text_match(row["snippet"], intent.quoted_phrases)
        if intent.quoted_phrases and source == "speech" and not phrase_match:
            continue
        keyword_match = _text_match(row["snippet"], intent.tokens)
        shot_match = metadata.get("shot_type") in intent.shot_types
        status_match = bool(intent.statuses & _group_statuses(
            evidence, row.get("group_id") or "", str(metadata.get("slate_status") or ""),
        ))
        if source == "visual" and (shot_match or (not intent.shot_types and keyword_match)):
            strong_visual = True
        dialogue_match = source == "speech" and keyword_match
        constraints = sum((camera_match, shot_match, status_match, keyword_match))
        rank = (
            constraints, dialogue_match, phrase_match, float(row.get("score") or 0),
            -_SOURCE_ORDER.get(source, len(_SOURCE_ORDER)),
        )
        key = _result_key(row)
        previous = rows.get(key)
        if previous is None or rank >= previous[0]:
            rows[key] = rank, row
        elif source == "speech" and metadata.get("time_basis") == "take_relative" and not raw.get("score"):
            # Prefer exact cached segment times while retaining the semantic rank.
            rows[key] = previous[0], {**previous[1], "start": row["start"], "end": row["end"],
                                      "metadata": {**previous[1]["metadata"], **metadata}}
    ordered = sorted(rows.values(), key=lambda item: item[0], reverse=True)
    return [row for _, row in ordered[:12]], strong_visual


def _selected_take(self: Any, group_id: str) -> dict[str, Any]:
    try:
        take = self.tools.inspect_take(group_id)
    except KeyError:
        return {}
    candidate_fields = (
        "candidate_id", "script_segment_id", "script_segment_ids", "confidence", "method",
        "total_score", "margin", "evidence", "transcript_clip_id", "transcript_text",
    )
    candidates = [row for row in _as_list(take.get("candidates")) if isinstance(row, dict)]
    audit = _as_dict(take.get("audit"))
    review = ReviewStore(self.config.output_dir / "review.json").load()
    editorial = EditorialStore(self.config.output_dir).load()
    return {
        "group_id": group_id,
        "cameras": take.get("cameras", []),
        "duration": take.get("duration"),
        "candidates": [{key: row[key] for key in candidate_fields if key in row} for row in candidates[:3]],
        "automatic": take.get("automatic", {}),
        "audit": {
            **({"shot_intelligence": audit.get("shot_intelligence", {})} if audit.get("visual_current") else {}),
            **({"judge": audit.get("judge", {}), "issues": audit.get("issues", [])} if audit.get("mapping_current") else {}),
        },
        "review": {
            "placement": _as_dict(review.get("placements")).get(group_id, {}),
            "exclusion": _as_dict(review.get("exclusions")).get(group_id, {}),
        },
        "editorial_decision": _as_dict(editorial.get("decisions")).get(f"group|{group_id}", {}),
    }


def answer_project_question(self: Any, message: str, *, context: dict | None = None) -> dict[str, Any]:
    text = self.store.sanitize(str(message or "").strip())[:3000]
    if not text:
        raise ValueError("消息不能为空")
    context = context or {}
    selection = _as_dict(context.get("selection"))
    facts = _as_dict(context.get("facts"))
    diagnosis = self.store.sanitize_diagnosis(context.get("diagnosis"))
    receipt = self.store.sanitize({
        key: context[key] for key in ("project_id", "page", "label", "selection", "analysis_revision") if key in context
    })
    project_question = not selection or "项目" in text or "工程" in text
    diagnostics_question = bool(diagnosis) and (
        (project_question and any(
            term in text for term in ("同步", "交付", "能交", "不能交", "卡", "取消", "停在", "阻塞", "重连", "目录")
        ))
        or (context.get("page") in ("sync-task", "sync-inspect", "sync-delivery") and any(
            term in text for term in ("能交", "不能交", "交付", "同步好了", "卡", "取消", "失败", "阻塞", "重连")
        ))
    )
    history = self.store.conversation_history()
    self.store.append_message("user", text, source="user", context=receipt)
    retrieval = {"contract": "semantic_search.v1", "query": text, "mode": "unavailable",
                 "results": [], "summary": {}, "semantics": {"read_only": True}}
    answer_mode = "deterministic"
    attempted = False
    suggested_scope_switch = False
    clean_actions: list[dict[str, Any]] = []
    steward = None
    diagnosis_summary = diagnosis.get("summary") or "请查看同步任务的最近记录。"
    if diagnostics_question:
        answer = diagnosis_summary
        answer_mode = "diagnosis"
    else:
        intent = _parse_search_intent(text) if not selection else None
        query = (intent.cleaned_query or text) if intent else text
        try:
            searcher = SemanticSearcher(self.workspace_id, self.project_id, self.config, read_only=True)
            retrieval = safe_search_payload(searcher.search(
                query, limit=24 if intent else 14, refresh=False, selection=selection,
                allow_query_embedding=bool(self.language.enabled and not selection),
            ))
        except (OSError, ValueError, RuntimeError, sqlite3.Error):
            pass
        if selection:
            group = selection.get("group_id")
            notes = self._supervisor_notes(group=group) if group else []
            model_facts = {"selected_material": facts, "selection": selection, "take_slate": notes}
            if group:
                model_facts["selected_take"] = _selected_take(self, group)
            suggested_scope_switch = not retrieval["results"] and any(
                cue in text for cue in ("哪条", "哪个", "找", "搜索", "还有没有", "所有", "全部", "其他", "项目里")
            )
        else:
            evidence = CachedProjectEvidence(self.config)
            rows, strong_visual = _fuse_project_results(evidence, intent, retrieval["results"])
            for row in rows:
                row["metadata"] = self.store.evidence_metadata(row["metadata"])
                row["snippet"] = self.store.sanitize(row["snippet"])[:320]
            retrieval["results"] = rows
            retrieval["summary"]["returned"] = len(rows)
            steward = self.tools.steward_overview(evidence=evidence)
            clean_actions = self.store.sanitize_actions(_suggest_actions(
                intent, evidence, steward, has_results=bool(rows), strong_visual=strong_visual,
                vision_enabled=self.models.vision.enabled,
            ))
            notes = self._supervisor_notes(limit=20, entries=evidence.slate_entries) if self.language.enabled else []
            model_facts = {
                "project": steward["project"], "project_steward": steward,
                "attention": self.tools.list_attention_groups(limit=12) if self.language.enabled else [],
                "script_supervisor": notes,
                "assistant_summary": self.store.load().get("summary", ""),
            }
        retrieval = self.store.sanitize(retrieval)
        answer = ""
        has_evidence = (
            retrieval["results"] or notes or facts.get("script_text") or model_facts.get("attention")
            or model_facts.get("selected_take") or (intent and intent.wants_steward)
        )
        attempted = bool(self.language.enabled and (not context or has_evidence or history))
        if attempted:
            answer = self._complete_answer(
                system=(
                    "你是小镜，服务短剧后期制作。按提问时的选区、已记录的同步状态、画面、实际对白和人工场记回答。"
                    "缺少证据就说明缺什么。剧本正文与实拍对白分开。不要推测说话人、精确可用时段或画面错帧数。"
                    "整组 Take 的场记或画面只能按整组引用。场记和候选不能升级成最终归属或 Best/Reject。不要声称执行了未发生的动作。"
                    "项目进度以已记录的项目总览为准。引用检索结果时，注明已知的机位、景别和时间范围。"
                    '输出严格JSON：{"answer":"中文回答"}。'
                ),
                context={"question": text, "conversation_history": history, "semantic_retrieval": retrieval,
                         **model_facts, "delivery_status": diagnosis},
                temperature=0.15,
            )
            if answer:
                answer_mode = "llm"
        if not answer:
            if selection:
                lines = [str(receipt.get("label") or "当前选区")]
                if facts.get("position_note"):
                    lines.append(facts["position_note"])
                if facts.get("source_timecode"):
                    lines.append(f"源起始时间码 {facts['source_timecode']}。")
                media_state = {"verified": "本机素材已验证。", "missing": "本机已登记的素材缺失。", "unknown": "本机素材绑定待核对。"}
                if facts.get("media_state") in media_state:
                    lines.append(media_state[facts["media_state"]])
                if facts.get("script_text"):
                    lines.append(f"剧本原文：{facts['script_text']}")
                if notes and notes[0].get("note"):
                    lines.append(f"人工场记：{notes[0]['note']}")
                if retrieval["results"]:
                    lines.append(_deterministic_answer(retrieval))
                else:
                    lines.append("当前选区没有可引用的画面、转写或场记索引。")
                answer = "\n".join(lines)
            elif intent and (intent.wants_steward or retrieval["results"]):
                answer = _deterministic_answer(retrieval, steward=steward)
            elif diagnosis:
                answer = diagnosis_summary + "\n当前问题没有检索到相关的画面、对白或场记证据。"
            else:
                answer = _deterministic_answer(retrieval)
    included_diagnosis = diagnosis if diagnosis and (not selection or diagnostics_question) else None
    answer = self.store.sanitize(answer)
    saved = self.store.append_message(
        "assistant", answer, source=self.models.assistant.source, context=receipt,
        evidence=retrieval["results"], diagnosis=included_diagnosis, answer_mode=answer_mode,
        suggested_actions=clean_actions,
    )
    return {
        "answer": answer, "assistant": saved, "retrieval": retrieval,
        "answer_mode": answer_mode, "model_info": self._answer_model_info(attempted=attempted),
        "suggested_actions": clean_actions,
        **({"project_steward": steward} if steward is not None else {}),
        **({"context": receipt} if receipt else {}),
        **({"diagnosis": included_diagnosis} if included_diagnosis else {}),
        **({"suggested_scope_switch": True} if suggested_scope_switch else {}),
    }


def install_semantic_runtime() -> None:
    """Install read-only semantic retrieval above existing production evidence.

    The runtime adds no review/editorial/automation authority. It indexes only
    already-produced VLM descriptions, cached ASR and human slate facts, then
    grounds assistant answers and read-only API search in that evidence.
    """

    global _INSTALLED
    if _INSTALLED:
        return

    from . import model_registry, tasks as tasks_module, web_server
    from .agent_tools import AgentToolRegistry
    from .resource_scheduler import ResourceCancelled

    original_make_handler = web_server.make_handler
    original_capabilities = web_server.WorkspaceService.capabilities
    original_update = tasks_module.TaskManager._update
    original_task_run = tasks_module.TaskManager._run
    original_models_public = model_registry.ModelRegistry.public

    # Semantic refresh is device-local and rebuildable, but it is still real
    # background work. Register it as a durable task so Status Center is the
    # single place users can observe, cancel and retry that work.
    tasks_module.TASK_TYPES.add("semantic_index")

    def models_public_with_semantic(registry: Any) -> dict[str, Any]:
        payload = original_models_public(registry)
        payload["semantic_embedding"] = SemanticEmbeddingConfig.from_env().public()
        return payload

    def search_project_semantics(
        tools: AgentToolRegistry,
        query: str,
        *,
        limit: int = 12,
        sources: list[str] | None = None,
    ) -> dict[str, Any]:
        searcher = SemanticSearcher(
            tools.workspace_id,
            tools.project_id,
            tools.config,
        )
        return safe_search_payload(
            searcher.search(query, limit=limit, sources=sources, refresh=False)
        )

    def capabilities_with_semantic(service: Any, agent: dict[str, Any]) -> dict[str, Any]:
        payload = original_capabilities(service, agent)
        embedding = SemanticEmbeddingConfig.from_env()
        from .local_embedding import local_embedding_available

        payload["semantic_search"] = {
            "contract": "semantic_search.v1",
            "read": True,
            "sources": ["visual", "speech", "slate"],
            "keyword_fallback": True,
            "vector_enabled": embedding.enabled or local_embedding_available(),
            "device_local_index": True,
            "editorial_authority": False,
            "visual_providers": {
                "local_vision": {
                    "configured": VisionProviderConfig.from_env().is_local,
                    "evidence_only": True,
                    "requires_explicit_task": True,
                }
            },
        }
        return payload

    def run_with_semantic(manager: Any, project_id: str, task_id: str) -> None:
        config = manager.project_loader(project_id)
        try:
            task = manager._task(manager._load(config), task_id)
        except Exception:
            return original_task_run(manager, project_id, task_id)
        if str(task.get("type", "") or "") != "semantic_index":
            return original_task_run(manager, project_id, task_id)

        workspace_id = str(getattr(manager, "workspace_id", "") or "")
        if not workspace_id:
            manager._update(
                config,
                task_id,
                status="failed",
                stage="failed",
                error="语义索引缺少 workspace_id",
                message="语义索引失败",
            )
            return

        targets = _as_dict(task.get("targets"))
        raw_groups = targets.get("group_ids", [])
        group_ids = [str(value) for value in raw_groups if str(value)] if isinstance(raw_groups, list) else []
        raw_sources = targets.get("sources", [])
        requested_sources = [str(value) for value in raw_sources if str(value)] if isinstance(raw_sources, list) else []
        sources = sorted(set(requested_sources) or SEMANTIC_SOURCES)
        unknown = set(sources) - SEMANTIC_SOURCES
        if unknown:
            manager._update(
                config,
                task_id,
                status="failed",
                stage="failed",
                error="unknown semantic sources: " + ", ".join(sorted(unknown)),
                message="语义索引失败",
            )
            return

        try:
            manager._update(config, task_id, status="running", stage="starting", message="语义索引开始")
            if manager._cancel_requested(config, task_id):
                manager._update(config, task_id, status="cancelled", stage="cancelled", message="语义索引已取消")
                return

            reports: dict[str, Any] = {}
            latest: dict[str, Any] = {}
            total = len(sources)
            with manager._resource(config, task, "embedding", "semantic_index", "语义索引"):
                for index, source in enumerate(sources, start=1):
                    if manager._cancel_requested(config, task_id):
                        manager._update(config, task_id, status="cancelled", stage="cancelled", message="语义索引已取消")
                        return
                    manager._update(
                        config,
                        task_id,
                        stage="semantic_index",
                        progress={"done": index - 1, "total": total},
                        message=f"正在更新{source}证据索引 {index}/{total}",
                    )
                    latest = ProjectSemanticIndexer(workspace_id, project_id, config).refresh(
                        group_ids=group_ids or None,
                        sources=[source],
                    )
                    reports.update(_as_dict(latest.get("sources")))
                    manager._update(
                        config,
                        task_id,
                        progress={"done": index, "total": total},
                        message=f"语义索引 {index}/{total}",
                    )
            result = {
                **latest,
                "contract": "semantic_refresh_task.v1",
                "sources": reports,
            }
            manager._update(
                config,
                task_id,
                status="completed",
                stage="completed",
                progress={"done": total, "total": total},
                result=result,
                message="语义索引已更新",
            )
        except ResourceCancelled:
            manager._update(config, task_id, status="cancelled", stage="cancelled", message="语义索引已取消")
        except Exception as error:
            manager._update(
                config,
                task_id,
                status="failed",
                stage="failed",
                error=str(error),
                message="语义索引失败",
            )

    def update_with_semantic(
        manager: Any,
        config: Any,
        task_id: str,
        status: str | None = None,
        stage: str | None = None,
        progress: dict[str, Any] | None = None,
        result: dict[str, Any] | None = None,
        error: str = "",
        message: str = "",
    ) -> None:
        original_update(
            manager,
            config,
            task_id,
            status=status,
            stage=stage,
            progress=progress,
            result=result,
            error=error,
            message=message,
        )
        if status != "completed":
            return
        try:
            task = manager._task(manager._load(config), task_id)
        except Exception:
            return
        task_type = str(task.get("type", "") or "")
        if task_type not in _REFRESH_TASKS:
            return
        project_id = str(task.get("project_id", "") or "")
        workspace_id = str(getattr(manager, "workspace_id", "") or "")
        if not project_id or not workspace_id:
            return
        targets = _as_dict(task.get("targets"))
        raw_groups = task.get("affected_group_ids") or targets.get("group_ids", [])
        group_ids = [str(value) for value in raw_groups if str(value)] if isinstance(raw_groups, list) else []
        try:
            manager.submit(
                project_id,
                "semantic_index",
                targets={"group_ids": group_ids},
                idempotency_key=f"semantic-refresh:{task_id}",
                actor="system",
            )
        except Exception:
            # Derived semantic refresh must never fail the source production task.
            # Read paths remain side-effect free; the next background refresh can retry.
            return
        if task_type in {"prepare_project", "incremental_analyze", "transcribe"} and load_runtime_settings().get("local_vision_enabled"):
            try:
                manager.submit(
                    project_id, "evidence_extract", targets={"local_visual": True, "group_ids": group_ids},
                    idempotency_key=f"local-visual:{task_id}", actor="system",
                )
            except Exception:
                # Local visual evidence can be built later without invalidating the analysis.
                pass

    def make_handler_with_semantic(service: Any, web_root):
        BaseHandler = original_make_handler(service, web_root)

        class Handler(BaseHandler):
            @staticmethod
            def _search_parameters(parsed: Any) -> tuple[str, int, list[str] | None]:
                query = parse_qs(str(parsed.query or ""), keep_blank_values=False)
                text = str((query.get("q") or [""])[0] or "").strip()
                try:
                    limit = max(1, min(60, int((query.get("limit") or ["16"])[0] or 16)))
                except ValueError:
                    limit = 16
                raw_sources = str((query.get("sources") or [""])[0] or "")
                sources = [value for value in raw_sources.split(",") if value] or None
                return text, limit, sources

            def _app_post(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) in (5, 6)
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "semantic-search"
                    and parts[5:] in ([], ["local"])
                ):
                    # 自动查询走专用本机入口，旧 Host 不会把它当作远程查询。
                    self._local_only()
                    project_id = parts[3]
                    body = web_server._body(self)
                    text = str(body.get("q", "") or "").strip()
                    if not text:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "语义搜索内容不能为空")
                    try:
                        limit = max(1, min(60, int(body.get("limit", 16) or 16)))
                    except (TypeError, ValueError):
                        limit = 16
                    raw_sources = body.get("sources")
                    sources = [str(value) for value in raw_sources if str(value)] if isinstance(raw_sources, list) else None
                    raw_groups = body.get("group_ids")
                    group_ids = [value for value in raw_groups if isinstance(value, str) and value] if isinstance(raw_groups, list) else None
                    payload = _searcher(service, project_id, read_only=True, device_only=len(parts) == 6).search(
                        text,
                        limit=limit,
                        sources=sources,
                        group_ids=group_ids,
                        refresh=False,
                    )
                    self._send_json(payload)
                    return
                return super()._app_post(parsed)

            def _app_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 5
                    and parts[:3] == ["api", "v1", "projects"]
                    and parts[4] == "semantic-search"
                ):
                    self._local_only()
                    project_id = parts[3]
                    text, limit, sources = self._search_parameters(parsed)
                    if not text:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "语义搜索内容不能为空")
                    payload = _searcher(service, project_id, read_only=True).search(
                        text,
                        limit=limit,
                        sources=sources,
                        refresh=False,
                        allow_query_embedding=False,
                    )
                    if not sources:
                        _append_filename_matches(service.project(project_id), payload, text, limit)
                    self._send_json(payload)
                    return
                return super()._app_get(parsed)

            def _agent_get(self, parsed):
                parts = web_server._parts(parsed.path)
                if (
                    len(parts) == 6
                    and parts[:4] == ["api", "agent", "v1", "projects"]
                    and parts[5] == "semantic-search"
                ):
                    project_id = parts[4]
                    agent = self._agent("read", project_id)
                    text, limit, sources = self._search_parameters(parsed)
                    if not text:
                        raise web_server.ApiError(web_server.HTTPStatus.BAD_REQUEST, "语义搜索内容不能为空")
                    payload = safe_search_payload(
                        _searcher(service, project_id, read_only=True).search(
                            text,
                            limit=limit,
                            sources=sources,
                            refresh=False,
                            allow_query_embedding=False,
                        )
                    )
                    service.tokens.audit(agent, "read:semantic-search", project_id)
                    self._send_json(payload)
                    return
                return super()._agent_get(parsed)

        return Handler

    model_registry.ModelRegistry.public = models_public_with_semantic
    AgentToolRegistry.search_project_semantics = search_project_semantics
    web_server.WorkspaceService.capabilities = capabilities_with_semantic
    web_server.make_handler = make_handler_with_semantic
    tasks_module.TaskManager._run = run_with_semantic
    tasks_module.TaskManager._update = update_with_semantic
    _INSTALLED = True
