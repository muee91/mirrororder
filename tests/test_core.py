from __future__ import annotations

import json
import hashlib
import zipfile
from pathlib import Path

from script_organizer.config import ProjectConfig
from script_organizer.alignment import align_block, split_shooting_blocks
from script_organizer.fcpxml_reader import build_multicam_groups, group_id_for, parse_time, read_fcpxml
from script_organizer.fcpxml_exporter import export
from script_organizer.matcher import context_only_candidate, match_group, normalize_text
from script_organizer.models import Clip, ScriptSegment
from script_organizer.review_store import ReviewStore, effective_group_state
from script_organizer.script_parser import parse_script
from script_organizer.transcript import TranscriptStore, media_fingerprint, slice_transcript


def test_fcpxml_rational_time_and_stable_group(tmp_path):
    assert parse_time("11000/50000s") == __import__("fractions").Fraction(11, 50)
    media_a = tmp_path / "A one.mov"
    media_b = tmp_path / "B.mov"
    media_c = tmp_path / "C.mov"
    for path in (media_a, media_b, media_c): path.write_bytes(b"x")
    xml = f'''<?xml version="1.0"?><fcpxml version="1.8"><resources>
      <asset id="a" src="file://{media_a}"/><asset id="b" src="file://{media_b}"/><asset id="c" src="file://{media_c}"/>
    </resources><library><event><project><sequence><spine>
      <asset-clip name="A001" ref="a" lane="1" offset="0s" duration="10s"/>
      <asset-clip name="A002" ref="c" lane="1" offset="5s" duration="10s"/>
      <asset-clip name="B001" ref="b" lane="2" offset="4s" duration="4s"/>
    </spine></sequence></project></event></library></fcpxml>'''
    path = tmp_path / "test.fcpxml"; path.write_text(xml)
    clips = read_fcpxml(path)
    groups = build_multicam_groups(clips, .5)
    assert len(groups) == 1
    assert groups[0].kind == "multicam"
    assert [member.name for member in groups[0].members] == ["A001", "B001", "A002"]
    assert group_id_for(clips[:2]) == group_id_for(clips[:2])


