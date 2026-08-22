from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


def _path(value: str | None, base: Path, default: Path) -> Path:
    if not value:
        return default
    expanded = os.path.expandvars(os.path.expanduser(str(value)))
    candidate = Path(expanded)
    return candidate if candidate.is_absolute() else (base / candidate).resolve()


@dataclass(frozen=True)
class ProjectConfig:
    config_path: Path
    name: str
    fcpxml: Path | None
    script: Path
    output_dir: Path
    transcript_dir: Path
    input_kind: str = "fcpxml"
    media_root: Path | None = None
    camera_patterns: dict[str, str] = field(default_factory=dict)
    media_timeline_mode: str = "sequential"
    asr_backend: str = "cache"
    asr_model: str = "small"
    asr_language: str = "zh"
    asr_device: str = "auto"
    asr_camera_priority: tuple[str, ...] = ("A", "B", "C")
    asr_ensure_preferred_camera: bool = False
    asr_escalate_ambiguous: bool = False
    asr_max_extra_cameras: int = 1
    minimum_overlap_seconds: float = 0.5
    split_bridge_ratio: float = 1.8
    shooting_block_gap_minutes: float = 20.0
    high_confidence: float = 0.82
    possible_confidence: float = 0.65
    minimum_margin: float = 0.08
    max_candidates: int = 5
    max_transcript_windows: int = 120
    max_window_candidates: int = 80
    enable_known_text_alignment: bool = False
    stable_ts_model: str = "base"
    compat_overrides: Path | None = None
    web_dir: Path | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_file(cls, path: str | Path) -> "ProjectConfig":
        config_path = Path(path).expanduser().resolve()
        with config_path.open("rb") as handle:
            raw = tomllib.load(handle)
        base = config_path.parent
        project = raw.get("project", {})
        inputs = raw.get("input", {})
        output = raw.get("output", {})
        asr = raw.get("asr", {})
        multicam = raw.get("multicam", {})
        matching = raw.get("matching", {})
        alignment = raw.get("alignment", {})
        compat = raw.get("compat", {})
        media = raw.get("media", {})
        input_kind = str(inputs.get("kind") or ("fcpxml" if inputs.get("fcpxml") else "media-directory"))
        fcpxml = _path(inputs.get("fcpxml"), base, base / "input.fcpxml") if inputs.get("fcpxml") else None
        media_root = _path(media.get("root") or inputs.get("media_root"), base, base / "media") if (media.get("root") or inputs.get("media_root")) else None
        camera_patterns = media.get("camera_patterns", {})
        return cls(
            config_path=config_path,
            name=str(project.get("name", config_path.stem)),
            fcpxml=fcpxml,
            script=_path(inputs.get("script"), base, base / "script.docx"),
            output_dir=_path(output.get("directory"), base, base / "output"),
            transcript_dir=_path(asr.get("transcript_dir"), base, base / "cache" / "transcripts"),
            input_kind=input_kind,
            media_root=media_root,
            camera_patterns={
                str(camera).upper(): str(pattern)
                for camera, pattern in camera_patterns.items()
                if str(camera).strip() and str(pattern).strip()
            } if isinstance(camera_patterns, dict) else {},
            media_timeline_mode=str(media.get("timeline_mode", "sequential")),
            asr_backend=str(asr.get("backend", "cache")),
            asr_model=str(asr.get("model", "small")),
            asr_language=str(asr.get("language", "zh")),
            asr_device=str(asr.get("device", "auto")),
            asr_camera_priority=tuple(str(value) for value in asr.get("camera_priority", ["A", "B", "C"])),
            asr_ensure_preferred_camera=bool(asr.get("ensure_preferred_camera", False)),
            asr_escalate_ambiguous=bool(asr.get("escalate_ambiguous", False)),
            asr_max_extra_cameras=max(0, int(asr.get("max_extra_cameras", 1))),
            minimum_overlap_seconds=float(multicam.get("minimum_overlap_seconds", 0.5)),
            split_bridge_ratio=float(multicam.get("split_bridge_ratio", 1.8)),
            shooting_block_gap_minutes=float(multicam.get("shooting_block_gap_minutes", 20.0)),
            high_confidence=float(matching.get("high_confidence", 0.82)),
            possible_confidence=float(matching.get("possible_confidence", 0.65)),
            minimum_margin=float(matching.get("minimum_margin", 0.08)),
            max_candidates=int(matching.get("max_candidates", 5)),
            max_transcript_windows=int(matching.get("max_transcript_windows", 120)),
            max_window_candidates=int(matching.get("max_window_candidates", 80)),
            enable_known_text_alignment=bool(alignment.get("known_text_alignment", False)),
            stable_ts_model=str(alignment.get("stable_ts_model", "base")),
            compat_overrides=_path(compat.get("overrides"), base, base / "legacy_overrides.json") if compat.get("overrides") else None,
            web_dir=_path(raw.get("web", {}).get("directory"), base, base / "web") if raw.get("web", {}).get("directory") else None,
            extra=raw,
        )

    @property
    def project_dir(self) -> Path:
        return self.config_path.parent

    def ensure_output(self) -> None:
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.transcript_dir.mkdir(parents=True, exist_ok=True)

    @property
    def is_fcpxml(self) -> bool:
        return self.input_kind == "fcpxml"

    @property
    def is_media_directory(self) -> bool:
        return self.input_kind == "media-directory"
