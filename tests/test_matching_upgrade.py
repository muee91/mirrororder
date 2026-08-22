from __future__ import annotations

import sys
from dataclasses import replace
from fractions import Fraction
from types import SimpleNamespace

from script_organizer.alignment import align_block
from script_organizer.config import ProjectConfig
from script_organizer.matcher import build_script_window_index, match_group
from script_organizer.models import Candidate, GroupMember, MulticamGroup, ScriptSegment, Transcript, TranscriptSegment


def _config(tmp_path):
    return ProjectConfig(
        tmp_path / "project.toml",
        "test",
        tmp_path / "input.fcpxml",
        tmp_path / "script.docx",
        tmp_path / "out",
        tmp_path / "cache",
    )


def _group(group_id: str, clip_id: str = "b1", camera: str = "B") -> MulticamGroup:
    member = GroupMember(
        clip_id,
        camera,
        f"{camera}001",
        "",
        Fraction(0),
        Fraction(30),
        Fraction(30),
        True,
    )
    return MulticamGroup(group_id, 0, 30, (member,), (camera,), "single-camera")


def _candidate(group_id: str, ids: tuple[str, ...], score: float = 0.9) -> Candidate:
    return Candidate(
        group_id=group_id,
        script_segment_id=ids[-1],
        total_score=score,
        dialogue_score=score,
        sequence_score=score,
        context_score=0.0,
        margin=0.2,
        method="dialogue_window",
        confidence="exact_dialogue",
        script_segment_ids=ids,
    )


def test_multiline_script_window_beats_independent_short_lines(tmp_path):
    script = [
        ScriptSegment("s1", 19, "19-03", 1, "dialogue", "李梦", "王总，你怎么来了？", ""),
        ScriptSegment("s2", 19, "19-03", 2, "dialogue", "王总", "听说这里的牛肉三百八一斤？", ""),
        ScriptSegment("s3", 21, "21-01", 1, "dialogue", "路人", "王总你怎么来了？", ""),
    ]
    transcript = Transcript(
        "b1",
        "B001",
        "f",
        "王总你咋来了我听说这里牛肉卖三百八",
        (TranscriptSegment(2.0, 7.0, "王总你咋来了我听说这里牛肉卖三百八"),),
    )
    config = _config(tmp_path)
    result = match_group(
        _group("g1"),
        {"b1": transcript},
        script,
        config,
        build_script_window_index(script),
    )
    assert result
    assert any(candidate.script_segment_ids == ("s1", "s2") for candidate in result)
    multiline = next(candidate for candidate in result if candidate.script_segment_ids == ("s1", "s2"))
    assert multiline.method == "dialogue_window"
    assert multiline.confidence in {"exact_dialogue", "possible_dialogue"}


def test_range_alignment_advances_from_range_end_not_range_start():
    script = [
        ScriptSegment(f"s{index}", 1, "1-1", index, "dialogue", "", f"台词{index}", "")
        for index in range(1, 9)
    ]
    groups = [_group("g1"), _group("g2", "b2"), _group("g3", "b3")]
    candidates = {
        "g1": [_candidate("g1", ("s1", "s2", "s3", "s4"), 0.92)],
        "g2": [
            _candidate("g2", ("s2",), 0.91),
            _candidate("g2", ("s5", "s6"), 0.88),
        ],
        "g3": [_candidate("g3", ("s7", "s8"), 0.90)],
    }
    selected = align_block(groups, candidates, script)
    assert selected["g1"].script_segment_ids == ("s1", "s2", "s3", "s4")
    assert selected["g2"].script_segment_ids == ("s5", "s6")
    assert selected["g3"].script_segment_ids == ("s7", "s8")


def test_range_alignment_allows_repeated_take_for_same_range():
    script = [
        ScriptSegment(f"s{index}", 1, "1-1", index, "dialogue", "", f"台词{index}", "")
        for index in range(1, 6)
    ]
    groups = [_group("g1"), _group("g2", "b2"), _group("g3", "b3")]
    span = ("s2", "s3", "s4")
    selected = align_block(
        groups,
        {
            "g1": [_candidate("g1", span, 0.93)],
            "g2": [_candidate("g2", span, 0.91)],
            "g3": [_candidate("g3", span, 0.90)],
        },
        script,
    )
    assert all(selected[group.group_id].script_segment_ids == span for group in groups)


def test_known_text_alignment_reuses_loaded_model_and_persistent_result(monkeypatch, tmp_path):
    from script_organizer import known_text_alignment

    calls = {"loads": 0, "aligns": 0}

    class FakeModel:
        def align(self, _path, _text, language="zh"):
            assert language == "zh"
            calls["aligns"] += 1
            return SimpleNamespace(segments=[SimpleNamespace(start=1.0, end=2.0, text="你好")])

    def load_model(_name):
        calls["loads"] += 1
        return FakeModel()

    monkeypatch.setenv("MIRRORORDER_ALIGNMENT_CACHE_DIR", str(tmp_path / "alignment-cache"))
    monkeypatch.setitem(sys.modules, "stable_whisper", SimpleNamespace(load_model=load_model))
    known_text_alignment._load_model.cache_clear()
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"fake")

    first = known_text_alignment.align_known_text(audio, "你好", "base")
    cached = known_text_alignment.align_known_text(audio, "你好", "base")
    second = known_text_alignment.align_known_text(audio, "再见", "base")

    assert first["status"] == "success" and first["cached"] is False
    assert cached["status"] == "success" and cached["cached"] is True
    assert second["status"] == "success" and second["cached"] is False
    assert calls == {"loads": 1, "aligns": 2}


