import json
from pathlib import Path
from types import SimpleNamespace
import pytest
from test_paper_header_selection import context
from script_organizer.paper_draft_ipc import dispatch,validate
from script_organizer.media_identity import DeviceMediaStore
from script_organizer.source_descriptor_receipt import _digest,_sampled_id
from script_organizer.paper_source_context import prepare_reader
from script_organizer.scene_interval_prepare import prepare_selected,validate_targets
from script_organizer.scene_interval_store import SceneIntervalStore,IntervalConflict

@pytest.fixture
def composed(context,tmp_path):
    headers,paper,pdf,args,rows=context;config=SimpleNamespace(output_dir=paper.path.parent)
    index={'clips':[]};bindings={}
    for card in ('A001','B003','B004','C001','C002'):
        p=tmp_path/(card+'C003_261119UA.MP4');p.write_bytes(card.encode()*32);mid=_sampled_id(p)
        index['clips'].append({'clip_id':'clip-'+card,'media_id':mid,'media_path':'','name':p.stem,'camera':card[0]});bindings[mid]=str(p)
    ip=config.output_dir/'material_index.json';ip.write_text(json.dumps(index),encoding='utf-8')
    device=DeviceMediaStore(tmp_path/'device-media.json');data=device.load();data['workspaces']={'w':{'projects':{'p':{'bindings':bindings}}}};device._save(data)
    kw=dict(project_config=config,workspace_id='w',device_store=device)
    h=dispatch(dict(action='header_select',project_id='p',**args),headers.drafts,**kw)['header']
    return headers,paper,pdf,args,config,index,ip,device,kw,h

def binding(c):
    headers,paper,pdf,args,config,index,ip,device,kw,h=c
    found=dispatch(dict(action='source_candidates',project_id='p',paper_row_id=args['paper_row_id'],expected_paper_revision=1),headers.drafts,**kw)
    assert found['candidate_scope']=='project_registered_basenames' and found['media_identity_currently_checked'] is False
    assert len(found['candidates'])==len(index['clips']) and found['confirmed'] is False
    item=next(x for x in found['candidates'] if x['card']=='B003')
    saved=dispatch(dict(action='source_bind',project_id='p',header_id=h['header_id'],expected_selection_revision=1,expected_paper_revision=1,
        expected_index_sha256=found['index_sha256'],expected_binding_revision=0,clip_id=item['clip_id'],media_id=item['media_id']),headers.drafts,**kw)
    target=dict(paper_row_id=args['paper_row_id'],expected_paper_revision=1,clip_id=item['clip_id'],media_id=item['media_id'],expected_index_sha256=found['index_sha256'],
        expected_interval_revision=0,source_start_frame=50,source_end_frame=100,source_context_id=saved['binding_id'],expected_source_context_revision=1,expected_selection_revision=1)
    return saved,target

def packets(path):
    return {'streams':[{'codec_name':'h264','nb_frames':'120','r_frame_rate':'50/1','avg_frame_rate':'50/1','time_base':'1/50'}],
      'packets':[{'pts':i,'duration':1} for i in range(120)]}

def test_same_dispatch_to_actual_prepare(composed,tmp_path):
    headers,paper,pdf,args,config,index,ip,device,kw,h=composed
    before=paper.path.read_bytes();_,targets=binding(composed);validate_targets(targets)
    reader=prepare_reader(config,'w','p',targets,device,lambda:False,drafts=headers.drafts)
    out=prepare_selected(config,'w','p',targets,device,tmp_path/'receipts',probe=packets,source_context_reader=reader)
    assert out['status']=='proposal_prepared' and out['export_ready'] is False
    stored=SceneIntervalStore(config.output_dir,'p').snapshot()['intervals'][out['evidence_id']]
    assert stored['source_start_frame']==50 and stored['source_end_frame']==100 and stored['clip_id']=='clip-B003'
    assert stored['source_context']['kind']=='operator_confirmed_filename_prefix'
    assert stored['review_state']=='proposal' and stored['exact_take_confirmed'] is False
    assert paper.path.read_bytes()==before

