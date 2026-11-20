import json
from types import SimpleNamespace
import pytest
from test_paper_ocr_derived import setup
from test_paper_header_selection import context
from test_paper_source_context import composed,binding,packets
from script_organizer.paper_draft_ipc import dispatch
from script_organizer.paper_header_selection import reviewed_paper_camera
from script_organizer.paper_intake_store import PaperIntakeStore
from script_organizer.scene_interval_prepare import prepare_selected
from script_organizer.scene_interval_store import IntervalConflict


def test_reviewed_row_persists_exact_filename_column_camera(tmp_path,monkeypatch):
    config,drafts,request=setup(tmp_path,monkeypatch)
    request['column_mapping'][0]={'column_index':0,'field':'filename','paper_camera':'A'}
    dispatch({'action':'reviewed_row','project_id':'p',**request},drafts,project_config=config)
    state=PaperIntakeStore(tmp_path,'p').snapshot()
    row=next(iter(state['rows'].values()))
    assert row['raw_row']['filename']=='003'
    assert 'camera' not in row['raw_row'] and reviewed_paper_camera(state,row)=='A'


@pytest.mark.parametrize('mapping',[{'column_index':0,'field':'scene','paper_camera':'A'},
    {'column_index':0,'field':'filename','paper_camera':'a'},
    {'column_index':2,'field':'filename','paper_camera':'A'}])
def test_invalid_or_unreadable_mapping_is_not_saved(tmp_path,monkeypatch,mapping):
    config,drafts,request=setup(tmp_path,monkeypatch)
    request['column_mapping']=[mapping]
    with pytest.raises(ValueError):dispatch({'action':'reviewed_row','project_id':'p',**request},drafts,project_config=config)
    assert PaperIntakeStore(tmp_path,'p').snapshot()['revision']==0


def trusted_derived(paper,pdf,*,camera='A'):
    from hashlib import sha256
    lineage={'column_mapping':[{'field':'filename','column_index':5,**({'paper_camera':camera} if camera else {})}],
             'reviewed_cells':[{'machine_original':{'column_index':5},'action':'accept','transcription_status':'reviewed_text','reviewed_text':'003'}]}
    return paper._ingest({'mode':'structured_slate_log.v1','operation':'ingest','format':'json','expected_revision':1,
       'content':json.dumps({'source_pdf':{'sha256':sha256(pdf.read_bytes()).hexdigest()},'rows':[
           {'pdf_page':1,'row_index':'ocr-review-2','filename':'003','scene':'TEST','derived_transcription':lineage}]})},
       derived_lineage=lineage)['rows'][-1]


def test_same_code_b_card_does_not_replace_reviewed_a_even_if_only_b_registered(composed,tmp_path):
    headers,paper,pdf,args,config,index,index_path,device,kw,_=composed
    row=trusted_derived(paper,pdf)
    only_b=index['clips'][1]; state=device.load()
    bindings=state['workspaces']['w']['projects']['p']['bindings']
    state['workspaces']['w']['projects']['p']['bindings']={only_b['media_id']:bindings[only_b['media_id']]}
    device._save(state)
    args.update(paper_row_id=row['paper_row_id'],row_digest=row['row_digest'],expected_paper_revision=2,expected_selection_revision=1)
    found=dispatch(dict(action='source_candidates',project_id='p',paper_row_id=row['paper_row_id'],expected_paper_revision=2),headers.drafts,**kw)
    assert found['reviewed_paper_camera']=='A' and [r['camera'] for r in found['candidates']]==['B']
    with pytest.raises(IntervalConflict,match='reviewed_paper_camera_conflict'):
        dispatch(dict(action='header_select',project_id='p',**args),headers.drafts,**kw)
    with pytest.raises(IntervalConflict,match='reviewed_paper_camera_requires_source_context'):
        prepare_selected(config,'w','p',dict(paper_row_id=row['paper_row_id'],expected_paper_revision=2,expected_interval_revision=0,
            expected_index_sha256=found['index_sha256'],clip_id=only_b['clip_id'],media_id=only_b['media_id'],
            source_start_frame=1,source_end_frame=2),device,tmp_path/'receipts',probe=packets)


@pytest.mark.parametrize('known',[None,'A'])
def test_correct_or_unknown_header_and_stale_paper_context(composed,known):
    headers,paper,pdf,args,config,index,index_path,device,kw,_=composed
    row=trusted_derived(paper,pdf,camera=known)
    args.update(paper_row_id=row['paper_row_id'],row_digest=row['row_digest'],expected_paper_revision=2,expected_selection_revision=1)
    item=index['clips'][0 if known else 1]
    args.update(card='A001' if known else 'B003',camera='A' if known else 'B')
    native=dispatch(dict(action='header_select',project_id='p',**args),headers.drafts,**kw)['header']
    assert native.get('reviewed_paper_camera')==known
    assert headers.read_bound_source(header_id=native['header_id'],expected_selection_revision=2,expected_paper_revision=2)==native
    found=dispatch(dict(action='source_candidates',project_id='p',paper_row_id=row['paper_row_id'],expected_paper_revision=2),headers.drafts,**kw)
    assert found['reviewed_paper_camera']==known
    request=dict(action='source_bind',project_id='p',header_id=native['header_id'],expected_selection_revision=2,expected_paper_revision=2,
        expected_index_sha256=found['index_sha256'],expected_binding_revision=0,clip_id=item['clip_id'],media_id=item['media_id'])
    assert dispatch(request,headers.drafts,**kw)['status']=='recorded'
    with pytest.raises(IntervalConflict):dispatch(dict(request,expected_paper_revision=1),headers.drafts,**kw)


def test_public_json_cannot_elevate_camera_lineage(composed):
    headers,paper,pdf,args,config,index,index_path,device,kw,_=composed
    doc=paper.ingest({'mode':'structured_slate_log.v1','operation':'ingest','format':'json','expected_revision':1,
        'content':json.dumps({'rows':[{'pdf_page':1,'row_index':'legacy','camera':'A','filename':'003',
          'derived_transcription':{'column_mapping':[{'field':'filename','paper_camera':'A'}]}}]})})
    row=doc['rows'][-1]
    assert reviewed_paper_camera(paper.snapshot(),row) is None
