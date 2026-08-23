from __future__ import annotations

import hashlib
import os
import subprocess
from collections import defaultdict
from pathlib import Path
from typing import Any

from .identity_index_legacy import (
    FaceEmbeddingProvider as _LegacyFaceProvider,
    IdentityIndexer as _LegacyIndexer,
    SpeakerEmbeddingProvider as _LegacySpeakerProvider,
    _centroid,
    _clip_for_member,
    _cosine,
    _decode_embedding,
    _normalize,
    _threshold,
)
from .identity_rescue import apply_identity_rescue
from .identity_runtime import (
    FACE_DETECTOR,
    FACE_RECOGNIZER,
    SPEAKER_EMBEDDER,
    SPEAKER_SEGMENTER,
    IdentityRuntime,
)
from .perception_index import _default_extract_frames
from .transcript import TranscriptStore


def _integer(name: str, default: int, lower: int, upper: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError:
        value = default
    return max(lower, min(upper, value))


class FaceEmbeddingProvider(_LegacyFaceProvider):
    """Sparse per-camera face tracks; output stays anonymous until App review."""

    def __init__(self) -> None:
        super().__init__()
        self.track_threshold = _threshold("MIRRORORDER_FACE_TRACK_THRESHOLD", 0.50, 0.30, 0.90)

    def _detections(self, frame: dict[str, Any]) -> list[dict[str, Any]]:
        path = Path(str(frame.get("path", "")))
        image = self.cv.imread(str(path))
        if image is None or image.size == 0:
            return []
        height, width = image.shape[:2]
        self.detector.setInputSize((width, height))
        _retval, faces = self.detector.detect(image)
        if faces is None:
            return []
        result = []
        for face_index, face in enumerate(faces):
            confidence = float(face[-1])
            if confidence < 0.80 or min(float(face[2]), float(face[3])) < 36:
                continue
            try:
                aligned = self.recognizer.alignCrop(image, face)
                raw = self.recognizer.feature(aligned).flatten().astype(self.np.float32)
            except Exception:
                continue
            vector = _normalize(raw.tolist())
            if vector:
                result.append(
                    {
                        "embedding": vector,
                        "confidence": confidence,
                        "bbox": [float(value) for value in face[:4]],
                        "landmarks": [float(value) for value in face[4:14]],
                        "face_index": face_index,
                        "frame": frame,
                    }
                )
        return result

    def extract_with_metadata(self, frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
        tracks: dict[str, list[dict[str, Any]]] = defaultdict(list)
        next_track: defaultdict[str, int] = defaultdict(int)
        ordered = sorted(
            frames,
            key=lambda item: (
                str(item.get("camera", "")),
                float(item.get("source_time", 0) or 0),
                str(item.get("path", "")),
            ),
        )
        for frame in ordered:
            camera = str(frame.get("camera", "") or "?")
            used: set[str] = set()
            for detection in self._detections(frame):
                best_track = ""
                best_score = -1.0
                for track_id, observations in tracks.items():
                    if not track_id.startswith(camera + ":") or track_id in used:
                        continue
                    score = _cosine(
                        detection["embedding"],
                        _centroid([item["embedding"] for item in observations]),
                    )
                    if score > best_score:
                        best_track, best_score = track_id, score
                if not best_track or best_score < self.track_threshold:
                    next_track[camera] += 1
                    best_track = f"{camera}:{next_track[camera]:03d}"
                tracks[best_track].append(detection)
                used.add(best_track)

        result = []
        for track_id, observations in tracks.items():
            vector = _centroid([item["embedding"] for item in observations])
            if not vector:
                continue
            best = max(observations, key=lambda item: float(item["confidence"]))
            frame = best["frame"]
            times = [float(item["frame"].get("source_time", 0) or 0) for item in observations]
            result.append(
                {
                    "embedding": vector,
                    "confidence": sum(float(item["confidence"]) for item in observations) / len(observations),
                    "start": min(times) if times else 0.0,
                    "end": max(times) if times else 0.0,
                    "clip_id": str(frame.get("clip_id", "") or ""),
                    "metadata": {
                        "source": "multicam-face-track",
                        "track_id": track_id,
                        "camera": str(frame.get("camera", "") or ""),
                        "frame_count": len(observations),
                        "frame_path": str(frame.get("path", "") or ""),
                        "source_time": float(frame.get("source_time", 0) or 0),
                        "bbox": best["bbox"],
                        "landmarks": best["landmarks"],
                        "model": FACE_RECOGNIZER.name,
                    },
                }
            )
        return result


class SpeakerEmbeddingProvider(_LegacySpeakerProvider):
    """Offline speaker-turn segmentation plus cross-Take voice clustering."""

    def __init__(self) -> None:
        super().__init__()
        models = IdentityRuntime.ensure_models("speaker")
        import sherpa_onnx

        diarization_type = getattr(sherpa_onnx, "OfflineSpeakerDiarization", None)
        if diarization_type is None:
            raise RuntimeError("当前 sherpa-onnx wheel 未包含 speaker diarization")
        provider = os.environ.get("MIRRORORDER_SPEAKER_PROVIDER", "cpu").strip() or "cpu"
        threads = _integer("MIRRORORDER_SPEAKER_THREADS", 2, 1, 4)
        embedding = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(models[SPEAKER_EMBEDDER.filename]),
            num_threads=threads,
            debug=False,
            provider=provider,
        )
        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                    model=str(models[SPEAKER_SEGMENTER.filename])
                )
            ),
            embedding=embedding,
            clustering=sherpa_onnx.FastClusteringConfig(
                num_clusters=-1,
                threshold=_threshold("MIRRORORDER_DIARIZATION_THRESHOLD", 0.50, 0.25, 0.90),
            ),
            min_duration_on=0.30,
            min_duration_off=0.35,
        )
        if not config.validate():
            raise RuntimeError("speaker diarization 配置无效")
        self.diarizer = diarization_type(config)
        self.sample_rate = int(self.diarizer.sample_rate)

    def _audio_window(self, media_path: str, start: float, end: float) -> Any:
        duration = max(0.0, float(end) - float(start))
        if duration < 0.35:
            return None
        completed = subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error",
                "-ss", f"{max(0.0, start):.3f}", "-i", media_path,
                "-t", f"{duration:.3f}", "-vn", "-ac", "1", "-ar", str(self.sample_rate),
                "-f", "f32le", "pipe:1",
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=max(45, min(180, int(duration * 2 + 30))),
        )
        samples = self.np.frombuffer(completed.stdout, dtype="<f4").astype(self.np.float32, copy=False)
        return self.np.ascontiguousarray(samples) if samples.size else None

    def _embedding_for_samples(self, samples: Any) -> list[float]:
        if samples is None or len(samples) < int(self.sample_rate * 0.50):
            return []
        rms = float(self.np.sqrt(self.np.mean(samples * samples)))
        if rms < 0.003:
            return []
        stream = self.extractor.create_stream()
        stream.accept_waveform(sample_rate=self.sample_rate, waveform=samples)
        stream.input_finished()
        if not self.extractor.is_ready(stream):
            return []
        return _normalize(list(self.extractor.compute(stream)))

    @staticmethod
    def _text_for(start: float, end: float, ranges: list[dict[str, Any]]) -> str:
        texts = []
        for item in ranges:
            left = float(item.get("start", 0) or 0)
            right = float(item.get("end", left) or left)
            if min(end, right) - max(start, left) > 0.05:
                text = str(item.get("text", "") or "").strip()
                if text:
                    texts.append(text)
        return " ".join(texts)[:600]

    def extract_diarized(
        self,
        media_path: str,
        start: float,
        end: float,
        transcript_ranges: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        result = []
        cursor = max(0.0, float(start))
        upper = max(cursor, float(end))
        while cursor < upper - 0.35:
            chunk_end = min(upper, cursor + 120.0)
            try:
                samples = self._audio_window(media_path, cursor, chunk_end)
                if samples is None:
                    cursor = chunk_end
                    continue
                segments = self.diarizer.process(samples).sort_by_start_time()
            except (OSError, subprocess.SubprocessError, RuntimeError):
                cursor = chunk_end
                continue
            sample_seconds = float(len(samples)) / self.sample_rate
            for segment in segments:
                local_start = max(0.0, float(segment.start))
                local_end = min(sample_seconds, float(segment.end))
                if local_end - local_start < 0.50:
                    continue
                first = int(local_start * self.sample_rate)
                last = int(local_end * self.sample_rate)
                vector = self._embedding_for_samples(self.np.ascontiguousarray(samples[first:last]))
                if not vector:
                    continue
                absolute_start = cursor + local_start
                absolute_end = cursor + local_end
                result.append(
                    {
                        "embedding": vector,
                        "confidence": 1.0,
                        "start": absolute_start,
                        "end": absolute_end,
                        "metadata": {
                            "source": "sherpa-offline-diarization",
                            "local_speaker": int(segment.speaker),
                            "text": self._text_for(absolute_start, absolute_end, transcript_ranges),
                            "segmentation_model": SPEAKER_SEGMENTER.name,
                            "embedding_model": SPEAKER_EMBEDDER.name,
                        },
                    }
                )
            cursor = chunk_end
        return result


class IdentityIndexer(_LegacyIndexer):
    """Incremental anonymous person tracks + speaker turns over local media."""

    def __init__(self, *args: Any, frame_extractor: Any | None = None, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self.frame_extractor = frame_extractor or _default_extract_frames
        self.frames_per_camera = _integer("MIRRORORDER_FACE_FRAMES_PER_CAMERA", 3, 1, 5)

    def _members(self, group: dict[str, Any]) -> list[tuple[dict[str, Any], str]]:
        priority = {camera: index for index, camera in enumerate(self.config.asr_camera_priority)}
        members = [item for item in group.get("members", []) if isinstance(item, dict)]
        members.sort(
            key=lambda item: (
                priority.get(str(item.get("camera", "")), 999),
                -float(item.get("duration", 0) or 0),
                str(item.get("name", "")),
            )
        )
        result = []
        cameras = set()
        for member in members:
            camera = str(member.get("camera", "") or "?")
            if camera in cameras:
                continue
            path = self.media_store.resolve(self.workspace_id, self.project_id, member)
            if path:
                cameras.add(camera)
                result.append((member, path))
        return result[:4]

    def _preferred_member(self, group: dict[str, Any]) -> tuple[dict[str, Any], str] | None:
        rows = self._members(group)
        return rows[0] if rows else None

    def _face_frame_rows(self, group: dict[str, Any]) -> list[dict[str, Any]]:
        group_id = str(group.get("group_id", ""))
        rows = []
        for item in self.database.frames(self.project_id, group_id):
            path = Path(str(item.get("path", "")))
            if path.is_file():
                rows.append(
                    {
                        "path": str(path),
                        "source_time": float(item.get("source_time", 0) or 0),
                        "camera": str(item.get("camera", "") or "?"),
                        "clip_id": str(item.get("clip_id", "") or ""),
                    }
                )
        existing = defaultdict(int)
        for row in rows:
            existing[row["camera"]] += 1
        for member, media_path in self._members(group):
            camera = str(member.get("camera", "") or "?")
            if existing[camera] >= self.frames_per_camera:
                continue
            source_start = float(member.get("source_start", 0) or 0)
            source_end = (
                float(member["source_end"])
                if member.get("source_end") is not None
                else source_start + float(member.get("duration", 0) or 0)
            )
            clip_id = str(member.get("clip_id", "") or "")
            digest = hashlib.sha1(
                f"{group_id}|{clip_id}|face-v2|{self.frames_per_camera}".encode("utf-8")
            ).hexdigest()[:12]
            for item in self.frame_extractor(
                media_path,
                source_start,
                source_end,
                self.frames_per_camera,
                self.identity_frame_root / group_id / camera / digest,
            ):
                path = Path(str(item.get("path", "")))
                if path.is_file():
                    rows.append(
                        {
                            "path": str(path),
                            "source_time": float(item.get("source_time", source_start) or source_start),
                            "camera": camera,
                            "clip_id": clip_id,
                        }
                    )
        unique = {str(row["path"]): row for row in rows}
        return sorted(
            unique.values(),
            key=lambda item: (
                str(item.get("camera", "")),
                float(item.get("source_time", 0) or 0),
            ),
        )[:20]

    def _existing_clusters(self, kind: str, exclude_group_id: str) -> dict[str, list[list[float]]]:
        clusters: dict[str, list[list[float]]] = defaultdict(list)
        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT o.identity_id, o.embedding
                FROM identity_observations AS o
                LEFT JOIN identities AS i
                  ON i.project_id=o.project_id AND i.identity_id=o.identity_id
                WHERE o.project_id=? AND o.kind=? AND o.identity_id IS NOT NULL
                  AND (
                    o.group_id<>?
                    OR COALESCE(json_extract(i.metadata_json, '$.human_confirmed'), 0)=1
                  )
                """,
                (self.project_id, kind, exclude_group_id),
            ).fetchall()
        for row in rows:
            identity_id = str(row["identity_id"] or "")
            vector = _normalize(_decode_embedding(row["embedding"]))
            if identity_id and vector:
                clusters[identity_id].append(vector)
        return clusters

    def _run_face(self, group: dict[str, Any]) -> int:
        rows = self._face_frame_rows(group)
        if not rows:
            return 0
        provider = self.face_provider
        if provider is None:
            raise RuntimeError("人脸轨迹 provider 未初始化")
        if hasattr(provider, "extract_with_metadata"):
            observations = provider.extract_with_metadata(rows)
        else:
            observations = provider.extract([Path(str(row["path"])) for row in rows])
        preferred = self._preferred_member(group)
        clip_id = str(preferred[0].get("clip_id", "") or "") if preferred else ""
        return self._assign(
            "face", str(group.get("group_id", "")), observations,
            clip_id=clip_id, threshold=self.face_threshold,
        )

    def _run_speaker(self, group: dict[str, Any]) -> int:
        selected = self._preferred_member(group)
        if selected is None:
            return 0
        member, media_path = selected
        ranges = self._speaker_ranges(member, media_path)
        if not ranges:
            return 0
        provider = self.speaker_provider
        if provider is None:
            raise RuntimeError("说话人分段 provider 未初始化")
        lower = float(member.get("source_start", 0) or 0)
        upper = (
            float(member["source_end"])
            if member.get("source_end") is not None
            else lower + float(member.get("duration", 0) or 0)
        )
        if hasattr(provider, "extract_diarized"):
            observations = provider.extract_diarized(media_path, lower, upper, ranges)
            if not observations:
                observations = provider.extract(media_path, ranges[:3])
        else:
            observations = provider.extract(media_path, ranges[:3])
        return self._assign(
            "speaker", str(group.get("group_id", "")), observations,
            clip_id=str(member.get("clip_id", "") or ""), threshold=self.speaker_threshold,
        )

    def _state_version(self, kind: str) -> str:
        if kind == "face":
            return (
                "face-v2|" + FACE_DETECTOR.sha256[:12] + "|" + FACE_RECOGNIZER.sha256[:12]
                + f"|{self.face_threshold:.3f}|{self.frames_per_camera}"
            )
        return (
            "speaker-v2|" + SPEAKER_SEGMENTER.sha256[:12] + "|" + SPEAKER_EMBEDDER.sha256[:12]
            + f"|{self.speaker_threshold:.3f}"
        )

    def run(self, kind: str, **kwargs: Any) -> dict[str, Any]:
        if kind == "face" and self.face_provider is None:
            self.face_provider = FaceEmbeddingProvider()
        if kind == "speaker" and self.speaker_provider is None:
            self.speaker_provider = SpeakerEmbeddingProvider()
        result = super().run(kind, **kwargs)
        if int(result.get("observations", 0) or 0) > 0:
            try:
                apply_identity_rescue(self.config)
            except Exception:
                pass
        return result
