from copy import deepcopy
from script_organizer.scene_interval_plan import build_marker_plan,evidence_digest


def fixture():
    asset={'media_id':'M_one','asset_revision':'rev1','fps':{'numerator':30000,'denominator':1001},'frame_count':1000,'filename':'C0001.mov'}
    row={'evidence_id':'record1','version':1,'media_id':'M_one','clip_id':'occurrence1','asset_revision':'rev1','source_fps':asset['fps'],
         'source_start_frame':30,'source_end_frame':90,'scene':'19-1','review_state':'human_verified','boundary_status':'exact_source_frames',
         'provenance':{'origin':'scene_log','record_id':'sheet1:row2'},'raw_cells':{'scene':'19-1','take':'003','date':''}}
    return asset,review(row)

def review(row):
    row['review']={'actor':'synthetic-editor','evidence_version':row['version'],'evidence_sha256':evidence_digest(row)}
    return row

def plan(asset,rows,existing=None):
    return build_marker_plan('p',rows,[asset],existing or [])

def test_multirange_does_not_assign_clip_wide_scene_or_take_and_does_not_mutate():
    a,r=fixture();second=deepcopy(r);second.update(evidence_id='r2',source_start_frame=110,source_end_frame=160,scene='20-1');review(second)
    original=deepcopy([r,second]);p=plan(a,[r,second])
    assert [x['action'] for x in p['rows']]==['propose_add_marker']*2
    assert [r,second]==original and not p['writes_project']
    assert all(not x['intent']['whole_clip_authorized'] and not x['intent']['exact_take_confirmed'] for x in p['rows'])
    assert p['rows'][0]['evidence']['raw_cells']['take']=='003'
    assert p['native_adapter_status']=='not_validated'

def test_idempotence_and_user_marker_preservation():
    a,r=fixture();p=plan(a,[r]);x=p['rows'][0]
    existing=[{'media_id':'M_one','source_frame':30,'custom_data':x['native_custom_data'],'name':x['intent']['name'],'note':x['intent']['note'],'duration':60}]
    assert plan(a,[r],existing)['rows'][0]['action']=='noop'
    existing[0]['custom_data']='user-marker'
    assert plan(a,[r],existing)['rows'][0]['action']=='conflict'
    assert existing[0]['custom_data']=='user-marker'

def test_same_basename_not_identity_and_duplicate_inventory_blocks():
    a,r=fixture();other=dict(a,media_id='M_other')
    p=build_marker_plan('p',[r],[a,other],[])
    assert p['rows'][0]['intent']['media_id']=='M_one'
    assert build_marker_plan('p',[r],[a,a],[])['rows'][0]['action']=='blocked'

def test_no_review_and_stale_review_never_export():
    a,r=fixture();r['review_state']='proposal'
    assert plan(a,[r])['rows'][0]['action']=='review_required'
    r['review_state']='human_verified';r['scene']='new'
    assert plan(a,[r])['rows'][0]['action']=='blocked'

def test_unknown_boundary_fractional_frames_and_rate_mismatch_block():
    a,r=fixture()
    for key,value in [('source_start_frame',1.5),('boundary_status','approximate'),('source_fps',{'numerator':30,'denominator':1}),('source_end_frame',1001)]:
        changed=deepcopy(r);changed[key]=value;review(changed)
        assert plan(a,[changed])['rows'][0]['action']=='blocked'

def test_unknown_date_and_overlapping_ranges_do_not_gate_or_invent_take():
    a,r=fixture();s=deepcopy(r);s.update(evidence_id='r2',source_start_frame=40);s['raw_cells']['date']='unknown';s['raw_cells']['notes']='restart';review(s)
    assert all(x['action']=='propose_add_marker' for x in plan(a,[r,s])['rows'])
    assert all(not x['intent']['exact_take_confirmed'] for x in plan(a,[r,s])['rows'])

def test_same_frame_planned_collision_blocks_both():
    a,r=fixture();s=deepcopy(r);s.update(evidence_id='r2');review(s)
    assert [x['action'] for x in plan(a,[r,s])['rows']]==['conflict','conflict']

def test_repeat_plan_is_deterministic_and_changed_owned_marker_not_overwritten():
    a,r=fixture();p=plan(a,[r]);assert p==plan(a,[r]);x=p['rows'][0]
    existing=[{'media_id':'M_one','source_frame':30,'custom_data':x['native_custom_data'].replace(x['payload_sha256'],'modified')}]
    assert plan(a,[r],existing)['rows'][0]['action']=='conflict'


def test_user_edit_to_owned_marker_is_conflict_even_with_unchanged_customdata():
    a,r=fixture();x=plan(a,[r])['rows'][0]
    existing=[{'media_id':'M_one','source_frame':30,'custom_data':x['native_custom_data'],'name':'user edit','note':'','duration':60}]
    assert plan(a,[r],existing)['rows'][0]['action']=='conflict'
