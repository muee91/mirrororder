import csv
import io
import json
import unittest
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from script_organizer.slate_log_intake import prepare, read_rows, render_metadata_csv


def row(**kw):
    return dict(scene='001A', shot='02', take='003', page='p1', row='1',
                text='001A / 02 / 003', filename='one.mov', **kw)


def asset(cid='c1', mid='m1', filename='one.mov', **kw):
    return dict(clip_id=cid, media_id=mid, filename=filename, **kw)


class IntakeTests(unittest.TestCase):
    def test_leading_zero_json_csv(self):
        for text, fmt in [(json.dumps([row()]), 'json'),
                          ('scene,shot,take,page,row,text,filename\n001A,02,003,p1,1,note,one.mov\n', 'csv')]:
            result = prepare(read_rows(text, fmt), [asset()])
            self.assertEqual(result['ready'][0]['fields']['take'], '003')
            self.assertFalse(result['writes_authority'])

    def test_numbers_not_silently_coerced(self):
        r = row(); r['take'] = 3
        self.assertIn('non_string:take', prepare([r], [asset()])['unresolved'][0]['reasons'])

    def test_ditto_only_same_page_and_not_blank(self):
        r = row(); s = row(); s.update(scene='〃', row='2')
        result = prepare([r, s], [asset()])
        self.assertEqual(result['ready'][1]['inherited_from']['scene'], 0)
        s['page'] = 'p2'
        self.assertIn('unresolved_ditto:scene', prepare([r, s], [asset()])['unresolved'][0]['reasons'])
        s.update(page='p1', scene='')
        self.assertIn('missing:scene', prepare([r, s], [asset()])['unresolved'][0]['reasons'])

    def test_scene_shot_take_not_identity(self):
        r = row(); r.pop('filename')
        self.assertIn('missing_asset_identity', prepare([r], [asset()])['unresolved'][0]['reasons'])

    def test_duplicate_filename_and_paths(self):
        assets = [asset(local_path='card-a/one.mov'), asset('c2', 'm2', local_path='card-b/one.mov')]
        self.assertFalse(prepare([row()], assets)['ready'])
        r = row(local_path='card-b/one.mov')
        p = prepare([r], assets)['ready'][0]
        self.assertEqual(p['attachments'][0]['media_id'], 'm2')
        self.assertNotIn('local_path', json.dumps(p))

    def test_stable_id_cannot_mask_contradiction(self):
        r = row(media_id='m1', camera='B')
        self.assertFalse(prepare([r], [asset(camera='A')])['ready'])

    def test_confirmed_multicam_only(self):
        r = row(confirmed_group_id='g'); r.pop('filename')
        assets = [asset(camera='A'), asset('c2', 'm2', 'two.mov', camera='B')]
        self.assertFalse(prepare([r], assets)['ready'])
        p = prepare([r], assets, confirmed_groups={'g': ['c1', 'c2']})['ready'][0]
        self.assertEqual(len(p['attachments']), 2)

    def test_conflicting_rows_block_both(self):
        s = row(); s['take'] = '004'
        result = prepare([row(), s], [asset()])
        self.assertEqual(len(result['unresolved']), 2)
        self.assertFalse(result['ready'])

    def test_confirmed_fields_not_overwritten(self):
        r = prepare([row()], [asset(confirmed={'scene': '9'})])
        self.assertIn('confirmed_conflict:scene', r['unresolved'][0]['reasons'])

    def test_csv_bad_headers(self):
        with self.assertRaises(ValueError):
            read_rows('scene,scene\n1,2\n', 'csv')

    def test_ambiguity_and_provenance(self):
        r = row(ambiguities=['could be 1 or 7']); r.pop('page')
        self.assertFalse(prepare([r], [asset()])['ready'])

    def test_transport_synthetic_schema_and_confirmation(self):
        # Deliberately NOT claimed as actual Resolve headers.
        template = 'SOURCE,LOCATION,SCENE_TEST,TAKE_TEST\none.mov,card-a,,\n'
        args = dict(bindings={'m1': 0}, field_columns={'scene': 'SCENE_TEST', 'take': 'TAKE_TEST'},
                    identity_columns=['SOURCE', 'LOCATION'], template_source='synthetic-unit-test')
        p = prepare([row()], [asset()])
        self.assertEqual(render_metadata_csv(p, template, **args)['csv'], '')
        p = prepare([row(confirmed=True)], [asset()])
        result = render_metadata_csv(p, template, **args)
        self.assertIn('001A,003', result['csv'])
        self.assertEqual(result['original_count'], 1)
        self.assertIn('not_nle_verified', result['status'])
        args['template_source'] = ''
        self.assertEqual(render_metadata_csv(p, template, **args)['status'], 'unverified_template')

    def test_duplicate_template_and_existing_metadata(self):
        p = prepare([row(confirmed=True)], [asset()])
        args = dict(bindings={'m1': 0}, field_columns={'scene': 'S'}, identity_columns=['ID'], template_source='synthetic')
        for template in ['ID,S\none,\none,\n', 'ID,S\none,9\n']:
            self.assertEqual(render_metadata_csv(p, template, **args)['csv'], '')

    def test_one_row_per_original_with_repeated_occurrences(self):
        r = row(confirmed_group_id='g', confirmed=True); r.pop('filename')
        p = prepare([r], [asset(), asset('c2')], confirmed_groups={'g': ['c1', 'c2']})
        result = render_metadata_csv(p, 'ID,S\none,\n', bindings={'m1': 0}, field_columns={'scene': 'S'}, identity_columns=['ID'], template_source='synthetic')
        self.assertEqual(result['original_count'], 1)

    def test_group_filter_does_not_silently_drop_angle(self):
        r = row(confirmed_group_id='g', camera='A'); r.pop('filename')
        p = prepare([r], [asset(camera='A'), asset('c2', 'm2', 'two.mov', camera='B')], confirmed_groups={'g': ['c1', 'c2']})
        self.assertIn('group_selector_contradiction', p['unresolved'][0]['reasons'])

    def test_ditto_does_not_inherit_ambiguous_source(self):
        a = row(ambiguities=['unclear scene']); b = row(); b['scene'] = '同上'
        p = prepare([a, b], [asset()])
        self.assertEqual(len(p['unresolved']), 2)

    def test_late_conflict_propagates_to_ditto_other_asset(self):
        a = row(); b = row(); b.update(scene='同上', filename='two.mov'); c = row(); c['scene'] = '9'
        p = prepare([a, b, c], [asset(), asset('c2', 'm2', 'two.mov')])
        self.assertFalse(p['ready'])
        self.assertIn('inherited_source_unresolved', p['unresolved'][1]['reasons'])

    def test_sample_end_to_end(self):
        fixture = json.loads((Path(__file__).parent / 'fixtures/slate_log/end_to_end.json').read_text())
        result = prepare(fixture['rows'], fixture['assets'])
        self.assertEqual(len(result['ready']), 1)
        self.assertEqual(len(result['unresolved']), 1)
        transport = render_metadata_csv(result, fixture['template'], **fixture['transport'])
        self.assertEqual(transport['original_count'], 1)
        self.assertEqual(next(csv.DictReader(io.StringIO(transport['csv'])))['TAKE_TEST'], '003')


if __name__ == '__main__':
    unittest.main()
