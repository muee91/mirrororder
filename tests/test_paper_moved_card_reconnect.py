from pathlib import Path
import pytest
from test_paper_header_selection import context
from test_paper_source_context import composed,binding
from script_organizer.paper_draft_ipc import dispatch
from script_organizer.paper_source_context import prepare_reader
from script_organizer.scene_interval_store import IntervalConflict
from script_organizer.source_descriptor_receipt import _sampled_id


def test_moved_original_keeps_collision_then_reconnects_prior_identity(composed,tmp_path):
    headers,paper,pdf,args,config,index,ip,device,kw,h=composed
    old,targets=binding(composed)
    original_paper=paper.path.read_bytes(); original_index=ip.read_bytes()
    mid=targets['media_id']
    current=lambda:device.load()['workspaces']['w']['projects']['p']['bindings']
    prior=Path(current()[mid]); moved_dir=tmp_path/'moved_one_level'; moved_dir.mkdir()
    moved=prior.rename(moved_dir/prior.name)
    read=dict(project_id='p',action='source_candidates',paper_row_id=args['paper_row_id'],expected_paper_revision=1)
    found=dispatch(read,headers.drafts,**kw)
    assert found['status']=='ambiguous_candidates' and found['missing_candidate_count']==1
    rows={row['card']:row for row in found['candidates']}
    assert rows['B003']['media_id']==mid and rows['B003']['registration_path_state']=='missing_or_offline'
    assert rows['B004']['registration_path_state']=='present_identity_unchecked'
    assert found['confirmed'] is found['media_identity_currently_checked'] is False
    request=dict(action='source_bind',project_id='p',header_id=h['header_id'],expected_selection_revision=1,
                 expected_paper_revision=1,expected_index_sha256=found['index_sha256'],expected_binding_revision=1,
                 clip_id=targets['clip_id'],media_id=mid)
    with pytest.raises(IntervalConflict,match='registered_media_missing_or_offline'):
        dispatch(request,headers.drafts,**kw)
    with pytest.raises(ValueError,match='selected_occurrence_conflict'):
        dispatch(dict(request,clip_id=rows['B004']['clip_id'],media_id=rows['B004']['media_id']),headers.drafts,**kw)
    result=device.scan('w','p',index,[str(moved_dir)])
    assert result['scan']['verified_matches']==1 and current()[mid]==str(moved)
    assert _sampled_id(moved)==mid
    after=dispatch(read,headers.drafts,**kw)
    assert after['status']=='ambiguous_candidates' and after['missing_candidate_count']==0
    reader=prepare_reader(config,'w','p',targets,device,lambda:False,drafts=headers.drafts)
    with pytest.raises(IntervalConflict,match='context_binding_stale'):reader()
    new=dispatch(request,headers.drafts,**kw)
    assert new['binding_id']!=old['binding_id'] and new['interval_confirmed'] is new['exact_take_confirmed'] is False
    assert paper.path.read_bytes()==original_paper and ip.read_bytes()==original_index
    assert not (config.output_dir/'scene_intervals.json').exists()
