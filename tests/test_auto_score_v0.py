from __future__ import annotations

import json
import wave
from pathlib import Path

from script_organizer.config import ProjectConfig
from script_organizer.music.library import assets_from_index, index_music_library
from script_organizer.music.planner import build_music_briefs
from script_organizer.music.runtime import build_music_plan
from script_organizer.music.scoring import rank_candidates


def _write_wav(path: Path, seconds: float = 12.0) -> None:
    rate = 8000
    frames = int(rate * seconds)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\x00\x00" * frames)


def _project(tmp_path: Path) -> ProjectConfig:
    project = tmp_path / "project"
    project.mkdir()
    (project / "output").mkdir()
    script = project / "script.txt"
    script.write_text(
        "第1集\n"
        "1-1 室内 夜\n"
        "张三：我怀疑这里有秘密。\n"
        "△ 李四沉默。\n"
        "1-2 走廊 夜\n"
        "李四：快跑，有危险！\n",
        encoding="utf-8",
    )
    config = project / "project.toml"
    config.write_text(
        "[project]\nname = \"Auto Score Test\"\n"
        "[input]\nkind = \"fcpxml\"\nscript = \"./script.txt\"\n"
        "[output]\ndirectory = \"./output\"\n"
        "[asr]\ntranscript_dir = \"./cache/transcripts\"\n",
        encoding="utf-8",
    )
    return ProjectConfig.from_file(config)


def _library(tmp_path: Path) -> Path:
    root = tmp_path / "music"
    root.mkdir()
    _write_wav(root / "dark_suspense.wav")
    _write_wav(root / "restricted_action.wav")
    manifest = {
        "version": 1,
        "tracks": [
            {
                "path": "dark_suspense.wav",
                "title": "Dark Suspense",
                "tags": ["suspense", "mystery", "danger", "cinematic"],
                "moods": ["dark", "tense"],
                "energy": 0.52,
                "vocal_probability": 0.0,
                "sections": [
                    {"start": 0, "end": 6, "kind": "intro", "tags": ["mystery"]},
                    {"start": 6, "end": 12, "kind": "build", "tags": ["danger", "reveal"]},
                ],
                "license": {
                    "source": "owned",
                    "license_id": "owned-sync",
                    "commercial_use": True,
                    "sync_right": True,
                },
            },
            {
                "path": "restricted_action.wav",
                "title": "Restricted Action",
                "tags": ["danger", "action"],
                "energy": 0.9,
                "license": {
                    "source": "unknown",
                    "license_id": "noncommercial",
                    "commercial_use": False,
                    "sync_right": False,
                },
            },
        ],
    }
    (root / "music_library.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


def test_library_index_enforces_license_metadata(tmp_path: Path) -> None:
    payload = index_music_library(_library(tmp_path))
    assert payload["summary"]["tracks"] == 2
    assert payload["summary"]["eligible"] == 1
    assert payload["summary"]["unverified_or_restricted"] == 1


def test_rank_candidates_hard_gates_unlicensed_tracks(tmp_path: Path) -> None:
    config = _project(tmp_path)
    assets = assets_from_index(index_music_library(_library(tmp_path)))
    brief = build_music_briefs(config, episode=1)[0]
    candidates = rank_candidates(brief, assets, top_k=5)
    assert len(candidates) == 1
    selected_asset = next(item for item in assets if item.asset_id == candidates[0].asset_id)
    assert selected_asset.title == "Dark Suspense"
    assert candidates[0].source_end > candidates[0].source_start


def test_build_music_plan_writes_derived_artifacts_only(tmp_path: Path) -> None:
    config = _project(tmp_path)
    review = config.output_dir / "review.json"
    review.write_text('{"revision": 7}', encoding="utf-8")
    before = review.read_bytes()

    plan = build_music_plan(
        config,
        _library(tmp_path),
        episode=1,
        timeline_seconds=24,
        top_k=3,
        analysis_mode="off",
    )

    assert plan["contract"] == "auto-score.v1"
    assert plan["feature_level"] == "v0.2"
    assert plan["summary"]["cues"] == 2
    assert plan["summary"]["selected"] == 2
    assert plan["policy"]["license_gate"] is True
    assert "library_root" not in plan
    library_index = json.loads((config.output_dir / "music" / "library_index.json").read_text(encoding="utf-8"))
    assert "root" not in library_index
    assert (config.output_dir / "music" / "music_plan.json").is_file()
    assert review.read_bytes() == before
