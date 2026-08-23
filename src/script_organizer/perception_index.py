from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any, Callable

from .config import ProjectConfig
from .media_identity import DeviceMediaStore
from .models import Clip
from .take_semantic_provider import TakeSemanticProvider
from .transcript import TranscriptStore, slice_transcript
from .workspace_db import WorkspaceDatabase


ProgressCallback = Callable[[int, int, str], None]
CancelCallback = Callable[[], bool]
FrameExtractor = Callable[[str, float, float | None, int, Path], list[dict[str, Any]]]


def _read_json(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


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


def _default_extract_frames(
    media_path: str,
    source_start: float,
    source_end: float | None,
    count: int,
    output_dir: Path,
) -> list[dict[str, Any]]:
    """Extract a bounded number of low-resolution evidence frames.

    Tier-0 uses one midpoint frame. Semantic indexing may request up to five
    frames. This is intentionally event-driven, not continuous video sampling.
    """

    if shutil.which("ffmpeg") is None:
        return []
    source = Path(media_path)
    if not source.is_file():
        return []
    count = max(1, min(5, int(count)))
    start = max(0.0, float(source_start or 0.0))
    end = float(source_end) if source_end is not None else start + 3.0
    if end <= start:
        end = start + 1.0
    span = max(0.25, end - start)
    fractions = [0.5] if count == 1 else [0.12 + 0.76 * index / (count - 1) for index in range(count)]
    output_dir.mkdir(parents=True, exist_ok=True)
    frames: list[dict[str, Any]] = []
    for index, fraction in enumerate(fractions, start=1):
        timestamp = start + span * fraction
        target = output_dir / f"frame-{index:02d}.jpg"
        command = [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{timestamp:.3f}", "-i", str(source),
            "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", str(target),
        ]
        try:
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45)
        except (OSError, subprocess.SubprocessError):
            continue
        if target.is_file() and target.stat().st_size > 0:
            frames.append({"path": str(target), "source_time": timestamp})
    return frames