def _two_camera_fixture(tmp_path):
    from script_organizer.fcpxml_reader import build_multicam_groups, read_fcpxml

    media_b = tmp_path / "B001.mov"
    media_c = tmp_path / "C001.mov"
    media_b.write_bytes(b"b")
    media_c.write_bytes(b"c")
    fcpxml = tmp_path / "input.fcpxml"
    fcpxml.write_text(
        f'''<?xml version="1.0"?><fcpxml version="1.8"><resources>
        <asset id="b" src="file://{media_b}"/><asset id="c" src="file://{media_c}"/>
        </resources><library><event><project><sequence><spine>
        <asset-clip name="B001" ref="b" lane="1" offset="0s" duration="20s"/>
        <asset-clip name="C001" ref="c" lane="2" offset="0s" duration="20s"/>
        </spine></sequence></project></event></library></fcpxml>''',
        encoding="utf-8",
    )
    script = tmp_path / "script.txt"
    script.write_text(
        "第19集\n19-03 饭店 内 日\n李梦：王总，你怎么来了？\n王总：听说这里的牛肉三百八一斤？\n",
        encoding="utf-8",
    )
    clips = read_fcpxml(fcpxml)
    groups = build_multicam_groups(clips, 0.5, 1.8)
    return fcpxml, script, clips, groups


def test_ambiguous_take_transcribes_one_extra_camera_and_uses_it_for_alignment(monkeypatch, tmp_path):
    from script_organizer import material_index
    from script_organizer.transcript import TranscriptStore

    fcpxml, script, clips, _groups = _two_camera_fixture(tmp_path)
    b_clip = next(clip for clip in clips if clip.name == "B001")
    TranscriptStore(tmp_path / "cache").write(
        b_clip,
        "王总你来了",
        [{"start": 1.0, "end": 2.0, "text": "王总你来了"}],
        backend="test",
    )

    class FakeWhisperModel:
        def __init__(self, *args, **kwargs):
            pass

        def transcribe(self, path, **kwargs):
            assert str(path).endswith("C001.mov")
            segment = SimpleNamespace(
                start=2.0,
                end=7.0,
                text="王总你怎么来了听说这里的牛肉三百八一斤",
                words=[],
            )
            return [segment], SimpleNamespace()

    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=FakeWhisperModel))
    aligned_paths = []

    def fake_align(path, text, model_name):
        aligned_paths.append(str(path))
        return {"method": "stable-ts", "status": "success", "segments": []}

    monkeypatch.setattr(material_index, "align_known_text", fake_align)
    config = replace(
        _config(tmp_path),
        fcpxml=fcpxml,
        script=script,
        transcript_dir=tmp_path / "cache",
        asr_backend="faster-whisper",
        asr_camera_priority=("B", "C", "A"),
        asr_ensure_preferred_camera=True,
        asr_escalate_ambiguous=True,
        asr_max_extra_cameras=1,
        enable_known_text_alignment=True,
    )
    result = material_index.analyze(config)

    assert result["index"]["stats"]["asr_escalated_groups"] == 1
    assert result["index"]["stats"]["asr_escalated_clips"] == 1
    group_rows = list(result["matches"]["groups"].values())
    assert group_rows and group_rows[0]["candidates"]
    top = group_rows[0]["candidates"][0]
    assert top["transcript_clip_id"] == next(clip.clip_id for clip in clips if clip.name == "C001")
    assert aligned_paths and aligned_paths[0].endswith("C001.mov")


def test_reviewed_take_never_triggers_extra_camera_asr(monkeypatch, tmp_path):
    from script_organizer import material_index
    from script_organizer.review_store import ReviewStore
    from script_organizer.transcript import TranscriptStore

    fcpxml, script, clips, groups = _two_camera_fixture(tmp_path)
    b_clip = next(clip for clip in clips if clip.name == "B001")
    TranscriptStore(tmp_path / "cache").write(
        b_clip,
        "王总你来了",
        [{"start": 1.0, "end": 2.0, "text": "王总你来了"}],
        backend="test",
    )
    ReviewStore(tmp_path / "out" / "review.json").save(
        {
            "version": 2,
            "groups": {groups[0].group_id: {"state": "keep", "method": "manual"}},
            "assignments": {},
            "clips": {},
            "placements": {},
        }
    )

    class FakeWhisperModel:
        def __init__(self, *args, **kwargs):
            pass

        def transcribe(self, path, **kwargs):
            raise AssertionError(f"reviewed Take must not trigger rescue ASR: {path}")

    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(WhisperModel=FakeWhisperModel))
    config = replace(
        _config(tmp_path),
        fcpxml=fcpxml,
        script=script,
        transcript_dir=tmp_path / "cache",
        asr_backend="faster-whisper",
        asr_camera_priority=("B", "C", "A"),
        asr_ensure_preferred_camera=True,
        asr_escalate_ambiguous=True,
        asr_max_extra_cameras=1,
    )
    result = material_index.analyze(config)

    stats = result["index"]["stats"]
    assert stats["asr_escalation_attempted_groups"] == 0
    assert stats["asr_escalation_attempted_clips"] == 0
    assert stats["asr_escalation_skipped_reviewed_groups"] >= 1
