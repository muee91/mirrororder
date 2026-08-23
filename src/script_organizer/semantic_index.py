from __future__ import annotations

import hashlib
import json
from fractions import Fraction
from pathlib import Path
from typing import Any, Iterable, Sequence

from .config import ProjectConfig
from .media_identity import DeviceMediaStore
from .models import Clip
from .script_supervisor_store import ScriptSupervisorStore
from .semantic_encoder import SemanticEncoder
from .semantic_store import SemanticStore
from .transcript import TranscriptStore, slice_transcript
from .workspace_db import WorkspaceDatabase


SEMANTIC_SOURCES = {"visual", "speech", "slate"}


def _read(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _clean_text(value: object, limit: int = 4000) -> str:
    return " ".join(str(value or "").replace("\x00", " ").split())[:limit]


def _document_id(project_id: str, source: str, key: str) -> str:
    digest = hashlib.sha1(f"{project_id}|{source}|{key}".encode("utf-8")).hexdigest()[:24]
    return f"sem_{source}_{digest}"


def _fingerprint(text: str, metadata: dict[str, Any]) -> str:
    raw = json.dumps(
        {"text": text, "metadata": metadata},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _clip_for_member(member: dict[str, Any], media_path: str) -> Clip:
    source_start = Fraction(str(member.get("source_start", 0) or 0))
    source_end_raw = member.get("source_end")
    source_end = Fraction(str(source_end_raw)) if source_end_raw is not None else None
    duration = Fraction(str(member.get("duration", 0) or 0))
    return Clip(
        clip_id=str(member.get("clip_id", "") or ""),
        name=str(member.get("name", "") or Path(media_path).stem),
        camera=str(member.get("camera", "?") or "?"),
        media_path=media_path,
        timeline_start=Fraction(str(member.get("timeline_start", 0) or 0)),
        timeline_end=Fraction(str(member.get("timeline_end", 0) or 0)),
        duration=duration,
        exists=bool(media_path and Path(media_path).is_file()),
        source_start=source_start,
        source_end=source_end,
        media_id=str(member.get("media_id", "") or ""),
    )


def _list_text(value: object, limit: int = 12) -> list[str]:
    return [
        _clean_text(item, 160)
        for item in _as_list(value)[:limit]
        if _clean_text(item, 160)
    ]


class ProjectSemanticIndexer:
    """Project evidence -> device-local searchable text/vector documents.

    This layer never asks a VLM to inspect new media. It only indexes evidence
    that already exists: ready Take semantics, cached ASR and human slate facts.
    Therefore refreshing search documents is cheap and safe to run after normal
    production changes without turning MirrorOrder into a full-project VLM scan.
    """

    def __init__(
        self,
        workspace_id: str,
        project_id: str,
        config: ProjectConfig,
        *,
        database: WorkspaceDatabase | None = None,
        media_store: DeviceMediaStore | None = None,
        encoder: SemanticEncoder | None = None,
    ):
        self.workspace_id = str(workspace_id or "")
        self.project_id = str(project_id or "")
        self.config = config
        self.database = database or WorkspaceDatabase(self.workspace_id)
        self.store = SemanticStore(self.database)
        self.media_store = media_store or DeviceMediaStore()
        self.encoder = encoder or SemanticEncoder()

    def _groups(self) -> dict[str, dict[str, Any]]:
        index = _read(self.config.output_dir / "material_index.json")
        return {
            str(row.get("group_id")): row
            for row in _as_list(index.get("groups"))
            if isinstance(row, dict) and row.get("group_id")
        }

    def _selected_groups(self, group_ids: Sequence[str] | None) -> dict[str, dict[str, Any]]:
        groups = self._groups()
        requested = {str(value) for value in (group_ids or []) if str(value)}
        if not requested:
            return groups
        return {group_id: group for group_id, group in groups.items() if group_id in requested}

    def _visual_documents(self, groups: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        documents: list[dict[str, Any]] = []
        for group_id, group in groups.items():
            semantic = self.database.semantic(self.project_id, group_id)
            if semantic.get("status") != "ready":
                continue
            data = _as_dict(semantic.get("data"))
            if not data:
                continue
            parts: list[str] = []
            summary = _clean_text(data.get("summary"), 1500)
            if summary:
                parts.append(summary)
            scalar_fields = (
                ("location", "场景"),
                ("shot_type", "景别"),
                ("description", "画面"),
                ("extracted_text", "画面文字"),
                ("speech_text", "画面分析听到的对白"),
            )
            for key, label in scalar_fields:
                value = _clean_text(data.get(key), 1200)
                if value:
                    parts.append(f"{label}：{value}")
            list_fields = (
                ("visible_people", "可见人物"),
                ("actions", "动作"),
                ("props", "道具"),
                ("emotion", "情绪"),
                ("continuity_clues", "连续性线索"),
                ("tags", "标签"),
            )
            for key, label in list_fields:
                values = _list_text(data.get(key))
                if values:
                    parts.append(f"{label}：{'、'.join(values)}")
            text = _clean_text("\n".join(parts), 12000)
            if not text:
                continue
            members = [row for row in _as_list(group.get("members")) if isinstance(row, dict)]
            metadata = {
                "evidence": "visual",
                "cameras": [str(value) for value in _as_list(group.get("cameras")) if str(value)][:12],
                "duration": float(group.get("duration", 0) or 0),
                "member_count": len(members),
            }
            documents.append(
                {
                    "document_id": _document_id(self.project_id, "visual", group_id),
                    "group_id": group_id,
                    "clip_id": str(members[0].get("clip_id", "") or "") if members else "",
                    "media_id": str(members[0].get("media_id", "") or "") if members else "",
                    "source": "visual",
                    "start": 0.0,
                    "end": float(group.get("duration", 0) or 0),
                    "text": text,
                    "metadata": metadata,
                    "content_fingerprint": _fingerprint(text, metadata),
                }
            )
        return documents

    def _speech_documents(self, groups: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        """Index cached ASR at segment precision without running new ASR.

        Segment times are relative to the logical Take/member source range. When
        synchronized cameras contain the same sentence at nearly the same time,
        keep one representative document and prefer the project's B/C/A audio
        evidence order. Old transcript caches without segments retain a Take-level
        fallback so semantic search never becomes less capable after this upgrade.
        """
        transcript_store = TranscriptStore(self.config.transcript_dir)
        documents: list[dict[str, Any]] = []
        camera_rank = {"B": 0, "C": 1, "A": 2}
        for group_id, group in groups.items():
            members = [row for row in _as_list(group.get("members")) if isinstance(row, dict)]
            members.sort(
                key=lambda row: (
                    camera_rank.get(str(row.get("camera", "") or "").upper(), 9),
                    float(row.get("timeline_start", 0) or 0),
                    str(row.get("clip_id", "") or ""),
                )
            )
            group_duration = max(0.0, float(group.get("duration", 0) or 0))
            seen_segments: list[tuple[str, float, float]] = []
            seen_fallback: set[str] = set()
            for member in members:
                media_path = self.media_store.resolve(self.workspace_id, self.project_id, member)
                if not media_path:
                    continue
                clip = _clip_for_member(member, media_path)
                transcript = transcript_store.load(clip)
                if transcript is None:
                    continue
                sliced = slice_transcript(
                    transcript,
                    float(member.get("source_start", 0) or 0),
                    float(member["source_end"]) if member.get("source_end") is not None else None,
                )
                camera = str(member.get("camera", "") or "")
                clip_id = str(member.get("clip_id", "") or "")
                media_id = str(member.get("media_id", "") or "")
                if sliced.segments:
                    for segment in sliced.segments:
                        text = _clean_text(segment.text, 2400)
                        if not text:
                            continue
                        start = max(0.0, float(segment.start or 0))
                        end = max(start, float(segment.end or start))
                        if group_duration > 0:
                            start = min(start, group_duration)
                            end = min(max(start, end), group_duration)
                        normalized = text.casefold()
                        duplicate = any(
                            normalized == previous_text
                            and abs(start - previous_start) <= 0.8
                            and abs(end - previous_end) <= 1.2
                            for previous_text, previous_start, previous_end in seen_segments
                        )
                        if duplicate:
                            continue
                        seen_segments.append((normalized, start, end))
                        metadata = {
                            "evidence": "speech",
                            "camera": camera,
                            "precision": "asr_segment",
                            "time_basis": "take_relative",
                            "transcript_backend": str(sliced.backend or "cache"),
                        }
                        documents.append(
                            {
                                "document_id": _document_id(
                                    self.project_id,
                                    "speech",
                                    f"{group_id}|{clip_id}|{start:.3f}|{end:.3f}",
                                ),
                                "group_id": group_id,
                                "clip_id": clip_id,
                                "media_id": media_id,
                                "source": "speech",
                                "start": start,
                                "end": end,
                                "text": text,
                                "metadata": metadata,
                                "content_fingerprint": _fingerprint(text, metadata),
                            }
                        )
                    continue

                text = _clean_text(sliced.text, 6000)
                normalized = text.casefold()
                if not text or normalized in seen_fallback:
                    continue
                seen_fallback.add(normalized)
                metadata = {
                    "evidence": "speech",
                    "camera": camera,
                    "precision": "take_fallback",
                    "time_basis": "take_relative",
                    "transcript_backend": str(sliced.backend or "cache"),
                }
                documents.append(
                    {
                        "document_id": _document_id(self.project_id, "speech", f"{group_id}|{clip_id}|fallback"),
                        "group_id": group_id,
                        "clip_id": clip_id,
                        "media_id": media_id,
                        "source": "speech",
                        "start": 0.0,
                        "end": group_duration,
                        "text": text,
                        "metadata": metadata,
                        "content_fingerprint": _fingerprint(text, metadata),
                    }
                )
        return documents

    def _slate_documents(self, group_ids: Sequence[str] | None) -> list[dict[str, Any]]:
        board = ScriptSupervisorStore(self.config.output_dir).load()
        records = _as_dict(board.get("records"))
        requested = {str(value) for value in (group_ids or []) if str(value)}
        documents: list[dict[str, Any]] = []
        status_labels = {
            "usable": "可用",
            "partial": "部分可用",
            "ng": "NG",
            "unmarked": "未标记",
        }
        for record_id, raw in records.items():
            record = _as_dict(raw)
            group_id = str(record.get("source_group_id", "") or "")
            if requested and group_id not in requested:
                continue
            parts: list[str] = []
            scene = _clean_text(record.get("scene"), 80)
            shot = _clean_text(record.get("shot"), 80)
            episode = record.get("episode")
            take_number = record.get("take_number")
            slate_id = " ".join(
                value for value in (
                    f"第{episode}集" if episode else "",
                    f"场{scene}" if scene else "",
                    f"镜{shot}" if shot else "",
                    f"第{take_number}次" if take_number else "",
                ) if value
            )
            if slate_id:
                parts.append(slate_id)
            status = str(record.get("status", "unmarked") or "unmarked")
            if status != "unmarked":
                parts.append("场记状态：" + status_labels.get(status, status))
            note = _clean_text(record.get("note"), 3000)
            if note:
                parts.append("场记备注：" + note)
            attachment_rows = []
            for attachment in _as_list(record.get("attachments")):
                if not isinstance(attachment, dict):
                    continue
                name = Path(str(attachment.get("display_name", "") or "")).name
                camera = _clean_text(attachment.get("camera"), 40)
                shot_type = _clean_text(attachment.get("shot_type"), 80)
                attachment_note = _clean_text(attachment.get("note"), 500)
                detail = " ".join(value for value in (camera, name, shot_type, attachment_note) if value)
                if detail:
                    attachment_rows.append(detail)
            if attachment_rows:
                parts.append("关联素材：" + "；".join(attachment_rows[:16]))
            usable = _as_dict(record.get("usable_range"))
            if usable:
                parts.append(f"人工可用范围：{usable.get('start', 0)}–{usable.get('end', 0)} 秒")
            text = _clean_text("\n".join(parts), 10000)
            if not text:
                continue
            attachments = [row for row in _as_list(record.get("attachments")) if isinstance(row, dict)]
            metadata = {
                "evidence": "script_supervisor",
                "record_id": str(record_id),
                "script_scene_id": str(record.get("script_scene_id", "") or ""),
                "status": status,
                "standalone": not bool(group_id),
            }
            documents.append(
                {
                    "document_id": _document_id(self.project_id, "slate", str(record_id)),
                    "group_id": group_id,
                    "clip_id": str(attachments[0].get("clip_id", "") or "") if attachments else "",
                    "media_id": str(attachments[0].get("media_id", "") or "") if attachments else "",
                    "source": "slate",
                    "start": float(usable.get("start", 0) or 0) if usable else 0.0,
                    "end": float(usable.get("end", 0) or 0) if usable else 0.0,
                    "text": text,
                    "metadata": metadata,
                    "content_fingerprint": _fingerprint(text, metadata),
                }
            )
        return documents

    def _attach_embeddings(self, source: str, documents: list[dict[str, Any]]) -> dict[str, Any]:
        existing = {
            row["document_id"]: row
            for row in self.store.documents(self.project_id, sources=[source])
        }
        pending: list[dict[str, Any]] = []
        for document in documents:
            current = existing.get(document["document_id"])
            if (
                current
                and current.get("content_fingerprint") == document.get("content_fingerprint")
                and current.get("embedding")
            ):
                # Preserve an existing vector while the encoder is temporarily
                # unavailable; if the configured model changed, re-encode below.
                if not self.encoder.enabled or current.get("embedding_model") == self.encoder.identity:
                    document["embedding"] = current["embedding"]
                    document["embedding_model"] = current.get("embedding_model", "")
                    continue
            if self.encoder.enabled:
                pending.append(document)

        encoded = 0
        failed = False
        for offset in range(0, len(pending), 32):
            batch = pending[offset : offset + 32]
            vectors = self.encoder.encode([row["text"] for row in batch])
            if vectors is None or len(vectors) != len(batch):
                failed = True
                break
            for row, vector in zip(batch, vectors):
                row["embedding"] = vector
                row["embedding_model"] = self.encoder.identity
                encoded += 1
        return {
            "encoder_enabled": self.encoder.enabled,
            "encoded": encoded,
            "embedding_failed": failed,
        }

    def refresh(
        self,
        *,
        group_ids: Sequence[str] | None = None,
        sources: Iterable[str] | None = None,
    ) -> dict[str, Any]:
        selected_sources = {str(value) for value in (sources or SEMANTIC_SOURCES) if str(value)}
        unknown = selected_sources - SEMANTIC_SOURCES
        if unknown:
            raise ValueError("unknown semantic sources: " + ", ".join(sorted(unknown)))
        groups = self._selected_groups(group_ids)
        reports: dict[str, Any] = {}
        for source in sorted(selected_sources):
            if source == "visual":
                documents = self._visual_documents(groups)
            elif source == "speech":
                documents = self._speech_documents(groups)
            else:
                documents = self._slate_documents(group_ids)
            embedding = self._attach_embeddings(source, documents)
            # Standalone slate rows have no group_id, so a targeted Take refresh
            # must not delete unrelated standalone records.
            scope = list(group_ids or []) if source != "slate" or group_ids else None
            persisted = self.store.replace_documents(
                self.project_id,
                source,
                documents,
                group_ids=scope,
            )
            reports[source] = {**persisted, **embedding}
        return {
            "contract": "semantic_refresh.v1",
            "project_id": self.project_id,
            "sources": reports,
            "index": self.store.summary(self.project_id),
            "encoder": self.encoder.config.public(),
            "semantics": {
                "new_vlm_inference": False,
                "device_local": True,
                "review_write": False,
                "editorial_write": False,
                "automatic_write": False,
            },
        }
