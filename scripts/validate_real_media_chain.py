#!/usr/bin/env python3
"""Materialize and validate the five-step synthetic production chain.

The fixture intentionally keeps media bytes out of Git.  This script generates
small clips with ffmpeg, binds them by content identity from a moved root, then
drives the existing human placement, editorial decision, assembly, evidence,
FCPXML, and Premiere adapters.
"""

from __future__ import annotations

import argparse
import copy
import json
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIR = ROOT / "tests" / "fixtures" / "real-media-chain"
CHAIN_FIXTURE = FIXTURE_DIR / "chain.json"

if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

from script_organizer.assembly_timeline import build_assembly_timeline
from script_organizer.audit_engine import _analysis_revision, _mapping_for_group
from script_organizer.audit_store import AuditStore
from script_organizer.automation_store import AutomationStore
from script_organizer.config import ProjectConfig
from script_organizer.coverage_graph import build_coverage_graph
from script_organizer.editorial_store import EditorialStore
from script_organizer.evidence_contract import EvidenceItem, EvidenceProvenance, EvidenceSidecar, EvidenceSpan
from script_organizer.evidence_sidecar import write_sidecar_manifest
from script_organizer.fcpxml_exporter import build_selection_manifest, export
from script_organizer.media_identity import DeviceMediaStore, full_file_sha256, media_id_for_path
from script_organizer.nle_delivery import (
    TIMELINE_DELIVERY_CONTRACT,
    export_timeline_delivery,
    export_timeline_premiere_delivery,
)
from script_organizer.rough_cut_plan import build_rough_cut_plan
from script_organizer.review_store import ReviewStore
from script_organizer.script_supervisor_store import ScriptSupervisorStore


def _read_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"expected object JSON: {path}")
    return payload


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def _run(command: list[str]) -> None:
    completed = subprocess.run(command, cwd=ROOT, check=False, text=True, capture_output=True)
    if completed.returncode:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(f"command failed ({completed.returncode}): {' '.join(command)}\n{detail}")


def _probe(path: Path) -> dict[str, Any]:
    completed = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration:format_tags=creation_time",
            "-show_entries",
            "stream=index,codec_type,r_frame_rate,sample_rate,width,height:stream_tags=rotate,timecode",
            "-of",
            "json",
            str(path),
        ],
        check=False,
        text=True,
        capture_output=True,
    )
    if completed.returncode:
        raise RuntimeError(f"ffprobe failed for {path}: {completed.stderr.strip()}")
    return json.loads(completed.stdout or "{}")


def _assert_declared_metadata(spec: dict[str, Any], probe: dict[str, Any]) -> None:
    streams = [row for row in probe.get("streams", []) if isinstance(row, dict)]
    video = next((row for row in streams if row.get("codec_type") == "video"), None)
    if video is None:
        raise AssertionError(f"generated fixture has no video stream: {spec['file']}")
    rate = str(spec.get("frame_rate", "24"))
    expected_rate = rate if "/" in rate else f"{rate}/1"
    if str(video.get("r_frame_rate", "")) != expected_rate:
        raise AssertionError(
            f"frame rate mismatch for {spec['file']}: expected {expected_rate}, "
            f"got {video.get('r_frame_rate')}"
        )
    audio = spec.get("audio") if isinstance(spec.get("audio"), dict) else None
    audio_stream = next((row for row in streams if row.get("codec_type") == "audio"), None)
    if bool(audio) != bool(audio_stream):
        raise AssertionError(f"audio presence mismatch for {spec['file']}")
    if audio and str(audio_stream.get("sample_rate", "")) != str(audio["sample_rate"]):
        raise AssertionError(f"audio sample rate mismatch for {spec['file']}")
    if spec.get("timecode") and str(spec["timecode"]) not in json.dumps(probe, ensure_ascii=False):
        raise AssertionError(f"timecode metadata missing for {spec['file']}")
    if spec.get("rotate"):
        rotate_values = {
            str((row.get("tags") or {}).get(key, ""))
            for row in streams
            for key in ("rotate", "ROTATE")
        }
        if str(spec["rotate"]) not in rotate_values:
            raise AssertionError(f"rotation metadata missing for {spec['file']}")