class PerceptionIndexer:
    """Build a rebuildable, device-local perceptual index for Take groups."""

    def __init__(
        self,
        workspace_id: str,
        project_id: str,
        config: ProjectConfig,
        *,
        database: WorkspaceDatabase | None = None,
        media_store: DeviceMediaStore | None = None,
        semantic_provider: TakeSemanticProvider | None = None,
        frame_extractor: FrameExtractor | None = None,
    ):
        self.workspace_id = workspace_id
        self.project_id = project_id
        self.config = config
        self.database = database or WorkspaceDatabase(workspace_id)
        self.media_store = media_store or DeviceMediaStore()
        self.semantic_provider = semantic_provider or TakeSemanticProvider()
        self.frame_extractor = frame_extractor or _default_extract_frames
        self.frame_root = self.database.path.parent / "frames" / project_id

    def _index(self) -> dict[str, Any]:
        return _read_json(self.config.output_dir / "material_index.json")

    def _matches(self) -> dict[str, Any]:
        return _read_json(self.config.output_dir / "matches.json")

    def _sync_structure(self, index: dict[str, Any]) -> dict[str, int]:
        return self.database.sync_take_index(
            self.project_id,
            name=self.config.name,
            input_kind=self.config.input_kind,
            config_path=str(self.config.config_path),
            index=index,
        )

    def _groups(self, index: dict[str, Any]) -> dict[str, dict[str, Any]]:
        return {
            str(item.get("group_id")): item
            for item in index.get("groups", [])
            if isinstance(item, dict) and item.get("group_id")
        }

    def _preferred_member(self, group: dict[str, Any]) -> tuple[dict[str, Any], str] | None:
        members = [item for item in group.get("members", []) if isinstance(item, dict)]
        priority = {camera: index for index, camera in enumerate(self.config.asr_camera_priority)}
        members.sort(
            key=lambda item: (
                priority.get(str(item.get("camera", "")), 999),
                -float(item.get("duration", 0) or 0),
                str(item.get("name", "")),
            )
        )
        for member in members:
            path = self.media_store.resolve(self.workspace_id, self.project_id, member)
            if path:
                return member, path
        return None

    def _extract_for_group(self, group: dict[str, Any], count: int, reason: str) -> list[dict[str, Any]]:
        selected = self._preferred_member(group)
        if selected is None:
            return []
        member, media_path = selected
        source_start = float(member.get("source_start", 0) or 0)
        source_end = float(member["source_end"]) if member.get("source_end") is not None else source_start + float(member.get("duration", 0) or 0)
        group_id = str(group.get("group_id", ""))
        clip_id = str(member.get("clip_id", "") or "")
        digest = hashlib.sha1(f"{group_id}|{clip_id}|{count}".encode("utf-8")).hexdigest()[:10]
        output_dir = self.frame_root / group_id / digest
        extracted = self.frame_extractor(media_path, source_start, source_end, count, output_dir)
        frames = []
        for index, item in enumerate(extracted):
            path = Path(str(item.get("path", "")))
            if not path.is_file():
                continue
            source_time = float(item.get("source_time", source_start) or source_start)
            frame_id = "frm_" + hashlib.sha1(
                f"{self.project_id}|{group_id}|{clip_id}|{source_time:.3f}|{path.name}".encode("utf-8")
            ).hexdigest()[:20]
            frames.append(
                {
                    "frame_id": frame_id,
                    "clip_id": clip_id,
                    "camera": str(member.get("camera", "") or ""),
                    "source_time": source_time,
                    "reason": reason,
                    "path": str(path),
                }
            )
        return frames

    def _semantic_context(self, group: dict[str, Any]) -> dict[str, Any]:
        matches = self._matches().get("groups", {})
        row = matches.get(str(group.get("group_id", "")), {}) if isinstance(matches, dict) else {}
        candidates = []
        for candidate in row.get("candidates", [])[:5] if isinstance(row, dict) else []:
            if not isinstance(candidate, dict):
                continue
            candidates.append(
                {
                    "candidate_id": candidate.get("candidate_id", ""),
                    "script_segment_ids": candidate.get("script_segment_ids", []),
                    "confidence": candidate.get("confidence", ""),
                    "transcript_text": str(candidate.get("transcript_text", "") or "")[:600],
                }
            )
        transcripts = []
        store = TranscriptStore(self.config.transcript_dir)
        for member in group.get("members", []):
            if not isinstance(member, dict):
                continue
            media_path = self.media_store.resolve(self.workspace_id, self.project_id, member)
            if not media_path:
                continue
            clip = _clip_for_member(member, media_path)
            transcript = store.load(clip)
            if transcript is None:
                continue
            sliced = slice_transcript(
                transcript,
                float(member.get("source_start", 0) or 0),
                float(member["source_end"]) if member.get("source_end") is not None else None,
            )
            if sliced.text.strip():
                transcripts.append(
                    {
                        "camera": member.get("camera", ""),
                        "text": sliced.text[:1000],
                    }
                )
        return {
            "group_id": group.get("group_id", ""),
            "cameras": group.get("cameras", []),
            "duration": group.get("duration", 0),
            "transcripts": transcripts[:4],
            "existing_candidates": candidates,
        }

    def run(
        self,
        *,
        mode: str = "tier0",
        group_ids: list[str] | None = None,
        progress: ProgressCallback | None = None,
        cancelled: CancelCallback | None = None,
    ) -> dict[str, Any]:
        if mode not in {"tier0", "semantic"}:
            raise ValueError("perception mode 必须是 tier0 或 semantic")
        index = self._index()
        if not index:
            return {"status": "deferred", "reason": "项目尚未生成 material_index.json"}
        structure = self._sync_structure(index)
        groups = self._groups(index)
        pending = self.database.pending_groups(
            self.project_id,
            semantic=(mode == "semantic"),
            group_ids=group_ids,
        )
        run_id = self.database.start_perception_run(self.project_id, mode)
        processed = 0
        failed = 0
        unavailable = 0
        try:
            total = len(pending)
            for group_id in pending:
                if cancelled and cancelled():
                    details = {"structure": structure, "pending": max(0, total - processed - failed)}
                    self.database.finish_perception_run(
                        run_id,
                        status="cancelled",
                        processed=processed,
                        failed=failed,
                        details=details,
                    )
                    return {"status": "cancelled", "processed": processed, "failed": failed, **details}
                group = groups.get(group_id)
                if not group:
                    failed += 1
                    continue
                if mode == "tier0":
                    frames = self._extract_for_group(group, 1, "midpoint")
                    if frames:
                        self.database.replace_frames(self.project_id, group_id, frames)
                        processed += 1
                    else:
                        failed += 1
                else:
                    frames = self._extract_for_group(group, 3, "semantic_sample")
                    if frames:
                        self.database.replace_frames(self.project_id, group_id, frames)
                    else:
                        frames = self.database.frames(self.project_id, group_id)
                    paths = [Path(str(item.get("path", ""))) for item in frames if Path(str(item.get("path", ""))).is_file()]
                    if not paths or not self.semantic_provider.enabled:
                        self.database.set_semantic(self.project_id, group_id, {}, "unavailable")
                        unavailable += 1
                    else:
                        result = self.semantic_provider.describe(self._semantic_context(group), paths)
                        if result is None:
                            self.database.set_semantic(self.project_id, group_id, {}, "failed")
                            failed += 1
                        else:
                            self.database.set_semantic(self.project_id, group_id, result, "ready")
                            processed += 1
                if progress:
                    progress(processed + failed + unavailable, total, group_id)
            details = {"structure": structure, "unavailable": unavailable}
            self.database.finish_perception_run(
                run_id,
                status="completed",
                processed=processed,
                failed=failed,
                details=details,
            )
            return {
                "status": "completed",
                "mode": mode,
                "processed": processed,
                "failed": failed,
                "unavailable": unavailable,
                "total": total,
                "intelligence": self.database.project_intelligence(self.project_id),
            }
        except Exception as error:
            self.database.finish_perception_run(
                run_id,
                status="failed",
                processed=processed,
                failed=failed + 1,
                error=str(error),
            )
            raise
