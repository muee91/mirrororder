from __future__ import annotations

import os
import math
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


def _finite_float(raw: object, default: float, name: str, *, minimum: float | None = None, maximum: float | None = None) -> float:
    try:
        value = float(default if raw is None else raw)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name}必须是数字") from error
    if not math.isfinite(value):
        raise ValueError(f"{name}必须是有限数字")
    if minimum is not None and value < minimum:
        raise ValueError(f"{name}不能小于 {minimum}")
    if maximum is not None and value > maximum:
        raise ValueError(f"{name}不能大于 {maximum}")
    return value


def _bounded_int(raw: object, default: int, name: str, *, minimum: int, maximum: int) -> int:
    try:
        value = int(default if raw is None else raw)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name}必须是整数") from error
    if value < minimum or value > maximum:
        raise ValueError(f"{name}必须在 {minimum} 到 {maximum} 之间")
    return value


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
    media_roots: tuple[Path, ...] = ()
    camera_patterns: dict[str, str] = field(default_factory=dict)
    media_timeline_mode: str = "sequential"
    asr_backend: str = "auto"
    asr_model: str = "small"
    asr_language: str = "zh"
    asr_device: str = "auto"
    asr_camera_priority: tuple[str, ...] = ("B", "C", "A")
    asr_ensure_preferred_camera: bool = True
    asr_escalate_ambiguous: bool = True
    asr_max_extra_cameras: int = 1
    asr_max_escalated_groups: int = 24
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
        configured_root = media.get("root") or inputs.get("media_root")
        media_root = _path(configured_root, base, base / "media") if configured_root else None
        raw_roots = media.get("roots", [])
        configured_roots = (
            tuple(
                _path(str(value), base, base / "media")
                for value in raw_roots
                if str(value).strip()
            )
            if isinstance(raw_roots, list)
            else ()
        )
        if not configured_roots and media_root is not None:
            configured_roots = (media_root,)
        if configured_roots:
            media_root = configured_roots[0]
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
            media_roots=configured_roots,
            camera_patterns={
                str(camera).upper(): str(pattern)
                for camera, pattern in camera_patterns.items()
                if str(camera).strip() and str(pattern).strip()
            } if isinstance(camera_patterns, dict) else {},
            media_timeline_mode=str(media.get("timeline_mode", "sequential")),
            asr_backend=str(asr.get("backend", "auto")),
            asr_model=str(asr.get("model", "small")),
            asr_language=str(asr.get("language", "zh")),
            asr_device=str(asr.get("device", "auto")),
            asr_camera_priority=tuple(str(value) for value in asr.get("camera_priority", ["B", "C", "A"])),
            asr_ensure_preferred_camera=bool(asr.get("ensure_preferred_camera", True)),
            asr_escalate_ambiguous=bool(asr.get("escalate_ambiguous", True)),
            asr_max_extra_cameras=max(0, int(asr.get("max_extra_cameras", 1))),
            asr_max_escalated_groups=max(0, int(asr.get("max_escalated_groups", 24))),
            minimum_overlap_seconds=_finite_float(multicam.get("minimum_overlap_seconds"), 0.5, "minimum_overlap_seconds", minimum=0.0),
            split_bridge_ratio=_finite_float(multicam.get("split_bridge_ratio"), 1.8, "split_bridge_ratio", minimum=0.0),
            shooting_block_gap_minutes=_finite_float(multicam.get("shooting_block_gap_minutes"), 20.0, "shooting_block_gap_minutes", minimum=0.0),
            high_confidence=_finite_float(matching.get("high_confidence"), 0.82, "high_confidence", minimum=0.0, maximum=1.0),
            possible_confidence=_finite_float(matching.get("possible_confidence"), 0.65, "possible_confidence", minimum=0.0, maximum=1.0),
            minimum_margin=_finite_float(matching.get("minimum_margin"), 0.08, "minimum_margin", minimum=0.0, maximum=1.0),
            max_candidates=_bounded_int(matching.get("max_candidates"), 5, "max_candidates", minimum=1, maximum=1000),
            max_transcript_windows=_bounded_int(matching.get("max_transcript_windows"), 120, "max_transcript_windows", minimum=1, maximum=10000),
            max_window_candidates=_bounded_int(matching.get("max_window_candidates"), 80, "max_window_candidates", minimum=1, maximum=10000),
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