def _materialize_media(specs: list[dict[str, Any]], media_root: Path) -> dict[str, dict[str, Any]]:
    media_root.mkdir(parents=True, exist_ok=True)
    materialized: dict[str, dict[str, Any]] = {}
    for index, spec in enumerate(specs):
        clip_id = str(spec["clip_id"])
        path = media_root / str(spec["file"])
        path.parent.mkdir(parents=True, exist_ok=True)
        rate = str(spec.get("frame_rate", "24"))
        audio = spec.get("audio") if isinstance(spec.get("audio"), dict) else None
        command = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size=320x180:rate={rate}",
        ]
        if audio:
            command.extend(
                [
                    "-f",
                    "lavfi",
                    "-i",
                    f"sine=frequency={440 + index * 37}:sample_rate={audio['sample_rate']}",
                ]
            )
        command.extend(["-t", str(spec["duration"]), "-map", "0:v:0"])
        if audio:
            command.extend(["-map", "1:a:0"])
        command.extend(["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-r", rate])
        if audio:
            command.extend(["-c:a", str(audio.get("codec", "aac")), "-ar", str(audio["sample_rate"])])
        if spec.get("timecode"):
            command.extend(["-timecode", str(spec["timecode"])])
        # Matroska retains this tag as ROTATE=90 while MOV/MP4 may normalize it
        # into side data. It is intentionally just metadata evidence here.
        if spec.get("rotate"):
            command.extend(["-metadata:s:v:0", f"rotate={int(spec['rotate'])}"])
        command.append(str(path))
        _run(command)
        probe = _probe(path)
        _assert_declared_metadata(spec, probe)
        materialized[clip_id] = {
            "path": path,
            "probe": probe,
            "media_id": media_id_for_path(path),
            "full_file_sha256": full_file_sha256(path),
        }
    return materialized


def _asset_id(clip_id: str) -> str:
    return f"asset_{clip_id}"


def _source_fcpxml(specs: list[dict[str, Any]], materialized: dict[str, dict[str, Any]], destination: Path) -> None:
    root = ET.Element("fcpxml", {"version": "1.11"})
    resources = ET.SubElement(root, "resources")
    ET.SubElement(
        resources,
        "format",
        {
            "id": "r1",
            "name": "FFVideoFormat1080p24",
            "frameDuration": "1/24s",
            "width": "320",
            "height": "180",
        },
    )
    for spec in specs:
        clip_id = str(spec["clip_id"])
        audio = spec.get("audio") if isinstance(spec.get("audio"), dict) else None
        path = Path(materialized[clip_id]["path"])
        asset = ET.SubElement(
            resources,
            "asset",
            {
                "id": _asset_id(clip_id),
                "name": path.name,
                "start": "0s",
                "duration": f"{spec['duration']}s",
                "format": "r1",
                "hasVideo": "1",
                "hasAudio": "1" if audio else "0",
                **({"audioRate": f"{audio['sample_rate']}"} if audio else {}),
            },
        )
        ET.SubElement(asset, "media-rep", {"kind": "original-media", "src": path.resolve().as_uri()})

    library = ET.SubElement(root, "library")
    event = ET.SubElement(library, "event", {"name": "Synthetic Source"})
    project = ET.SubElement(event, "project", {"name": "Synthetic Source"})
    sequence = ET.SubElement(
        project,
        "sequence",
        {"format": "r1", "duration": "10s", "tcStart": "0s", "tcFormat": "NDF"},
    )
    ET.SubElement(sequence, "spine")
    for spec in specs:
        clip_id = str(spec["clip_id"])
        ET.SubElement(
            event,
            "asset-clip",
            {
                "name": Path(str(spec["file"])).stem,
                "ref": _asset_id(clip_id),
                "duration": f"{spec['duration']}s",
                "start": "0s",
            },
        )
    destination.write_bytes(ET.tostring(root, encoding="utf-8", xml_declaration=True))


