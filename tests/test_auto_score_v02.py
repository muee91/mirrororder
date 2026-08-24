from __future__ import annotations

from script_organizer.music.analysis import detect_sections
from script_organizer.music.models import LicenseRecord, MusicAsset, MusicBrief, MusicSection
from script_organizer.music.scoring import score_candidate


def _licensed() -> LicenseRecord:
    return LicenseRecord(
        source="owned",
        license_id="owned-sync",
        commercial_use=True,
        sync_right=True,
    )


def test_detect_sections_snaps_energy_change_to_downbeat() -> None:
    curve = []
    for index in range(80):
        time_value = index * 0.5 + 0.25
        if time_value < 10:
            energy = 0.18
        elif time_value < 26:
            energy = 0.82
        else:
            energy = 0.30
        curve.append({"time": time_value, "value": energy})

    sections = detect_sections(40.0, curve, [0.0, 10.0, 20.0, 30.0, 40.0])

    assert len(sections) >= 2
    boundaries = {float(item["start"]) for item in sections} | {float(item["end"]) for item in sections}
    assert 10.0 in boundaries
    assert any(item["boundary_source"] == "energy+downbeat" for item in sections[1:])


def test_score_candidate_prefers_downbeat_window_with_matching_energy() -> None:
    brief = MusicBrief(
        cue_id="cue_001",
        episode=1,
        scene_id="1-1",
        text="危险逐渐逼近，准备揭示真相",
        start=0.0,
        end=8.0,
        purpose="reveal",
        tags=("danger", "reveal"),
        target_energy=0.82,
        dialogue_density=0.25,
    )
    asset = MusicAsset(
        asset_id="MU_test",
        path="test.wav",
        title="Danger Reveal",
        duration=32.0,
        tags=("danger", "reveal", "cinematic"),
        energy=0.5,
        sections=(
            MusicSection(0.0, 32.0, "build", ("danger", "reveal"), None, "metadata"),
        ),
        license=_licensed(),
        beats=tuple(float(value) for value in range(0, 33, 2)),
        downbeats=(0.0, 8.0, 16.0, 24.0, 32.0),
        energy_curve=tuple(
            (index + 0.25, 0.20 if index < 16 else (0.84 if index < 24 else 0.45))
            for index in range(32)
        ),
        analysis_source="ffmpeg-pcm-rms-v1+beat-this:cpu",
        analysis_version=2,
    )

    candidate = score_candidate(brief, asset)

    assert candidate.eligible is True
    assert candidate.beat_aligned is True
    assert candidate.source_start == 16.0
    assert candidate.source_end == 24.0
    assert candidate.boundary_source == "downbeat->downbeat"
    assert candidate.scores["boundary"] == 1.0
    assert candidate.scores["energy"] > 0.95


def test_score_candidate_falls_back_to_section_boundary_without_beats() -> None:
    brief = MusicBrief(
        cue_id="cue_002",
        episode=1,
        scene_id="1-2",
        text="安静的对白",
        start=0.0,
        end=6.0,
        purpose="underscore",
        tags=("cinematic",),
        target_energy=0.3,
        dialogue_density=0.9,
    )
    asset = MusicAsset(
        asset_id="MU_basic",
        path="basic.wav",
        title="Quiet Underscore",
        duration=20.0,
        tags=("cinematic", "underscore"),
        energy=0.3,
        sections=(MusicSection(4.0, 14.0, "section", (), 0.3, "energy"),),
        license=_licensed(),
        analysis_source="ffmpeg-pcm-rms-v1",
        analysis_version=2,
    )

    candidate = score_candidate(brief, asset)

    assert candidate.eligible is True
    assert candidate.beat_aligned is False
    assert candidate.source_start == 4.0
    assert candidate.source_end == 10.0
    assert candidate.boundary_source.startswith("energy->")
