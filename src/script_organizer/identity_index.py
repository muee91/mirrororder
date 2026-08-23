from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import subprocess
from collections import defaultdict
from fractions import Fraction
from pathlib import Path
from typing import Any, Callable, Iterable

from .config import ProjectConfig
from .identity_runtime import FACE_DETECTOR, FACE_RECOGNIZER, SPEAKER_EMBEDDER, IdentityRuntime
from .media_identity import DeviceMediaStore
from .models import Clip
from .perception_index import PerceptionIndexer, _default_extract_frames
from .transcript import TranscriptStore
from .workspace_db import WorkspaceDatabase


ProgressCallback = Callable[[int, int, str], None]
CancelCallback = Callable[[], bool]


def _read_json(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


def _normalize(values: Iterable[float]) -> list[float]:
    vector = [float(value) for value in values]
    norm = math.sqrt(sum(value * value for value in vector))
    if norm <= 1e-12:
        return []
    return [value / norm for value in vector]


def _cosine(left: list[float], right: list[float]) -> float:
    if not left or len(left) != len(right):
        return -1.0
    return float(sum(a * b for a, b in zip(left, right)))


def _encode_embedding(values: Iterable[float]) -> bytes:
    import struct

    vector = [float(value) for value in values]
    return struct.pack("<" + "f" * len(vector), *vector)


def _decode_embedding(payload: bytes | memoryview | None) -> list[float]:
    import struct

    if payload is None:
        return []
    raw = bytes(payload)
    if not raw or len(raw) % 4:
        return []
    count = len(raw) // 4
    return list(struct.unpack("<" + "f" * count, raw))


def _threshold(name: str, default: float, lower: float, upper: float) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return max(lower, min(upper, value))


def _clip_for_member(member: dict[str, Any], media_path: str) -> Clip:
    source_start = Fraction(str(member.get("source_start", 0) or 0))
    raw_source_end = member.get("source_end")
    source_end = Fraction(str(raw_source_end)) if raw_source_end is not None else None
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


class FaceEmbeddingProvider:
    """YuNet + SFace local embedding provider using OpenCV DNN."""

    def __init__(self) -> None:
        models = IdentityRuntime.ensure_models("face")
        import cv2 as cv
        import numpy as np

        self.cv = cv
        self.np = np
        self.detector = cv.FaceDetectorYN.create(
            str(models[FACE_DETECTOR.filename]),
            "",
            (320, 320),
            0.80,
            0.30,
            5000,
        )
        self.recognizer = cv.FaceRecognizerSF.create(str(models[FACE_RECOGNIZER.filename]), "")

    def extract(self, frames: list[Path]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for frame_path in frames:
            image = self.cv.imread(str(frame_path))
            if image is None or image.size == 0:
                continue
            height, width = image.shape[:2]
            self.detector.setInputSize((width, height))
            _retval, faces = self.detector.detect(image)
            if faces is None:
                continue
            for face_index, face in enumerate(faces):
                confidence = float(face[-1])
                box_width = float(face[2])
                box_height = float(face[3])
                if confidence < 0.80 or min(box_width, box_height) < 36:
                    continue
                try:
                    aligned = self.recognizer.alignCrop(image, face[:-1])
                    embedding = self.recognizer.feature(aligned).flatten().astype(self.np.float32)
                except Exception:
                    continue
                vector = _normalize(embedding.tolist())
                if not vector:
                    continue
                result.append(
                    {
                        "embedding": vector,
                        "confidence": confidence,
                        "start": 0.0,
                        "end": 0.0,
                        "metadata": {
                            "frame_path": str(frame_path),
                            "face_index": face_index,
                            "bbox": [float(value) for value in face[:4]],
                            "landmarks": [float(value) for value in face[4:14]],
                            "model": FACE_RECOGNIZER.name,
                        },
                    }
                )
        return result


class SpeakerEmbeddingProvider:
    """Local sherpa-onnx speaker embedding provider fed by ffmpeg PCM windows."""

    def __init__(self) -> None:
        models = IdentityRuntime.ensure_models("speaker")
        import numpy as np
        import sherpa_onnx

        self.np = np
        self.sherpa = sherpa_onnx
        provider = os.environ.get("MIRRORORDER_SPEAKER_PROVIDER", "cpu").strip() or "cpu"
        config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(models[SPEAKER_EMBEDDER.filename]),
            num_threads=max(1, min(4, int(os.environ.get("MIRRORORDER_SPEAKER_THREADS", "2") or 2))),
            debug=False,
            provider=provider,
        )
        if not config.validate():
            raise RuntimeError("speaker embedding 配置无效")
        self.extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)

    def _audio(self, media_path: str, start: float, end: float) -> Any:
        duration = max(0.8, min(10.0, float(end) - float(start)))
        command = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-ss", f"{max(0.0, start):.3f}", "-i", media_path,
            "-t", f"{duration:.3f}", "-vn", "-ac", "1", "-ar", "16000",
            "-f", "f32le", "pipe:1",
        ]
        completed = subprocess.run(
            command,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=45,
        )
        samples = self.np.frombuffer(completed.stdout, dtype="<f4").astype(self.np.float32, copy=False)
        if samples.size < 16000:
            return None
        # Reject almost-silent windows before spending inference time.
        rms = float(self.np.sqrt(self.np.mean(samples * samples)))
        if rms < 0.003:
            return None
        return self.np.ascontiguousarray(samples)

    def extract(self, media_path: str, ranges: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for item in ranges:
            start = float(item.get("start", 0) or 0)
            end = float(item.get("end", start) or start)
            if end - start < 0.8:
                continue
            try:
                samples = self._audio(media_path, start, end)
                if samples is None:
                    continue
                stream = self.extractor.create_stream()
                stream.accept_waveform(sample_rate=16000, waveform=samples)
                stream.input_finished()
                if not self.extractor.is_ready(stream):
                    continue
                embedding = self.extractor.compute(stream)
            except (OSError, subprocess.SubprocessError, RuntimeError):
                continue
            vector = _normalize(list(embedding))
            if not vector:
                continue
            result.append(
                {
                    "embedding": vector,
                    "confidence": 1.0,
                    "start": start,
                    "end": end,
                    "metadata": {
                        "text": str(item.get("text", "") or "")[:500],
                        "source": str(item.get("source", "asr") or "asr"),
                        "model": SPEAKER_EMBEDDER.name,
                    },
                }
            )
        return result


class IdentityIndexer:
    """Project-local actor/speaker clustering over device-local embeddings."""

    def __init__(
        self,
        workspace_id: str,
        project_id: str,
        config: ProjectConfig,
        *,
        database: WorkspaceDatabase | None = None,
        media_store: DeviceMediaStore | None = None,
        face_provider: FaceEmbeddingProvider | Any | None = None,
        speaker_provider: SpeakerEmbeddingProvider | Any | None = None,
    ):
        self.workspace_id = workspace_id
        self.project_id = project_id
        self.config = config
        self.database = database or WorkspaceDatabase(workspace_id)
        self.media_store = media_store or DeviceMediaStore()
        self.face_provider = face_provider
        self.speaker_provider = speaker_provider
        self.face_threshold = _threshold("MIRRORORDER_FACE_CLUSTER_THRESHOLD", 0.45, 0.25, 0.90)
        self.speaker_threshold = _threshold("MIRRORORDER_SPEAKER_CLUSTER_THRESHOLD", 0.65, 0.35, 0.95)
        self.identity_frame_root = self.database.path.parent / "identity-frames" / project_id

    def _index(self) -> dict[str, Any]:
        return _read_json(self.config.output_dir / "material_index.json")

    @staticmethod
    def _groups(index: dict[str, Any]) -> dict[str, dict[str, Any]]:
        return {
            str(item.get("group_id")): item
            for item in index.get("groups", [])
            if isinstance(item, dict) and item.get("group_id")
        }

    def _sync_structure(self, index: dict[str, Any]) -> None:
        self.database.sync_take_index(
            self.project_id,
            name=self.config.name,
            input_kind=self.config.input_kind,
            config_path=str(self.config.config_path),
            index=index,
        )

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

    def _face_frames(self, group: dict[str, Any]) -> list[Path]:
        group_id = str(group.get("group_id", ""))
        existing = [
            Path(str(item.get("path", "")))
            for item in self.database.frames(self.project_id, group_id)
            if Path(str(item.get("path", ""))).is_file()
        ]
        if len(existing) >= 3:
            return existing[:3]
        selected = self._preferred_member(group)
        if selected is None:
            return existing
        member, media_path = selected
        source_start = float(member.get("source_start", 0) or 0)
        source_end = (
            float(member["source_end"])
            if member.get("source_end") is not None
            else source_start + float(member.get("duration", 0) or 0)
        )
        digest = hashlib.sha1(
            f"{group_id}|{member.get('clip_id', '')}|face-v1".encode("utf-8")
        ).hexdigest()[:12]
        rows = _default_extract_frames(
            media_path,
            source_start,
            source_end,
            3,
            self.identity_frame_root / group_id / digest,
        )
        extracted = [Path(str(item.get("path", ""))) for item in rows if Path(str(item.get("path", ""))).is_file()]
        return extracted or existing

    def _speaker_ranges(self, member: dict[str, Any], media_path: str) -> list[dict[str, Any]]:
        clip = _clip_for_member(member, media_path)
        transcript = TranscriptStore(self.config.transcript_dir).load(clip)
        lower = float(member.get("source_start", 0) or 0)
        upper = (
            float(member["source_end"])
            if member.get("source_end") is not None
            else lower + float(member.get("duration", 0) or 0)
        )
        ranges: list[dict[str, Any]] = []
        if transcript is not None:
            for segment in transcript.segments:
                start = max(lower, float(segment.start))
                end = min(upper, float(segment.end))
                if end - start >= 0.8:
                    ranges.append({"start": start, "end": end, "text": segment.text, "source": "asr"})
        ranges.sort(key=lambda item: (-(float(item["end"]) - float(item["start"])), float(item["start"])))
        if ranges:
            return ranges[:3]
        duration = max(0.0, upper - lower)
        if duration < 0.8:
            return []
        length = min(6.0, duration)
        start = lower + max(0.0, (duration - length) / 2.0)
        return [{"start": start, "end": start + length, "text": "", "source": "fallback"}]

    def _existing_clusters(self, kind: str, exclude_group_id: str) -> dict[str, list[list[float]]]:
        clusters: dict[str, list[list[float]]] = defaultdict(list)
        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT identity_id, embedding
                FROM identity_observations
                WHERE project_id=? AND kind=? AND group_id<>? AND identity_id IS NOT NULL
                """,
                (self.project_id, kind, exclude_group_id),
            ).fetchall()
        for row in rows:
            identity_id = str(row["identity_id"] or "")
            vector = _normalize(_decode_embedding(row["embedding"]))
            if identity_id and vector:
                clusters[identity_id].append(vector)
        return clusters

    @staticmethod
    def _centroid(vectors: list[list[float]]) -> list[float]:
        if not vectors:
            return []
        width = len(vectors[0])
        if any(len(vector) != width for vector in vectors):
            return []
        return _normalize([sum(vector[index] for vector in vectors) / len(vectors) for index in range(width)])

    def _identity_count(self, kind: str) -> int:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT COUNT(*) FROM identities WHERE project_id=? AND kind=?",
                (self.project_id, kind),
            ).fetchone()
        return int(row[0] or 0) if row else 0

    def _assign(
        self,
        kind: str,
        group_id: str,
        observations: list[dict[str, Any]],
        *,
        clip_id: str,
        threshold: float,
    ) -> int:
        clusters = self._existing_clusters(kind, group_id)
        with self.database.connection() as connection:
            connection.execute(
                "DELETE FROM identity_observations WHERE project_id=? AND group_id=? AND kind=?",
                (self.project_id, group_id, kind),
            )
            connection.commit()
        created = self._identity_count(kind)
        written = 0
        for observation in observations:
            vector = _normalize(observation.get("embedding", []))
            if not vector:
                continue
            best_id = ""
            best_score = -1.0
            for identity_id, vectors in clusters.items():
                score = _cosine(vector, self._centroid(vectors))
                if score > best_score:
                    best_id = identity_id
                    best_score = score
            if not best_id or best_score < threshold:
                digest = hashlib.sha1(_encode_embedding(vector)).hexdigest()[:18]
                best_id = f"{kind}_{digest}"
                created += 1
                label = ("人物候选 " if kind == "face" else "声音候选 ") + f"{created:02d}"
                self.database.upsert_identity(
                    self.project_id,
                    identity_id=best_id,
                    kind=kind,
                    label=label,
                    metadata={"auto_cluster": True, "threshold": threshold},
                )
                clusters[best_id] = []
                best_score = 1.0
            clusters.setdefault(best_id, []).append(vector)
            metadata = dict(observation.get("metadata", {}))
            metadata["cluster_similarity"] = max(0.0, min(1.0, best_score))
            self.database.add_identity_observation(
                self.project_id,
                group_id,
                kind=kind,
                clip_id=clip_id,
                start=float(observation.get("start", 0) or 0),
                end=float(observation.get("end", 0) or 0),
                confidence=float(observation.get("confidence", 0) or 0),
                identity_id=best_id,
                embedding=_encode_embedding(vector),
                metadata=metadata,
            )
            written += 1
        return written

    def _run_face(self, group: dict[str, Any]) -> int:
        frames = self._face_frames(group)
        if not frames:
            return 0
        provider = self.face_provider or FaceEmbeddingProvider()
        observations = provider.extract(frames)
        clip_id = ""
        selected = self._preferred_member(group)
        if selected:
            clip_id = str(selected[0].get("clip_id", "") or "")
        return self._assign(
            "face",
            str(group.get("group_id", "")),
            observations,
            clip_id=clip_id,
            threshold=self.face_threshold,
        )

    def _run_speaker(self, group: dict[str, Any]) -> int:
        selected = self._preferred_member(group)
        if selected is None:
            return 0
        member, media_path = selected
        ranges = self._speaker_ranges(member, media_path)
        if not ranges:
            return 0
        provider = self.speaker_provider or SpeakerEmbeddingProvider()
        observations = provider.extract(media_path, ranges)
        return self._assign(
            "speaker",
            str(group.get("group_id", "")),
            observations,
            clip_id=str(member.get("clip_id", "") or ""),
            threshold=self.speaker_threshold,
        )

    def run(
        self,
        kind: str,
        *,
        group_ids: list[str] | None = None,
        progress: ProgressCallback | None = None,
        cancelled: CancelCallback | None = None,
    ) -> dict[str, Any]:
        if kind not in {"face", "speaker"}:
            raise ValueError("identity kind 必须是 face 或 speaker")
        index = self._index()
        if not index:
            return {"status": "deferred", "reason": "项目尚未生成 material_index.json", "kind": kind}
        self._sync_structure(index)
        groups = self._groups(index)
        requested = {str(value) for value in (group_ids or []) if str(value)}
        ordered = [
            group for group in groups.values()
            if not requested or str(group.get("group_id", "")) in requested
        ]
        ordered.sort(key=lambda row: (float(row.get("start", 0) or 0), str(row.get("group_id", ""))))
        processed = 0
        observations = 0
        failed = 0
        for group in ordered:
            if cancelled and cancelled():
                return {
                    "status": "cancelled",
                    "kind": kind,
                    "processed": processed,
                    "observations": observations,
                    "failed": failed,
                }
            group_id = str(group.get("group_id", ""))
            try:
                count = self._run_face(group) if kind == "face" else self._run_speaker(group)
                observations += count
                processed += 1
            except Exception:
                failed += 1
            if progress:
                progress(processed + failed, len(ordered), group_id)
        return {
            "status": "completed",
            "kind": kind,
            "processed": processed,
            "observations": observations,
            "failed": failed,
            "total": len(ordered),
            "threshold": self.face_threshold if kind == "face" else self.speaker_threshold,
            "intelligence": self.database.project_intelligence(self.project_id),
        }