def _build_index(
    base: dict[str, Any],
    specs: list[dict[str, Any]],
    materialized: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    spec_by_clip = {str(spec["clip_id"]): spec for spec in specs}
    clips: list[dict[str, Any]] = []
    groups = copy.deepcopy(base["groups"])
    for group in groups:
        group_start = float(group.get("start", 0.0) or 0.0)
        for member in group.get("members", []):
            clip_id = str(member["clip_id"])
            spec = spec_by_clip[clip_id]
            restored = materialized[clip_id]
            relative_source = f"ORIGINAL_CARD/{spec['file']}"
            row = {
                **member,
                "clip_id": clip_id,
                "media_id": restored["media_id"],
                "name": Path(str(spec["file"])).stem,
                "camera": spec["camera"],
                "source_asset_id": _asset_id(clip_id),
                "media_path": relative_source,
                "source_media_path": relative_source,
                "timeline_start": group_start,
                "timeline_end": group_start + float(member.get("duration", spec["duration"])),
                "exists": True,
            }
            member.clear()
            member.update(row)
            clips.append(row)
    return clips, groups


def _write_project_artifacts(
    output: Path,
    source_xml: Path,
    base: dict[str, Any],
    clips: list[dict[str, Any]],
    groups: list[dict[str, Any]],
    specs: list[dict[str, Any]],
    materialized: dict[str, dict[str, Any]],
) -> ProjectConfig:
    output.mkdir(parents=True, exist_ok=True)
    script_path = output / "script.txt"
    script_path.write_text("Synthetic five-step production chain.\n", encoding="utf-8")
    config_path = output / "project.toml"
    config_path.write_text(
        "[project]\nname = 'Real Media Chain'\n"
        "[input]\nkind = 'fcpxml'\nfcpxml = './source.fcpxml'\nscript = './script.txt'\n"
        "[output]\ndirectory = './output'\n[asr]\ntranscript_dir = './cache/transcripts'\n",
        encoding="utf-8",
    )
    project_output = output / "output"
    transcripts = output / "cache" / "transcripts"
    project_output.mkdir(parents=True, exist_ok=True)
    transcripts.mkdir(parents=True, exist_ok=True)
    _write_json(
        project_output / "material_index.json",
        {
            "version": 2,
            "project": "Real Media Chain",
            "clips": clips,
            "groups": groups,
            "stats": {"clips": len(clips), "groups": len(groups)},
        },
    )
    _write_json(project_output / "script.json", base["script"])
    _write_json(project_output / "matches.json", base["matches"])
    _write_json(
        project_output / "media_metadata.json",
        {
            "schema": "mirrororder.media_metadata.v1",
            "files": [
                {
                    "clip_id": str(spec["clip_id"]),
                    "file": str(spec["file"]),
                    "declared": {key: value for key, value in spec.items() if key not in {"clip_id", "file"}},
                    "media_id": str(materialized[str(spec["clip_id"])]["media_id"]),
                    "full_file_sha256": str(materialized[str(spec["clip_id"])]["full_file_sha256"]),
                    "ffprobe": materialized[str(spec["clip_id"])]["probe"],
                }
                for spec in specs
            ],
        },
    )
    AutomationStore(project_output).save("real-media-chain", base["automation"], {})

    review_store = ReviewStore(project_output / "review.json")
    for row in base["human_placements"]:
        review_store.apply_action(
            {
                "action": "set_group_placement",
                "group_id": row["group_id"],
                "episode_ids": row["episode_ids"],
                "script_segment_ids": row["script_segment_ids"],
                "actor": row["actor"],
                "interaction": "real_media_chain_fixture",
                "source_surface": "validator",
                "source_kind": "take",
            }
        )
    review = review_store.load()
    automation = AutomationStore(project_output).load()["groups"]
    revision = _analysis_revision(project_output)
    group_by_id = {str(group["group_id"]): group for group in groups}
    AuditStore(project_output).save(
        {
            "analysis_revision": revision,
            "review_revision": int(review.get("revision", 0) or 0),
            "summary": {"current_groups": len(base["audit"])},
            "groups": {
                group_id: {
                    "group_id": group_id,
                    "analysis_revision": revision,
                    "mapping": _mapping_for_group(review, automation[group_id], group_by_id[group_id]),
                    "judge": {"verdict": "agree", "confidence": 0.92, "reason": "synthetic chain evidence"},
                    "issues": [],
                    "shot_intelligence": {
                        "angles": {clip_id: {"clip_id": clip_id, **facts} for clip_id, facts in raw["angles"].items()}
                    },
                    "rough_cut": raw["rough_cut"],
                    "role_suggestions": [],
                }
                for group_id, raw in base["audit"].items()
            },
        }
    )

    slate = ScriptSupervisorStore(project_output)
    slate_revision = int(slate.load()["revision"])
    for row in base["slate"]:
        saved = slate.apply(
            {
                "group_id": row["group_id"],
                "expected_revision": slate_revision,
                "actor": row["actor"],
                "entry": row["entry"],
            }
        )
        slate_revision = int(saved["revision"])
    editorial = EditorialStore(project_output)
    editorial.apply_opinion(
        {
            "target_kind": "group",
            "group_id": "G_E1_SC1_T2",
            "state": "best",
            "actor": "Reviewer A",
            "reviewer_id": "reviewer-a",
        }
    )
    for row in base["editorial_decisions"]:
        current = editorial.load()
        editorial.apply_decision(
            {
                "target_kind": "group",
                "group_id": row["group_id"],
                "state": row["state"],
                "actor": row["actor"],
                "expected_revision": int(current["revision"]),
            }
        )

    sidecars: list[EvidenceSidecar] = []
    group_for_clip = {
        str(member["clip_id"]): str(group["group_id"])
        for group in groups
        for member in group.get("members", [])
    }
    for spec in specs:
        clip_id = str(spec["clip_id"])
        media = materialized[clip_id]
        sidecars.append(
            EvidenceSidecar(
                asset_id=str(media["media_id"]),
                content_hash=str(media["media_id"]),
                full_file_sha256=str(media["full_file_sha256"]),
                display_name=Path(str(spec["file"])).name,
                duration_seconds=float(spec["duration"]),
                source_timecode=str(spec.get("timecode") or "") or None,
                take_id=group_for_clip.get(clip_id),
                multicam_group_id=group_for_clip.get(clip_id),
                items=(
                    EvidenceItem(
                        kind="transcript",
                        value="门开了。",
                        span=EvidenceSpan(1.0, 2.0, source_timecode=spec.get("timecode")),
                        speaker="林夏",
                        provenance=EvidenceProvenance("synthetic-fixture", "none", "1"),
                    ),
                ),
            )
        )
    write_sidecar_manifest(project_output, sidecars, revision=revision)

    return ProjectConfig(
        config_path=config_path,
        name="Real Media Chain",
        fcpxml=source_xml,
        script=script_path,
        output_dir=project_output,
        transcript_dir=transcripts,
        input_kind="fcpxml",
    )


class _Project:
    def __init__(self, config: ProjectConfig, project_id: str, workspace_id: str):
        self.config = config
        self.project_id = project_id
        self.workspace_id = workspace_id
        self.reload()

    def reload(self) -> None:
        self.index = _read_json(self.config.output_dir / "material_index.json")
        self.script = _read_json(self.config.output_dir / "script.json")
        self.matches = _read_json(self.config.output_dir / "matches.json")

    def reload_if_changed(self) -> bool:
        self.reload()
        return False


def _timeline_request(config: ProjectConfig, clips: list[dict[str, Any]]) -> dict[str, Any]:
    by_id = {str(row["clip_id"]): row for row in clips}
    a, b = by_id["C_E1_SC1_T1_A"], by_id["C_E1_SC1_T1_B"]
    return {
        "contract": TIMELINE_DELIVERY_CONTRACT,
        "authority": {"generation": "fixture-generation", "revision": 1},
        "timeline": {
            "version": 2,
            "project_id": "real-media-chain",
            "sources": [
                {
                    "source_id": "source:a",
                    "clip_id": a["clip_id"],
                    "media_id": a["media_id"],
                    "name": a["name"],
                    "duration_frames": 240,
                },
                {
                    "source_id": "source:b",
                    "clip_id": b["clip_id"],
                    "media_id": b["media_id"],
                    "name": b["name"],
                    "duration_frames": 240,
                },
            ],
            "multicam_groups": [
                {
                    "group_id": "timeline-g1",
                    "angle_source_ids": ["source:a", "source:b"],
                    "angles": [
                        {
                            "source_id": "source:a",
                            "camera": "A",
                            "name": a["name"],
                            "sync_start_frame": 0,
                            "sync_end_frame": 240,
                        },
                        {
                            "source_id": "source:b",
                            "camera": "B",
                            "name": b["name"],
                            "sync_start_frame": 0,
                            "sync_end_frame": 240,
                        },
                    ],
                    "reference_source_id": "source:a",
                    "audio_source_id": "source:a",
                }
            ],
            "sequences": [
                {
                    "sequence_id": "main",
                    "name": "Real Media Chain",
                    "frame_rate": {"numerator": 24, "denominator": 1},
                    "tracks": [
                        {
                            "track_id": "V1",
                            "kind": "video",
                            "clips": [
                                {
                                    "clip_id": "timeline-c1",
                                    "source_id": "source:a",
                                    "timeline_start": 0,
                                    "source_in": 0,
                                    "duration": 72,
                                    "enabled": True,
                                    "multicam_group_id": None,
                                    "selected_angle_source_id": None,
                                    "metadata": {},
                                },
                                {
                                    "clip_id": "timeline-c2",
                                    "source_id": "source:a",
                                    "timeline_start": 96,
                                    "source_in": 96,
                                    "duration": 48,
                                    "enabled": True,
                                    "multicam_group_id": "timeline-g1",
                                    "selected_angle_source_id": "source:b",
                                    "metadata": {"group_id": "G_E1_SC1_T1"},
                                },
                            ],
                        },
                        {
                            "track_id": "A1",
                            "kind": "audio",
                            "clips": [
                                {
                                    "clip_id": "timeline-a1",
                                    "source_id": "source:a",
                                    "timeline_start": 0,
                                    "source_in": 0,
                                    "duration": 120,
                                    "enabled": True,
                                    "multicam_group_id": None,
                                    "selected_angle_source_id": None,
                                    "metadata": {"audio_role": "production_audio"},
                                },
                            ],
                        },
                    ],
                    "markers": [
                        {
                            "marker_id": "fixture-marker",
                            "position": 24,
                            "duration": 0,
                            "kind": "script",
                            "label": "E1_SC1_S1",
                            "metadata": {"segment_id": "E1_SC1_S1"},
                        }
                    ],
                    "transitions": [],
                }
            ],
            "active_sequence_id": "main",
        },
    }


def validate(output: Path) -> dict[str, Any]:
    chain = _read_json(CHAIN_FIXTURE)
    if chain.get("contract") != "mirrororder.real_media_chain.v1":
        raise ValueError("unexpected chain fixture contract")
    base = _read_json((FIXTURE_DIR / str(chain["base_scenario"])).resolve())
    specs = list(chain["media"])
    media_root = output / "restored-media"
    materialized = _materialize_media(specs, media_root)
    source_xml = output / "source.fcpxml"
    _source_fcpxml(specs, materialized, source_xml)
    clips, groups = _build_index(base, specs, materialized)
    config = _write_project_artifacts(output, source_xml, base, clips, groups, specs, materialized)
    project = _Project(config, str(chain["project_id"]), str(chain["workspace_id"]))

    # Device recovery is content based: the shared index keeps relative
    # ORIGINAL_CARD names while the actual files live under restored-media.
    store = DeviceMediaStore(output / "device-state" / "media-bindings.json")
    summary = store.scan(project.workspace_id, project.project_id, project.index, [str(media_root)], replace=True)
    if summary["resolved"] != len(clips) or summary["missing"] != 0:
        raise AssertionError(f"media recovery failed: {summary}")
    if any("/Volumes/" in str(row) or "/Users/" in str(row) for row in clips):
        raise AssertionError("fixture index unexpectedly contains an absolute device path")

    coverage = build_coverage_graph(project)
    plan = build_rough_cut_plan(project)
    assembly = build_assembly_timeline(project)
    assembly_scene = next(scene for scene in assembly["scenes"] if scene["scene_id"] == "E1_SC1")
    assembly_block = assembly_scene["blocks"][0]
    if assembly_block["angle"]["clip_id"] != "C_E1_SC1_T1_B" or assembly_block["usable_range"] != {
        "status": "manual",
        "start": 1.0,
        "end": 7.0,
        "duration": 6.0,
        "issues": [],
    }:
        raise AssertionError(f"assembly did not preserve slate facts: {assembly_block}")

    manifest = build_selection_manifest(config)
    classic_report = export(config)
    request = _timeline_request(config, clips)
    fcpx_report = export_timeline_delivery(config, request, expected_project_id=project.project_id)
    premiere_report = export_timeline_premiere_delivery(config, request, expected_project_id=project.project_id)

    sidecar_payload = _read_json(config.output_dir / "evidence.sidecar.json")
    sidecars = [EvidenceSidecar.from_dict(item) for item in sidecar_payload.get("sidecars", [])]
    if len(sidecars) != len(specs):
        raise AssertionError("evidence sidecar count does not match generated media")
    metadata_payload = _read_json(config.output_dir / "media_metadata.json")
    if (
        metadata_payload.get("schema") != "mirrororder.media_metadata.v1"
        or len(metadata_payload.get("files", [])) != len(specs)
    ):
        raise AssertionError("media metadata archive is incomplete")
    persisted = "\n".join(
        (config.output_dir / name).read_text(encoding="utf-8")
        for name in (
            "selection_manifest.json",
            "export_report.json",
            "timeline_delivery_report.json",
            "timeline_premiere_export_report.json",
            "evidence.sidecar.json",
        )
        if (config.output_dir / name).is_file()
    )
    if any(value in persisted for value in ("/Volumes/", "/Users/", "C:\\")):
        raise AssertionError("persisted decision/evidence reports leaked a device path")
    if fcpx_report["multicam_resource_count"] != 1 or premiere_report["multicam_source_sequence_written"] is not True:
        raise AssertionError("multicam structure was not preserved in both exports")

    return {
        "contract": chain["contract"],
        "output_dir": str(output),
        "media": {"generated": len(specs), "recovered": summary["resolved"], "missing": summary["missing"]},
        "metadata": {"schema": metadata_payload["schema"], "files": len(metadata_payload["files"])},
        "authority": {
            "placements": len(ReviewStore(config.output_dir / "review.json").load().get("placements", {})),
            "editorial_revision": EditorialStore(config.output_dir).load().get("revision", 0),
            "assembly_revision": assembly["revision"],
            "coverage_revision": coverage["revision"],
        },
        "evidence": {"sidecars": len(sidecars), "schema": sidecar_payload.get("schema")},
        "delivery": {
            "selection_manifest_version": manifest["version"],
            "classic_fcpxml_keywords": classic_report["keywords_written"],
            "timeline_fcpxml": fcpx_report["organized_fcpxml"],
            "premiere_xmeml": premiere_report["premiere_xmeml"],
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="where to materialize the synthetic project (default: a new /tmp directory)",
    )
    args = parser.parse_args(argv)
    for command in ("ffmpeg", "ffprobe"):
        if shutil.which(command) is None:
            parser.error(f"{command} is required to materialize this fixture")
    output = args.output_dir or Path(tempfile.mkdtemp(prefix="mirrororder-real-media-chain-"))
    if output.exists() and any(output.iterdir()):
        parser.error(f"output directory is not empty: {output} (choose a new path)")
    output.mkdir(parents=True, exist_ok=True)
    print(json.dumps(validate(output), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
