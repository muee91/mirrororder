from __future__ import annotations

import json
import wave
from pathlib import Path

from script_organizer.config import ProjectConfig
from script_organizer.music.generation import GeneratedTrack, prepare_generated_tracks, resolve_generation_provider
from script_organizer.music.models import MusicBrief
from script_organizer.music.runtime import build_music_plan


def _write_wav(path: Path, seconds: float = 12.0) -> None:
    rate = 8000
    frames = int(rate * seconds)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(b"\x00\x00" * frames)


def _project(tmp_path: Path) -> ProjectConfig:
    project = tmp_path / "project"
    project.mkdir(exist_ok=True)
    (project / "output").mkdir(exist_ok=True)
    script = project / "script.txt"
    script.write_text(
        "第1集\n"
        "1-1 室内 夜\n"
        "张三：快跑，他们发现我们了！\n"
        "△ 门外传来急促脚步声，危险正在逼近。\n",
        encoding="utf-8",
    )
    config = project / "project.toml"
    config.write_text(
        "[project]\nname = \"Auto Score Generate Test\"\n"
        "[input]\nkind = \"fcpxml\"\nscript = \"./script.txt\"\n"
        "[output]\ndirectory = \"./output\"\n"
        "[asr]\ntranscript_dir = \"./cache/transcripts\"\n",
        encoding="utf-8",
    )
    return ProjectConfig.from_file(config)


def _library(tmp_path: Path) -> Path:
    root = tmp_path / "music"
    root.mkdir(exist_ok=True)
    _write_wav(root / "calm.wav", 16)
    manifest = {
        "tracks": [
            {
                "path": "calm.wav",
                "title": "Calm Background",
                "tags": ["calm", "ambient", "warm"],
                "moods": ["peaceful"],
                "energy": 0.12,
                "vocal_probability": 0.25,
                "license": {
                    "source": "owned",
                    "license_id": "owned-sync",
                    "commercial_use": True,
                    "sync_right": True,
                },
            }
        ]
    }
    (root / "music_library.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


class _FakeProvider:
    name = "fake-generator"

    def generate(self, brief, output_dir: Path, *, count: int):
        result = []
        for index in range(count):
            target = output_dir / f"generated_{index + 1}.wav"
            _write_wav(target, max(12.0, brief.duration + 1.0))
            result.append(
                GeneratedTrack(
                    path=target,
                    provider=self.name,
                    model="fake-v1",
                    prompt="instrumental suspense danger underscore",
                    duration=max(12.0, brief.duration + 1.0),
                    seed=str(index + 1),
                )
            )
        return result


def test_generation_off_needs_no_provider() -> None:
    assert resolve_generation_provider("off") is None


def test_generated_sidecar_is_fail_closed_until_rights_confirmed(tmp_path: Path) -> None:
    audio = tmp_path / "generated.wav"
    _write_wav(audio)
    brief = MusicBrief(
        cue_id="cue-1",
        episode=1,
        scene_id="1-1",
        text="危险逼近",
        start=0,
        end=12,
        purpose="danger",
        tags=("danger", "suspense"),
        target_energy=0.8,
        dialogue_density=0.4,
    )
    track = GeneratedTrack(audio, "fake-generator", "fake-v1", "prompt", 12)
    prepare_generated_tracks([track], brief, rights_confirmed=False)
    sidecar = json.loads((tmp_path / "generated.wav.music.json").read_text(encoding="utf-8"))
    assert sidecar["license"]["commercial_use"] is False
    assert sidecar["license"]["sync_right"] is False
    assert sidecar["provenance"]["rights_confirmed"] is False


def test_unconfirmed_generated_music_is_scored_but_never_selected(tmp_path: Path, monkeypatch) -> None:
    config = _project(tmp_path)
    monkeypatch.setattr("script_organizer.music.runtime.resolve_generation_provider", lambda *args, **kwargs: _FakeProvider())

    plan = build_music_plan(
        config,
        _library(tmp_path),
        episode=1,
        timeline_seconds=12,
        analysis_mode="off",
        semantic_mode="off",
        generation_mode="auto",
        generation_threshold=1.0,
        generation_count=1,
        generated_rights_confirmed=False,
    )

    assert plan["feature_level"] == "v0.4"
    assert plan["summary"]["generation_cues"] == 1
    assert plan["summary"]["generated_tracks"] == 1
    assert plan["summary"]["generated_selected"] == 0
    generated = plan["cues"][0]["generated_alternatives"]
    assert generated
    assert generated[0]["eligible"] is False
    assert generated[0]["rejection_reason"] == "generated_rights_unconfirmed"
    assert plan["cues"][0]["asset"]["generated"] is False
    provenance = (config.output_dir / "music" / "provenance.jsonl").read_text(encoding="utf-8")
    assert '"rights_confirmed":false' in provenance


def test_confirmed_generated_music_reenters_normal_selection(tmp_path: Path, monkeypatch) -> None:
    config = _project(tmp_path)
    monkeypatch.setattr("script_organizer.music.runtime.resolve_generation_provider", lambda *args, **kwargs: _FakeProvider())

    plan = build_music_plan(
        config,
        _library(tmp_path),
        episode=1,
        timeline_seconds=12,
        analysis_mode="off",
        semantic_mode="off",
        generation_mode="auto",
        generation_threshold=1.0,
        generation_count=1,
        generated_rights_confirmed=True,
    )

    assert plan["policy"]["generated_rights_confirmed"] is True
    assert plan["summary"]["generation_cues"] == 1
    assert plan["summary"]["generated_selected"] == 1
    assert plan["cues"][0]["asset"]["generated"] is True
    assert plan["cues"][0]["asset"]["license"]["eligible"] is True
