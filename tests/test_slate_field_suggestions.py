from script_organizer.slate_candidate_rules import literal_fields
from script_organizer.slate_field_suggestions import _inherit_same_page_context


def paper_row(number, *, scene='', shot='', take='', clip='', page=1):
    return {'raw_row': {
        'pdf_page': page,
        'row_index': number,
        'scene_raw': scene,
        'shot_raw': shot,
        'take_raw': take,
        'cameras': {'C': {'clip_raw': clip}},
    }}


def proposal(row):
    raw = row['raw_row']
    return {
        'source': {'pdf_page': raw['pdf_page'], 'row_index': raw['row_index']},
        'fields': {field: {'state': 'suggested', 'value': value}
                   for field, value in literal_fields(raw).items()},
    }


def test_retake_uses_paper_order_even_when_first_take_has_no_group():
    rows = [
        paper_row(1, scene='19-1', shot='2', take='1'),
        paper_row(2, shot='3', take='1'),
        paper_row(3, clip='↓C022'),
        paper_row(4, take='2'),
        paper_row(5, shot='4?', take='1'),
        paper_row(6, take='2'),
    ]
    published = {str(i): proposal(rows[i]) for i in (0, 3, 5)}
    result = _inherit_same_page_context(published, rows)
    assert result['3']['fields']['shot']['value'] == '3'
    assert result['3']['fields']['scene']['value'] == '19-1'
    assert 'shot' not in result['5']['fields']


def test_linked_scenes_keep_shot_sequence_without_assigning_first_scene_to_every_take():
    rows = [
        paper_row(1, scene='38-1', shot='1', take='1'),
        paper_row(2, scene='↓38-2', clip='↓C004'),
        paper_row(3, scene='连拍', shot='2', take='1'),
        paper_row(4, take='2'),
        paper_row(6, take='3'),
        paper_row(1, take='4', page=2),
    ]
    published = {str(i): proposal(rows[i]) for i in (0, 3, 4, 5)}
    result = _inherit_same_page_context(published, rows)
    assert result['0']['fields']['scene']['value'] == '38-1'
    assert result['3']['fields']['shot']['value'] == '2'
    assert 'scene' not in result['3']['fields']
    assert 'shot' not in result['4']['fields']
    assert 'shot' not in result['5']['fields']


def test_source_range_warning_does_not_clear_written_count():
    row = paper_row(1, shot='34', take='1', clip='C102→C104')['raw_row']
    row['uncertainties'] = ['箭头/跨行范围按原样保留，未展开或认定同一文件多个Take']
    assert literal_fields(row) == {'shot': '34', 'take': '1'}
    row['uncertainties'].append('Take 次数涂改')
    assert literal_fields(row) == {'shot': '34'}


def test_scanned_row_connections_only_fill_explicitly_linked_endpoints():
    first = paper_row(1, scene='38-1', shot='17', take='1')
    endpoint = paper_row(2, scene='↓38-2', clip='↓C064')
    endpoint['raw_row']['cameras']['B'] = {'clip_raw': '↓C060'}
    single_reference = paper_row(3, clip='↓C065')
    rows = [first, endpoint, single_reference]
    published = {'endpoint': proposal(endpoint), 'loose': proposal(single_reference)}
    result = _inherit_same_page_context(published, rows)
    assert {field: value['value'] for field, value in result['endpoint']['fields'].items()} == {
        'shot': '17', 'take': '1',
    }
    assert result['loose']['fields'] == {}


def test_source_timecode_probe_caches_by_file_stat(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from script_organizer import desktop_runtime

    clip_file = tmp_path / 'A001.MOV'
    clip_file.write_bytes(b'first')
    calls = 0

    def fake_probe(path, *, timeout_seconds=2.0):
        nonlocal calls
        calls += 1
        return SimpleNamespace(timecode=f'01:00:00:0{calls}', frame_rate=(25, 1))

    desktop_runtime._SOURCE_TIMECODE_CACHE.clear()
    monkeypatch.setattr(desktop_runtime, '_probe', fake_probe)

    first = desktop_runtime._probe_source_timecode_cached(clip_file)
    second = desktop_runtime._probe_source_timecode_cached(clip_file)
    assert calls == 1
    assert first.timecode == second.timecode == '01:00:00:01'

    clip_file.write_bytes(b'second-version')
    third = desktop_runtime._probe_source_timecode_cached(clip_file)
    assert calls == 2
    assert third.timecode == '01:00:00:02'


def test_paper_suggestions_cache_skips_recompute_until_inputs_change(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from script_organizer import script_supervisor_runtime, slate_field_suggestions

    out = tmp_path / 'output'
    (out / 'sync').mkdir(parents=True)
    (out / 'sync' / 'sync_report.json').write_text('{}', encoding='utf-8')
    suggestions = out / 'paper_field_suggestions.v1.json'
    suggestions.write_text('{}', encoding='utf-8')
    project = SimpleNamespace(
        config=SimpleNamespace(output_dir=out),
        index={'groups': []},
        analysis_revision='rev-1',
    )
    calls = 0

    def fake_read(*args, **kwargs):
        nonlocal calls
        calls += 1
        return {
            'contract': 'mirrororder.paper_field_suggestions.v1',
            'editorial_authority': False,
            'paper_revision': calls,
            'groups': {
                'g1': {
                    'fields': {'scene': {'state': 'suggested', 'value': '1-1'}},
                    'source': {'pdf_sha256': 'a' * 64, 'pdf_page': 1, 'row_index': 1, 'paper_row_id': 'r1', 'row_digest': 'b' * 64},
                }
            },
        }

    script_supervisor_runtime._PAPER_SUGGESTION_CACHE.clear()
    monkeypatch.setattr(slate_field_suggestions, 'read_algorithmic_suggestions', fake_read)

    first = script_supervisor_runtime._paper_suggestions(None, 'p1', project)
    second = script_supervisor_runtime._paper_suggestions(None, 'p1', project)
    assert calls == 1
    assert first == second and first['paper_revision'] == 1

    suggestions.write_text('{"changed":true}', encoding='utf-8')
    third = script_supervisor_runtime._paper_suggestions(None, 'p1', project)
    assert calls == 2
    assert third['paper_revision'] == 2