def _write_docx(path: Path, paragraphs: list[str]) -> None:
    body = "".join(f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>" for text in paragraphs)
    xml = f'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>'
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("word/document.xml", xml)


def test_script_parser_supports_multiple_scenes_and_unknown(tmp_path):
    path = tmp_path / "script.docx"
    _write_docx(path, ["第 19 集", "19-01 早餐店", "李梦：王总，你咋来了啊", "王总推门进来。", "19-02 门口", "△陈叶转身。"])
    document = parse_script(path)
    assert document.segments[0].scene_id == "19-01"
    assert document.segments[0].type == "scene_heading"
    assert any(segment.type == "dialogue" and segment.scene_id == "19-01" for segment in document.segments)
    assert document.segments[-1].scene_id == "19-02"


def test_script_parser_does_not_drop_unknown_scene(tmp_path):
    path = tmp_path / "script.docx"
    _write_docx(path, ["第1集", "李梦：你好"])
    assert parse_script(path).segments[0].scene_id == "UNKNOWN"


def test_dialogue_variant_matches_without_time_ratio(tmp_path):
    media = tmp_path / "A.mov"; media.write_bytes(b"x")
    clip = Clip("c1", "A", "A", str(media), 0, 10, 10, True)
    from script_organizer.models import GroupMember, MulticamGroup, Transcript, TranscriptSegment
    group = MulticamGroup("g1", 0, 10, (GroupMember("c1", "A", "A", str(media), 0, 10, 10, True),), ("A",), "single-camera")
    script = [ScriptSegment("E019-S1-L1", 19, "S1", 1, "dialogue", "王总", "王总，你怎么来了？", "王总，你怎么来了？")]
    transcript = Transcript("c1", "A", "f", "王总你咋来了啊", (TranscriptSegment(1, 3, "王总你咋来了啊"),))
    config = ProjectConfig(tmp_path / "project.toml", "x", tmp_path / "x.fcpxml", tmp_path / "x.docx", tmp_path / "out", tmp_path / "cache")
    result = match_group(group, {"c1": transcript}, script, config)
    assert result and result[0].script_segment_id == "E019-S1-L1"
    assert normalize_text("王总，你咋来了啊") == "王总你怎么来了啊"


def test_long_noisy_dialogue_below_possible_threshold_is_kept_for_review(tmp_path):
    from script_organizer.models import GroupMember, MulticamGroup, Transcript, TranscriptSegment

    media = tmp_path / "B.mov"; media.write_bytes(b"x")
    group = MulticamGroup(
        "noisy-long-dialogue",
        0,
        50,
        (GroupMember("b1", "B", "B001", str(media), 0, 50, 50, True),),
        ("B",),
        "single-camera",
    )
    script = [ScriptSegment(
        "E017-S17-L16", 17, "S17", 16, "dialogue", "陈叶",
        "兄弟，让你们回去避嫌是假，其实让你们回去调查是真。",
        "陈叶：兄弟，让你们回去避嫌是假，其实让你们回去调查是真。",
    )]
    transcript = Transcript(
        "b1", "B001", "f", "",
        (TranscriptSegment(5.1, 12.0, "兄弟我们一通我让你回去避嫌有些状态让你回去叫我"),),
    )
    config = ProjectConfig(tmp_path / "project.toml", "x", tmp_path / "x.fcpxml", tmp_path / "x.docx", tmp_path / "out", tmp_path / "cache")
    config = __import__("dataclasses").replace(config, possible_confidence=0.65)
    result = match_group(group, {"b1": transcript}, script, config)
    assert result and result[0].confidence == "possible_dialogue"


def test_multicam_take_merges_cross_episode_dialogue_range(tmp_path):
    from script_organizer.models import GroupMember, MulticamGroup, Transcript, TranscriptSegment

    group = MulticamGroup(
        "cross-episode",
        0,
        80,
        (
            GroupMember("b", "B", "B001", "", 0, 80, 80, True),
            GroupMember("a", "A", "A001", "", 0, 80, 80, True),
        ),
        ("A", "B"),
        "multicam",
    )
    script = [
        ScriptSegment("s16-32", 16, "S16", 32, "dialogue", "", "刚才我付了两万块钱，现在你们给我二十二万块，其中二十万块是赔偿，没问题吧", ""),
        ScriptSegment("s17-heading", 17, "S17", 1, "scene_heading", "", "17-1", ""),
        ScriptSegment("s17-2", 17, "S17", 2, "dialogue", "", "二十万就有点太夸张了吧！我就收了你两万而已啊！", ""),
        ScriptSegment("s17-3", 17, "S17", 3, "dialogue", "", "对啊，哪有吃顿饭赔偿二十万的道理啊！", ""),
    ]
    transcripts = {
        "b": Transcript(
            "b", "B001", "b", "",
            (TranscriptSegment(3.68, 9.5, "刚才我付了你两万现在你给我二十二其中的二十万是赔偿"),),
        ),
        "a": Transcript(
            "a", "A001", "a", "",
            (TranscriptSegment(21.5, 25.34, "对呀哪有吃的饭在20万的道理呀"),),
        ),
    }
    config = ProjectConfig(tmp_path / "project.toml", "x", tmp_path / "x.fcpxml", tmp_path / "x.docx", tmp_path / "out", tmp_path / "cache")
    result = match_group(group, transcripts, script, config)

    assert result
    assert result[0].script_segment_id == "s17-3"
    assert result[0].script_segment_ids == ("s16-32", "s17-2", "s17-3")
    assert result[0].method == "dialogue_sequence"


def test_cached_candidate_scene_heading_is_not_material_coverage():
    from script_organizer.material_index import _without_scene_headings
    from script_organizer.models import Candidate

    heading = ScriptSegment("heading", 23, "23-1", 1, "scene_heading", "", "23-1 饭店、外、日。人物：陈叶。", "")
    dialogue = ScriptSegment("line", 23, "23-1", 2, "dialogue", "陈叶", "你好", "")
    candidate = Candidate(
        "g1", "line", .9, .9, .9, 0, .2, "dialogue_sequence", "exact_dialogue",
        script_segment_ids=("heading", "line"),
    )

    cleaned = _without_scene_headings(candidate, {heading.segment_id: heading, dialogue.segment_id: dialogue})
    assert cleaned.script_segment_id == "line"
    assert cleaned.script_segment_ids == ("line",)


def test_scene_prefix_rescue_uses_same_scene_for_short_opening_line(tmp_path):
    from script_organizer.matcher import rescue_scene_prefix_candidates
    from script_organizer.models import GroupMember, MulticamGroup, Transcript, TranscriptSegment

    group = MulticamGroup(
        "opening", 0, 20,
        (GroupMember("b", "B", "B001", "", 0, 20, 20, True),),
        ("B",), "single-camera",
    )
    script = [
        ScriptSegment("heading", 1, "1-1", 1, "scene_heading", "", "1-1 饭店、内、日。", ""),
        ScriptSegment("line-1", 1, "1-1", 2, "action", "", "△陈叶坐下。", ""),
        ScriptSegment("line-2", 1, "1-1", 3, "dialogue", "苏小颖", "您的涮牛肉。", ""),
        ScriptSegment("line-3", 1, "1-1", 4, "dialogue", "苏小颖", "等会儿！别吃了！", ""),
    ]
    transcript = Transcript("b", "B001", "f", "你的菜牛肉", (TranscriptSegment(8.7, 9.9, "你的菜牛肉"),))
    config = ProjectConfig(tmp_path / "p", "x", tmp_path / "x", tmp_path / "x", tmp_path / "o", tmp_path / "c")

    result = rescue_scene_prefix_candidates(group, {"b": transcript}, script, config, (1, "1-1"), "line-3")
    assert result and result[0].script_segment_id == "line-2"
    assert result[0].method == "scene_prefix_dialogue"


def test_production_command_is_not_a_dialogue_match(tmp_path):
    from script_organizer.models import GroupMember, MulticamGroup, Transcript, TranscriptSegment
    group = MulticamGroup("g1", 0, 1, (GroupMember("c1", "A", "A", "", 0, 1, 1, True),), ("A",), "single-camera")
    transcript = Transcript("c1", "A", "f", "开始321", (TranscriptSegment(0, 1, "开始321"),))
    script = [ScriptSegment("E001-S1-L1", 1, "S1", 1, "dialogue", "", "开始", "开始")]
    config = ProjectConfig(tmp_path / "p.toml", "x", tmp_path / "x", tmp_path / "x", tmp_path / "o", tmp_path / "c")
    assert match_group(group, {"c1": transcript}, script, config) == []


def test_review_manual_state_and_atomic_save(tmp_path):
    path = tmp_path / "review.json"
    store = ReviewStore(path)
    store.update_group("g1", "best")
    review = store.load()
    assert review["groups"]["g1"]["state"] == "best"
    assert effective_group_state(review, "g1", []) == "best"
    store.update_group("g1", "unreviewed")
    assert "g1" not in store.load()["groups"]


def test_review_actions_merge_collaborators_without_lost_updates(tmp_path):
    path = tmp_path / "review.json"
    editor_a = ReviewStore(path)
    editor_b = ReviewStore(path)
    editor_a.apply_action({
        "action": "set_assignment",
        "segment_id": "s1",
        "group_id": "g1",
        "state": "keep",
    })
    editor_b.apply_action({
        "action": "set_group",
        "group_id": "g2",
        "state": "reject",
    })
    review = editor_a.load()
    assert review["assignments"]["s1"]["g1"]["state"] == "keep"
    assert review["groups"]["g2"]["state"] == "reject"
    assert review["revision"] == 2


def test_transcript_fingerprint_cache_changes_with_file(tmp_path):
    media = tmp_path / "A.mov"; media.write_bytes(b"one")
    first = media_fingerprint(media)
    store = TranscriptStore(tmp_path / "cache")
    clip = Clip("c1", "A", "A", str(media), 0, 1, 1, True)
    store.write(clip, "你好", [{"start": 0, "end": 1, "text": "你好"}])
    assert store.load(clip).text == "你好"
    media.write_bytes(b"two")
    assert media_fingerprint(media) != first


def test_context_candidate_never_claims_exact(tmp_path):
    from script_organizer.models import GroupMember, MulticamGroup
    group = MulticamGroup("g1", 0, 1, (GroupMember("c1", "A", "A", "", 0, 1, 1, False),), ("A",), "single-camera")
    candidate = context_only_candidate(group, None, ["前后同一连续拍摄块"])
    assert candidate.confidence == "context_only"
    assert candidate.script_segment_id is None
    assert candidate.to_dict()["script_segment_ids"] == []


def test_context_candidate_can_carry_episode_without_script_line(tmp_path):
    from script_organizer.models import GroupMember, MulticamGroup
    group = MulticamGroup("g1", 0, 1, (GroupMember("c1", "A", "A", "", 0, 1, 1, False),), ("A",), "single-camera")
    candidate = context_only_candidate(group, None, ["相邻锚点"], (17, 18))
    payload = candidate.to_dict()
    assert payload["context_episodes"] == [17, 18]
    assert payload["script_segment_ids"] == []


def test_script_gap_metadata_excludes_context_only_and_reports_long_blocks(tmp_path):
    from script_organizer.material_index import _script_gap_metadata
    from script_organizer.models import Candidate

    script = [
        ScriptSegment("s1", 18, "18-2", 1, "dialogue", "", "已匹配", ""),
        ScriptSegment("s2", 18, "18-2", 2, "dialogue", "", "缺口一", ""),
        ScriptSegment("s3", 18, "18-2", 3, "action", "", "缺口动作", ""),
        ScriptSegment("s4", 18, "18-2", 4, "dialogue", "", "缺口二", ""),
        ScriptSegment("s5", 18, "18-2", 5, "dialogue", "", "缺口三", ""),
        ScriptSegment("s6", 18, "18-2", 6, "dialogue", "", "人工范围", ""),
        ScriptSegment("s7", 18, "18-2", 7, "dialogue", "", "后续", ""),
    ]
    exact = Candidate("g1", "s1", .9, .9, .9, 0, .2, "dialogue", "exact_dialogue", script_segment_ids=("s1",))
    gaps = _script_gap_metadata(script, {"g1": [exact]}, {
        "placements": {"g2": {"script_segment_ids": ["s6"]}},
        "assignments": {},
    })
    assert len(gaps) == 1
    assert gaps[0]["start_order"] == 2
    assert gaps[0]["end_order"] == 5
    assert gaps[0]["dialogue_count"] == 3


def test_empty_compat_override_does_not_create_context_candidate(tmp_path):
    from script_organizer.material_index import _candidate_from_override
    from script_organizer.models import GroupMember, MulticamGroup
    group = MulticamGroup("g1", 0, 1, (GroupMember("c1", "A", "A", "", 0, 1, 1, False),), ("A",), "single-camera")
    assert _candidate_from_override(group, {}) is None


def test_clip_paths_with_unicode_and_spaces_are_read(tmp_path):
    media = tmp_path / "素材 中文 01.mov"
    media.write_bytes(b"x")
    xml = f'''<fcpxml version="1.8"><resources><asset id="a" src="file://{media}"/></resources><library><event><project><sequence><spine><asset-clip name="中文" ref="a" lane="1" offset="1001/30000s" duration="1/2s" start="7/8s"/></spine></sequence></project></event></library></fcpxml>'''
    path = tmp_path / "unicode.fcpxml"; path.write_text(xml)
    clip = read_fcpxml(path)[0]
    assert clip.exists and "素材 中文 01.mov" in clip.media_path
    assert float(clip.source_start) == .875


def test_fcpxml_19_media_rep_and_implicit_spine_offsets_are_read(tmp_path):
    first = tmp_path / "A001.mov"
    second = tmp_path / "B001.mov"
    first.write_bytes(b"a")
    second.write_bytes(b"b")
    xml = f'''<fcpxml version="1.9"><resources>
      <asset id="a" name="A001"><media-rep kind="original-media" src="file://{first}"/></asset>
      <asset id="b" name="B001"><media-rep kind="original-media" src="file://{second}"/></asset>
    </resources><library><event><project><sequence><spine>
      <asset-clip name="A001" ref="a" duration="3s"/>
      <asset-clip name="B001" ref="b" duration="2s"/>
    </spine></sequence></project></event></library></fcpxml>'''
    path = tmp_path / "media-rep.fcpxml"
    path.write_text(xml, encoding="utf-8")

    clips = read_fcpxml(path)

    assert [(clip.name, clip.camera, float(clip.timeline_start), float(clip.timeline_end)) for clip in clips] == [
        ("A001", "?", 0.0, 3.0),
        ("B001", "?", 3.0, 5.0),
    ]
    assert all(clip.exists for clip in clips)


def test_fcpxml_multicam_expands_all_angles_and_ignores_resource_sequence(tmp_path):
    media = {camera: tmp_path / f"{camera}001.mov" for camera in ("A", "B", "C")}
    for path in media.values():
        path.write_bytes(path.name.encode("utf-8"))
    xml = f'''<fcpxml version="1.8"><resources>
      <asset id="a" src="file://{media["A"]}"/><asset id="b" src="file://{media["B"]}"/><asset id="c" src="file://{media["C"]}"/>
      <media id="compound"><sequence><spine><asset-clip ref="a" duration="99s"/></spine></sequence></media>
      <media id="multi"><multicam>
        <mc-angle name="A" angleID="angle_A"><clip offset="0s" duration="10s"><video ref="a" duration="10s"/></clip></mc-angle>
        <mc-angle name="B" angleID="angle_B"><gap duration="2s"/><clip offset="2s" duration="8s"><video ref="b" duration="8s"/></clip></mc-angle>
        <mc-angle name="C" angleID="angle_C"><clip offset="1s" duration="9s"><video ref="c" duration="9s"/></clip></mc-angle>
      </multicam></media>
    </resources><library><event>
      <project><sequence><spine><mc-clip ref="multi" offset="20s" start="0s" duration="10s"><mc-source angleID="angle_A"/></mc-clip></spine></sequence></project>
    </event></library></fcpxml>'''
    path = tmp_path / "multicam.fcpxml"
    path.write_text(xml, encoding="utf-8")

    clips = read_fcpxml(path)

    assert {clip.camera for clip in clips} == {"A", "B", "C"}
    assert {clip.name for clip in clips} == {"A001", "B001", "C001"}
    assert [(clip.camera, float(clip.timeline_start), float(clip.timeline_end)) for clip in clips] == [
        ("A", 20.0, 30.0),
        ("B", 22.0, 30.0),
        ("C", 21.0, 30.0),
    ]


def test_fcpxml_ref_clip_and_missing_media_are_retained(tmp_path):
    missing = tmp_path / "missing.mov"
    xml = f'''<fcpxml version="1.9"><resources>
      <asset id="a" name="Missing"><media-rep kind="original-media" src="file://{missing}"/></asset>
      <media id="compound"><sequence><spine><asset-clip ref="a" duration="4s"/></spine></sequence></media>
    </resources><library><event><project><sequence><spine>
      <ref-clip name="Nested" ref="compound" offset="7s" start="0s" duration="4s"/>
    </spine></sequence></project></event></library></fcpxml>'''
    path = tmp_path / "ref.fcpxml"
    path.write_text(xml, encoding="utf-8")

    clips = read_fcpxml(path)

    assert len(clips) == 1
    assert clips[0].media_path == str(missing)
    assert clips[0].exists is False
    assert float(clips[0].timeline_start) == 7.0


def test_single_camera_clip_is_kept_as_group(tmp_path):
    media = tmp_path / "single.mov"; media.write_bytes(b"x")
    clip = Clip("c1", "single", "A", str(media), 0, 1, 1, True)
    group = build_multicam_groups([clip])[0]
    assert group.kind == "single-camera" and group.group_id.startswith("G_")


def test_group_id_changes_only_when_members_change(tmp_path):
    media = tmp_path / "a.mov"; media.write_bytes(b"x")
    a = Clip("a", "a", "A", str(media), 0, 1, 1, True)
    b = Clip("b", "b", "B", str(media), 0, 1, 1, True)
    assert group_id_for([a, b]) == group_id_for([b, a])


def test_many_to_one_candidate_has_script_range(tmp_path):
    from script_organizer.models import GroupMember, MulticamGroup, Transcript, TranscriptSegment
    group = MulticamGroup("g", 0, 1, (GroupMember("c", "A", "A", "", 0, 1, 1, True),), ("A",), "single-camera")
    script = [
        ScriptSegment("s1", 1, "S", 1, "dialogue", "", "你好世界", "你好世界"),
        ScriptSegment("s2", 1, "S", 2, "dialogue", "", "今天好吗", "今天好吗"),
    ]
    transcript = Transcript("c", "A", "f", "你好世界今天好吗", (TranscriptSegment(0, 1, "你好世界今天好吗"),))
    config = ProjectConfig(tmp_path / "p", "x", tmp_path / "x", tmp_path / "x", tmp_path / "o", tmp_path / "c")
    from script_organizer.matcher import match_group
    result = match_group(group, {"c": transcript}, script, config)
    assert result and result[0].script_segment_ids


def test_long_transcript_window_sampling_keeps_end(tmp_path):
    from script_organizer.matcher import _windows
    from script_organizer.models import Transcript, TranscriptSegment
    transcript = Transcript(
        "c", "A", "f", "",
        tuple(TranscriptSegment(index, index + 1, f"第{index}句对白") for index in range(20)),
    )
    windows = _windows(transcript, 5)
    assert len(windows) == 5
    assert windows[0][0] == 0
    assert windows[-1][0] >= 19


def test_manual_assignment_is_preserved_in_manifest(tmp_path):
    project = tmp_path / "project.toml"
    project.write_text("[project]\nname='x'\n[input]\nfcpxml='x.fcpxml'\nscript='x.docx'\n[output]\ndirectory='out'\n")
    config = ProjectConfig.from_file(project)
    config.output_dir.mkdir()
    (config.output_dir / "material_index.json").write_text(json.dumps({"groups":[{"group_id":"g","members":[]}]}))
    (config.output_dir / "script.json").write_text(json.dumps({"segments":[{"segment_id":"s","episode":1,"scene_id":"S","text":"你好"}]}))
    (config.output_dir / "matches.json").write_text(json.dumps({"by_segment":{"s":[{"group_id":"g","confidence":"possible_dialogue"}]}}))
    (config.output_dir / "review.json").write_text(json.dumps({"version":1,"assignments":{"s":{"g":{"state":"best"}}},"groups":{},"clips":{}}))
    from script_organizer.fcpxml_exporter import build_selection_manifest
    manifest = build_selection_manifest(config)
    assert manifest["segments"][0]["groups"][0]["state"] == "best"


def test_manual_reject_survives_reload(tmp_path):
    store = ReviewStore(tmp_path / "review.json")
    store.update_group("g", "reject")
    assert store.load()["groups"]["g"]["state"] == "reject"


def test_transcript_cache_hit_uses_existing_fingerprint(tmp_path):
    media = tmp_path / "a.mov"; media.write_bytes(b"x")
    clip = Clip("c", "a", "A", str(media), 0, 1, 1, True)
    store = TranscriptStore(tmp_path / "cache")
    target = store.write(clip, "你好", [{"start":0,"end":1,"text":"你好"}])
    assert store.load(clip).fingerprint == media_fingerprint(media)
    assert target.exists()


def test_export_preserves_source_fcpxml_bytes(tmp_path):
    source = tmp_path / "source.fcpxml"; source.write_text('<fcpxml version="1.8"><library/></fcpxml>')
    config = ProjectConfig(tmp_path / "p.toml", "x", source, tmp_path / "script.docx", tmp_path / "out", tmp_path / "cache")
    config.output_dir.mkdir()
    (config.output_dir / "material_index.json").write_text(json.dumps({"groups":[],"clips":[]}))
    (config.output_dir / "script.json").write_text(json.dumps({"segments":[]}))
    (config.output_dir / "matches.json").write_text(json.dumps({"groups":{},"by_segment":{}}))
    export(config)
    assert hashlib.sha1(source.read_bytes()).hexdigest() == hashlib.sha1((config.output_dir / "organized.fcpxml").read_bytes()).hexdigest()


def test_export_does_not_claim_keyword_injection(tmp_path):
    source = tmp_path / "source.fcpxml"; source.write_text('<fcpxml version="1.8"><library/></fcpxml>')
    config = ProjectConfig(tmp_path / "p.toml", "x", source, tmp_path / "script.docx", tmp_path / "out", tmp_path / "cache")
    config.output_dir.mkdir()
    for name, payload in [("material_index.json", {"groups":[],"clips":[]}),("script.json", {"segments":[]}),("matches.json", {"groups":{},"by_segment":{}})]:
        (config.output_dir / name).write_text(json.dumps(payload))
    report = export(config)
    assert report["keywords_written"] is False and report["multicam_structure_modified"] is False


def test_candidate_id_is_deterministic(tmp_path):
    from script_organizer.models import Candidate
    c = Candidate("g", "s", .8, .8, .8, 0, .2, "dialogue", "possible_dialogue", script_segment_ids=("s",))
    assert c.to_dict()["candidate_id"] == c.to_dict()["candidate_id"]


def test_review_invalid_state_is_normalized(tmp_path):
    store = ReviewStore(tmp_path / "review.json")
    store.update_group("g", "not-a-real-state")
    assert store.load()["groups"] == {}


def test_many_to_one_alignment_allows_repeat_takes_and_shooting_blocks(tmp_path):
    from script_organizer.models import GroupMember, MulticamGroup, Candidate
    def group(name, start):
        return MulticamGroup(name, start, start + 5, (GroupMember(name, "A", name, "", start, start + 5, 5, True),), ("A",), "single-camera")
    groups = [group("g1", 0), group("g2", 6), group("g3", 5000)]
    script = [ScriptSegment("s1", 1, "S1", 1, "dialogue", "", "第一句", "第一句"), ScriptSegment("s2", 1, "S1", 2, "dialogue", "", "第二句", "第二句")]
    def candidate(gid, sid):
        return Candidate(gid, sid, .9, .9, .5, 0, .2, "dialogue", "exact_dialogue", ("对白",), (sid,), None, "", 0, 1, {})
    selected = align_block(groups[:2], {"g1":[candidate("g1","s1")], "g2":[candidate("g2","s1")]}, script)
    assert selected["g1"].script_segment_id == "s1"
    assert selected["g2"].script_segment_id == "s1"
    assert len(split_shooting_blocks(groups, gap_minutes=20)) == 2


def test_alignment_keeps_manual_override_over_repeated_take(tmp_path):
    from script_organizer.alignment import align_blocks
    from script_organizer.models import GroupMember, MulticamGroup, Candidate

    def group(name, start):
        return MulticamGroup(name, start, start + 5, (GroupMember(name, "A", name, "", start, start + 5, 5, True),), ("A",), "single-camera")

    script = [
        ScriptSegment("s1", 1, "S1", 1, "dialogue", "", "第一句", "第一句"),
        ScriptSegment("s2", 1, "S1", 2, "dialogue", "", "第二句", "第二句"),
        ScriptSegment("s3", 1, "S1", 3, "dialogue", "", "第三句", "第三句"),
    ]
    auto = Candidate("g1", "s2", .95, .95, .95, 0, .1, "dialogue", "exact_dialogue", ("自动",), ("s1", "s2"))
    manual = Candidate("g1", "s2", 1, 1, 1, 1, 1, "legacy_override", "manual", ("人工",), ("s2", "s3"))
    groups = [group("g1", 0), group("g2", 6)]
    aligned, _ = align_blocks(groups, {"g1": [manual, auto]}, script)
    assert aligned["g1"][0].confidence == "manual"
    assert aligned["g1"][0].script_segment_ids == ("s2", "s3")


def test_long_bridge_camera_splits_four_logical_takes_and_keeps_repeat_camera(tmp_path):
    from fractions import Fraction

    media = tmp_path / "clip.mp4"
    media.write_bytes(b"x")

    def clip(name, camera, start, end):
        return Clip(
            name,
            name,
            camera,
            str(media),
            Fraction(start),
            Fraction(end),
            Fraction(end - start),
            True,
        )

    clips = [
        clip("B-long", "B", 0, 640),
        clip("A1", "A", 0, 168),
        clip("C1", "C", 0, 171),
        clip("A2", "A", 172, 327),
        clip("C2", "C", 177, 325),
        clip("A3", "A", 341, 393),
        clip("C3", "C", 338, 398),
        clip("A4", "A", 402, 557),
        clip("A5", "A", 561, 636),
        clip("C4", "C", 401, 634),
    ]
    groups = build_multicam_groups(clips, .5, 1.8)

    assert len(groups) == 4
    assert all(group.parent_group_id for group in groups)
    assert [group.take_index for group in groups] == [1, 2, 3, 4]
    assert [sum(member.camera == "A" for member in group.members) for group in groups] == [1, 1, 1, 2]
    bridge_ranges = [
        next(member for member in group.members if member.clip_id == "B-long")
        for group in groups
    ]
    assert float(bridge_ranges[0].source_start) == 0
    assert float(bridge_ranges[-1].source_end) == 640
    assert all(
        left.source_end == right.source_start
        for left, right in zip(bridge_ranges, bridge_ranges[1:])
    )
    rerun = build_multicam_groups(clips, .5, 1.8)
    assert [group.group_id for group in rerun] == [group.group_id for group in groups]


def test_continuous_other_camera_keeps_same_camera_restart_in_one_take(tmp_path):
    media = tmp_path / "clip.mp4"
    media.write_bytes(b"x")
    clips = [
        Clip("a1", "A1", "A", str(media), 0, 5, 5, True),
        Clip("a2", "A2", "A", str(media), 6, 10, 4, True),
        Clip("b", "B", "B", str(media), 0, 10, 10, True),
        Clip("c", "C", "C", str(media), 0, 10, 10, True),
    ]
    groups = build_multicam_groups(clips, .5, 1.8)
    assert len(groups) == 1
    assert [member.camera for member in groups[0].members].count("A") == 2
    assert groups[0].parent_group_id == ""


def test_transcript_slice_uses_effective_source_range():
    from script_organizer.models import Transcript, TranscriptSegment

    transcript = Transcript(
        "clip",
        "B-long",
        "fingerprint",
        "",
        (
            TranscriptSegment(2, 4, "第一段"),
            TranscriptSegment(12, 15, "第二段"),
            TranscriptSegment(22, 25, "第三段"),
        ),
    )
    sliced = slice_transcript(transcript, 10, 20)
    assert sliced.text == "第二段"
    assert sliced.segments[0].start == 2
    assert sliced.segments[0].end == 5


def test_review_v2_placement_actor_and_parent_state_inheritance(tmp_path):
    store = ReviewStore(tmp_path / "review.json")
    review = store.apply_action({
        "action": "set_group_placement",
        "group_id": "child",
        "episode_ids": [18, "17", 18],
        "script_segment_ids": ["s1", "s2", "s1"],
        "actor": "剪辑A",
    })
    assert review["version"] == 2
    assert review["placements"]["child"]["episode_ids"] == [17, 18]
    assert review["placements"]["child"]["script_segment_ids"] == ["s1", "s2"]
    assert review["placements"]["child"]["actor"] == "剪辑A"

    store.apply_action({"action": "set_group", "group_id": "parent", "state": "reject", "actor": "剪辑B"})
    review = store.load()
    assert effective_group_state(review, "child-2", [], "parent") == "reject"


def test_analysis_cache_reuses_unchanged_groups_and_recomputes_only_changed_transcript(tmp_path, monkeypatch):
    import script_organizer.material_index as material_index

    media_a = tmp_path / "A001.mp4"
    media_b = tmp_path / "A002.mp4"
    media_a.write_bytes(b"a")
    media_b.write_bytes(b"b")
    fcpxml = tmp_path / "input.fcpxml"
    fcpxml.write_text(
        f'''<fcpxml version="1.8"><resources>
        <asset id="a" src="file://{media_a}"/>
        <asset id="b" src="file://{media_b}"/>
        </resources><library><event><project><sequence><spine>
        <asset-clip name="A001" ref="a" lane="1" offset="0s" duration="10s"/>
        <asset-clip name="A002" ref="b" lane="1" offset="20s" duration="10s"/>
        </spine></sequence></project></event></library></fcpxml>''',
        encoding="utf-8",
    )
    script = tmp_path / "script.docx"
    _write_docx(script, ["第1集", "1-1 餐厅", "李梦：王总你怎么来了啊", "王总：今天这个事情必须处理清楚"])
    config = ProjectConfig(
        tmp_path / "project.toml",
        "cache-test",
        fcpxml,
        script,
        tmp_path / "output",
        tmp_path / "transcripts",
    )
    clips = read_fcpxml(fcpxml)
    store = TranscriptStore(config.transcript_dir)
    store.write(clips[0], "王总你咋来了啊", [{"start": 1, "end": 3, "text": "王总你咋来了啊"}])
    store.write(
        clips[1],
        "今天这个事情必须处理清楚",
        [{"start": 1, "end": 4, "text": "今天这个事情必须处理清楚"}],
    )

    first = material_index.analyze(config)
    assert first["index"]["stats"]["analysis_cache_recomputed_groups"] == 2
    assert first["index"]["stats"]["analysis_cache_reused_groups"] == 0

    original_match_group = material_index.match_group
    calls = []

    def counted_match_group(*args, **kwargs):
        calls.append(args[0].group_id)
        return original_match_group(*args, **kwargs)

    monkeypatch.setattr(material_index, "match_group", counted_match_group)
    second = material_index.analyze(config)
    assert calls == []
    assert second["index"]["stats"]["analysis_cache_reused_groups"] == 2
    assert second["index"]["stats"]["analysis_cache_recomputed_groups"] == 0

    store.write(
        clips[1],
        "今天这个事情我们换一种说法",
        [{"start": 1, "end": 4, "text": "今天这个事情我们换一种说法"}],
    )
    third = material_index.analyze(config)
    assert len(calls) == 1
    assert third["index"]["stats"]["analysis_cache_reused_groups"] == 1
    assert third["index"]["stats"]["analysis_cache_recomputed_groups"] == 1


def test_analysis_cache_prewarm_discards_context_only_candidates():
    from script_organizer.material_index import _prewarm_candidates

    payload = [{
        "group_id": "g1",
        "script_segment_id": None,
        "confidence": "context_only",
        "method": "context_only",
        "context_episodes": [17, 32],
    }]
    assert _prewarm_candidates(payload, "g1", keep_manual=False) == []


def test_gap_rescue_targets_only_groups_with_gap_text():
    from script_organizer.material_index import _gap_rescue_group_ids
    from script_organizer.models import GroupMember, MulticamGroup, Transcript, TranscriptSegment

    def group(group_id: str, clip_id: str) -> MulticamGroup:
        member = GroupMember(clip_id, "B", clip_id, "", 0, 4, 4, True)
        return MulticamGroup(group_id, 0, 4, (member,), ("B",), "single-camera")

    script = [ScriptSegment("gap", 4, "4-1", 21, "dialogue", "", "牛肉有证据吗", "")]
    transcripts = {
        "c1": Transcript("c1", "B", "f1", "这是一段牛肉有证据吗的录音", (TranscriptSegment(0, 2, "牛肉有证据吗"),)),
        "c2": Transcript("c2", "B", "f2", "没有相关对白", (TranscriptSegment(0, 2, "没有相关对白"),)),
    }
    previous_matches = {"script_gaps": [{"segment_ids": ["gap"]}]}
    assert _gap_rescue_group_ids(
        [group("g1", "c1"), group("g2", "c2")],
        transcripts,
        script,
        previous_matches,
    ) == {"g1"}
