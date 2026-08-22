from __future__ import annotations

import json
import os
import tempfile
from dataclasses import replace
from pathlib import Path
from typing import Any

from .asr_runtime import ASRRuntime, script_asr_prompt
from .config import ProjectConfig
from .fcpxml_reader import build_multicam_groups, read_fcpxml
from .material_index import analyze as _analyze_core
from .media_reader import read_media_directory
from .review_store import ReviewStore
from .transcript import TranscriptStore


def generated_sync_fcpxml(config: ProjectConfig) -> Path:
    return config.output_dir / "sync" / "synchronized.fcpxml"


def effective_analysis_config(config: ProjectConfig) -> ProjectConfig:
    """Return a derived analysis view without changing the project's source identity."""
    generated = generated_sync_fcpxml(config)
    if config.is_media_directory and generated.is_file():
        return replace(config, input_kind="fcpxml", fcpxml=generated, asr_backend="cache")
    return replace(config, asr_backend="cache")


def _write_json_atomic(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _clips_for(config: ProjectConfig):
    if config.is_fcpxml:
        if not config.fcpxml:
            raise ValueError("FCPXML 分析视图缺少 fcpxml")
        return read_fcpxml(config.fcpxml)
    if config.is_media_directory:
        if not config.media_root:
            raise ValueError("媒体目录项目缺少 media_root")
        return read_media_directory(config.media_root, config.camera_patterns, config.media_timeline_mode)
    raise ValueError(f"不支持的 input.kind: {config.input_kind}")


def _reviewed_group_ids(config: ProjectConfig) -> set[str]:
    review = ReviewStore(config.output_dir / "review.json").load()
    result = {str(value) for value in review.get("groups", {})}
    result.update(str(value) for value in review.get("placements", {}))
    for rows in review.get("assignments", {}).values():
        if isinstance(rows, dict):
            result.update(str(value) for value in rows)
    return result


def _decisive(candidate: dict[str, Any] | None, config: ProjectConfig) -> bool:
    if not isinstance(candidate, dict):
        return False
    return (
        candidate.get("confidence") in {"manual", "exact_dialogue"}
        and float(candidate.get("total_score", 0) or 0) >= config.high_confidence
        and float(candidate.get("dialogue_score", 0) or 0) >= 0.80
        and float(candidate.get("margin", 0) or 0) >= config.minimum_margin
    )


def _prefill_transcripts(
    source_config: ProjectConfig,
    analysis_config: ProjectConfig,
    runtime: ASRRuntime,
) -> tuple[dict[str, Any], list[str]]:
    if not runtime.enabled:
        return {"transcribed": 0, "backend": runtime.public()}, []
    clips = _clips_for(analysis_config)
    groups = build_multicam_groups(clips, source_config.minimum_overlap_seconds, source_config.split_bridge_ratio)
    store = TranscriptStore(source_config.transcript_dir)
    prompt = script_asr_prompt(source_config.script)
    priority = {camera: index for index, camera in enumerate(source_config.asr_camera_priority)}
    clip_by_id = {clip.clip_id: clip for clip in clips}
    errors: list[str] = []
    count = 0

    for group in groups:
        members = sorted(
            group.members,
            key=lambda member: (priority.get(member.camera, 999), -float(member.duration), member.name),
        )
        preferred = next((member for member in members if member.exists), None)
        if preferred is None:
            continue
        existing_any = any(store.load(clip_by_id[member.clip_id]) for member in members if member.exists)
        preferred_cached = store.load(clip_by_id[preferred.clip_id])
        if preferred_cached or (existing_any and not source_config.asr_ensure_preferred_camera):
            continue
        try:
            runtime.transcribe(clip_by_id[preferred.clip_id], store, prompt)
            count += 1
        except Exception as error:
            errors.append(f"{preferred.name}: {error}")
    return {"transcribed": count, "backend": runtime.public()}, errors


def _escalate_ambiguous(
    source_config: ProjectConfig,
    analysis_config: ProjectConfig,
    runtime: ASRRuntime,
    result: dict[str, Any],
) -> tuple[int, list[str]]:
    if not (
        runtime.enabled
        and source_config.asr_escalate_ambiguous
        and source_config.asr_max_extra_cameras > 0
        and source_config.asr_max_escalated_groups > 0
    ):
        return 0, []
    clips = _clips_for(analysis_config)
    groups = build_multicam_groups(clips, source_config.minimum_overlap_seconds, source_config.split_bridge_ratio)
    group_by_id = {group.group_id: group for group in groups}
    clip_by_id = {clip.clip_id: clip for clip in clips}
    store = TranscriptStore(source_config.transcript_dir)
    prompt = script_asr_prompt(source_config.script)
    priority = {camera: index for index, camera in enumerate(source_config.asr_camera_priority)}
    reviewed = _reviewed_group_ids(source_config)
    rows = result.get("matches", {}).get("groups", {}) if isinstance(result.get("matches"), dict) else {}
    changed = 0
    attempted_groups = 0
    errors: list[str] = []

    for group_id, row in rows.items() if isinstance(rows, dict) else []:
        if attempted_groups >= source_config.asr_max_escalated_groups:
            break
        group = group_by_id.get(str(group_id))
        if not group or group.group_id in reviewed or (group.parent_group_id and group.parent_group_id in reviewed):
            continue
        candidates = row.get("candidates", []) if isinstance(row, dict) else []
        if candidates and _decisive(candidates[0], source_config):
            continue
        members = sorted(
            group.members,
            key=lambda member: (priority.get(member.camera, 999), -float(member.duration), member.name),
        )
        pending = [
            member for member in members
            if member.exists and store.load(clip_by_id[member.clip_id]) is None
        ]
        if not pending:
            continue
        attempted_groups += 1
        for member in pending[: source_config.asr_max_extra_cameras]:
            try:
                runtime.transcribe(clip_by_id[member.clip_id], store, prompt)
                changed += 1
            except Exception as error:
                errors.append(f"{member.name}: {error}")
    return changed, errors


def _restore_source_identity(
    source_config: ProjectConfig,
    analysis_config: ProjectConfig,
    result: dict[str, Any],
    runtime: ASRRuntime,
    asr_errors: list[str],
) -> dict[str, Any]:
    index = result.get("index", {})
    if not isinstance(index, dict):
        return result
    generated = generated_sync_fcpxml(source_config)
    index["source"] = {
        "kind": source_config.input_kind,
        "fcpxml": str(source_config.fcpxml) if source_config.fcpxml else "",
        "media_root": str(source_config.media_root) if source_config.media_root else "",
        "script": str(source_config.script),
        "derived_fcpxml": str(generated) if source_config.is_media_directory and generated.is_file() else "",
        "analysis_input_kind": analysis_config.input_kind,
    }
    index.setdefault("stats", {})["asr_runtime"] = runtime.public()
    if asr_errors:
        errors = index.setdefault("errors", {})
        existing = errors.get("asr_backend_error", [])
        if not isinstance(existing, list):
            existing = []
        errors["asr_backend_error"] = list(dict.fromkeys(existing + asr_errors))[:40]
    _write_json_atomic(source_config.output_dir / "material_index.json", index)
    return result


def analyze(config: ProjectConfig, affected_group_ids: set[str] | None = None) -> dict[str, Any]:
    """Product analysis entrypoint.

    ASR is orchestrated outside the deterministic matcher. Apple Silicon uses
    MLX Whisper by default when backend=auto; the matcher itself reads cache-only.
    Generated synchronized FCPXML is a derived input and never rewrites the
    project's original media-directory identity.
    """
    config.ensure_output()
    analysis_config = effective_analysis_config(config)
    runtime = ASRRuntime.from_config(config)
    _prefill, errors = _prefill_transcripts(config, analysis_config, runtime)

    result = _analyze_core(analysis_config, affected_group_ids)
    escalated, escalation_errors = _escalate_ambiguous(config, analysis_config, runtime, result)
    errors.extend(escalation_errors)
    if escalated:
        # Re-run after new camera transcripts. Existing analysis caches make this
        # cheap while keeping the matching algorithm deterministic.
        result = _analyze_core(analysis_config, None)
    return _restore_source_identity(config, analysis_config, result, runtime, errors)