@pytest.mark.parametrize('what',['index','header','binding_revision','other_clip','range','file'])
def test_prepare_rejects_stale_or_changed(composed,tmp_path,what):
    headers,paper,pdf,args,config,index,ip,device,kw,h=composed
    _,t=binding(composed)
    if what=='index':index['revision']=2;ip.write_text(json.dumps(index))
    elif what=='header':headers.set(**{**args,'expected_selection_revision':1,'card':'B004'})
    elif what=='binding_revision':t['expected_source_context_revision']=0
    elif what=='other_clip':t['clip_id']='clip-C001'
    elif what=='range':t['source_end_frame']=150
    elif what=='file':Path(device.load()['workspaces']['w']['projects']['p']['bindings'][t['media_id']]).write_bytes(b'replaced')
    reader=prepare_reader(config,'w','p',t,device,lambda:False,drafts=headers.drafts)
    with pytest.raises(ValueError):prepare_selected(config,'w','p',t,device,tmp_path/'receipts',probe=packets,source_context_reader=reader)
    assert not SceneIntervalStore(config.output_dir,'p').snapshot()['intervals']

def test_duplicated_occurrence_and_no_code_override(composed):
    headers,paper,pdf,args,config,index,ip,device,kw,h=composed
    duplicate=dict(index['clips'][1],clip_id='another-timeline-occurrence');index['clips'].append(duplicate);ip.write_text(json.dumps(index))
    with pytest.raises(ValueError,match='not_unique'):binding(composed)
    with pytest.raises(ValueError):validate(dict(action='source_candidates',project_id='p',paper_row_id=args['paper_row_id'],expected_paper_revision=1,code='219'))

def test_default_worker_constructor_and_mid_probe_revision(composed,tmp_path,monkeypatch):
    headers,paper,pdf,args,config,index,ip,device,kw,h=composed
    _,t=binding(composed)
    import script_organizer.paper_ocr_task as task_module
    calls=[]
    def fixed(workspace,project,cancelled):
        calls.append((workspace,project));return headers.drafts
    monkeypatch.setattr(task_module,'service',fixed)
    def changed(path):
        headers.set(**{**args,'expected_selection_revision':1,'card':'B004'})
        return packets(path)
    with pytest.raises(IntervalConflict):prepare_selected(config,'w','p',t,device,tmp_path/'receipts',probe=changed)
    assert calls==[('w','p')] and not SceneIntervalStore(config.output_dir,'p').snapshot()['intervals']

def test_no_guess_for_missing_scope_or_unrecognized_registered_extension(composed):
    headers,paper,pdf,args,config,index,ip,device,kw,h=composed
    state=device.load()
    entries=state['workspaces']['w']['projects']['p']['bindings']
    entry=index['clips'][0]
    p=entries.pop(entry['media_id'])
    state['workspaces']['w']['projects']['other']={'bindings':{entry['media_id']:p}}
    entry['media_path']=p  # Even a real legacy index path is not registration.
    ip.write_text(json.dumps(index),encoding='utf-8')
    other=index['clips'][1]
    entries[other['media_id']]=str(Path(entries[other['media_id']]).with_suffix('.mov'))
    device._save(state)
    found=dispatch(dict(action='source_candidates',project_id='p',paper_row_id=args['paper_row_id'],expected_paper_revision=1),headers.drafts,**kw)
    assert len(found['candidates'])==3
    assert {x['card'] for x in found['candidates']}=={'B004','C001','C002'}
    assert str(Path(p).parent) not in json.dumps(found)

@pytest.mark.parametrize('value', ['003→004','B003','C００３','20261119'])
def test_unsupported_literal_code_abstains(composed,value):
    _,_,_,_,_,index,_,device,_,_=composed
    from script_organizer.paper_filename_context import discover
    if value=='20261119':
        assert not discover(index,value,_digest(index),device_store=device,workspace='w',project='p')['candidates']
    else:
        with pytest.raises(ValueError,match='literal_clip_code_required'):
            discover(index,value,_digest(index),device_store=device,workspace='w',project='p')
