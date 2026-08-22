from __future__ import annotations

import json
import csv
from pathlib import Path

from .config import ProjectConfig
from .fcpxml_reader import build_multicam_groups, read_fcpxml
from .script_parser import parse_script
from .transcript import TranscriptStore
from .review_store import ReviewStore


def import_legacy(config: ProjectConfig, source: str | Path, target: str | Path | None = None) -> Path:
    """Convert old JSON or CSV candidate exports into group overrides once."""
    source_path = Path(source)
    if source_path.suffix.lower() == ".csv":
        clips_payload: dict[str, dict] = {}
        with source_path.open(encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                name = str(row.get("素材文件名", "")).strip()
                label = str(row.get("剧集", "")).strip()
                if not name or not label.startswith("第"):
                    continue
                digits = "".join(character for character in label if character.isdigit())
                if not digits:
                    continue
                entry = clips_payload.setdefault(name, {"episodes": [], "reason": "legacy CSV candidate; no script line was supplied"})
                if int(digits) not in entry["episodes"]:
                    entry["episodes"].append(int(digits))
        payload = {"clips": clips_payload}
    else:
        with source_path.open(encoding="utf-8") as handle:
            payload = json.load(handle)
    clips = read_fcpxml(config.fcpxml)
    groups = build_multicam_groups(clips, config.minimum_overlap_seconds, config.split_bridge_ratio)
    clip_to_group = {member.name: group for group in groups for member in group.members}
    script = parse_script(config.script)
    by_episode_line = {(segment.episode, segment.order): segment.segment_id for segment in script.segments}
    group_overrides: dict[str, dict] = {}
    for name, item in (payload.get("clips", {}) if isinstance(payload, dict) else {}).items():
        if not isinstance(item, dict):
            continue
        group = clip_to_group.get(name)
        if not group:
            continue
        override = group_overrides.setdefault(
            group.group_id,
            {"script_segment_ids": [], "context_episodes": [], "evidence": []},
        )
        for episode in item.get("episodes", []) if isinstance(item.get("episodes", []), list) else []:
            try:
                episode_number = int(episode)
            except (TypeError, ValueError):
                continue
            if episode_number not in override["context_episodes"]:
                override["context_episodes"].append(episode_number)
        for match in item.get("script_matches", []):
            if not isinstance(match, dict):
                continue
            segment_id = by_episode_line.get((int(match.get("episode", 0)), int(match.get("line", 0))))
            if segment_id and segment_id not in override["script_segment_ids"]:
                override["script_segment_ids"].append(segment_id)
        reason = str(item.get("reason", "") or "")
        if reason and reason not in override["evidence"]:
            override["evidence"].append(reason)
    result = {"version": 1, "source": str(source), "groups": group_overrides}
    output = Path(target) if target else (config.compat_overrides or config.project_dir / "legacy_overrides.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    return output


def import_transcripts(config: ProjectConfig, source: str | Path) -> dict[str, int]:
    """Migrate name-keyed legacy ASR JSON into fingerprint-keyed project cache."""
    source_dir = Path(source)
    clips = read_fcpxml(config.fcpxml)
    store = TranscriptStore(config.transcript_dir)
    imported = 0
    skipped = 0
    for clip in clips:
        path = source_dir / f"{clip.name}.json"
        if not path.exists():
            skipped += 1
            continue
        try:
            with path.open(encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, ValueError):
            skipped += 1
            continue
        if not isinstance(payload, dict):
            skipped += 1
            continue
        store.write(
            clip,
            str(payload.get("text", "") or ""),
            payload.get("segments", []) if isinstance(payload.get("segments", []), list) else [],
            backend=str(payload.get("backend", "legacy-cache")),
        )
        imported += 1
    return {"imported": imported, "skipped": skipped}


def import_legacy_review(config: ProjectConfig, source: str | Path) -> dict[str, int]:
    """Map the old HTML export into the permanent group/clip review store."""
    with Path(source).open(encoding="utf-8") as handle:
        payload = json.load(handle)
    clips = read_fcpxml(config.fcpxml)
    groups = build_multicam_groups(clips, config.minimum_overlap_seconds, config.split_bridge_ratio)
    by_name = {clip.name: clip for clip in clips}
    group_by_name = {member.name: group for group in groups for member in group.members}
    store = ReviewStore(config.output_dir / "review.json")
    review = store.load()
    imported = 0
    skipped = 0
    for item in payload.get("items", []) if isinstance(payload, dict) else []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", ""))
        clip = by_name.get(name)
        group = group_by_name.get(name)
        if not clip or not group:
            skipped += 1
            continue
        state = "reject" if item.get("hidden") else "unreviewed"
        entry = {"state": state, "method": "manual", "legacy_source": str(source)}
        if item.get("manual_episode"):
            entry["episodes"] = [int(item["manual_episode"])]
        entry["legacy_group_id"] = item.get("group_id", "")
        review["groups"][group.group_id] = entry
        review["clips"][clip.clip_id] = {"state": state, "method": "manual", "legacy_source": str(source)}
        imported += 1
    store.save(review)
    return {"imported": imported, "skipped": skipped}
