import pytest
from script_organizer.scene_interval_store import IntervalConflict
from script_organizer.slate_framing_tags import FramingStore,framing,PRESETS
from script_organizer.paper_intake_store import PaperIntakeStore
from script_organizer.scene_interval_ipc import validate_request
from test_paper_intake import body, row

def test_presets_and_custom_tags_exact_camera_durable_and_no_raw_change(tmp_path):
    paper=PaperIntakeStore(tmp_path,'p'); values=row(cameras={'A':{'clip_raw':'c006','framing_raw':'原写'},'B':{'clip_raw':'c006'},'C':{'clip_raw':'涂改'}})
    raw=paper.ingest(body([values,row(row_index=2,cameras={'A':{'clip_raw':'c006'}})]))['rows'][0]
    proof=paper.path.read_bytes()
    state=FramingStore(tmp_path,'p')
    request={'expected_scope':'current','expected_paper_revision':1,'expected_tag_revision':0,'paper_row_id':raw['paper_row_id'],
      'row_digest':raw['row_digest'],'camera':'A','tag':'近景','add_custom':False}
    assert framing(paper,state,request,'current')['catalog']==list(PRESETS) and not state.path.exists()
    out=framing(paper,state,request,'current',write=True)
    assert out['revision']==1 and [t['camera'] for t in out['tags']]==['A']
    change={**request,'expected_tag_revision':1,'tag':'半身','add_custom':True}
    out=framing(paper,state,change,'current',write=True)
    assert out['revision']==2 and out['catalog'][-1]=='半身' and len(out['tags'])==1
    out=framing(paper,FramingStore(tmp_path,'p'),request,'current')
    assert out['tags'][0]['tag']=='半身' and paper.path.read_bytes()==proof
    assert [x['previous']['tag'] if x['previous'] else None for x in state.snapshot()['events']]==[None,'近景']
    with pytest.raises(IntervalConflict):framing(paper,state,request,'current',write=True)
    with pytest.raises(IntervalConflict):framing(paper,state,{**request,'expected_tag_revision':2,'row_digest':'b'*64},'current',write=True)
    with pytest.raises(ValueError):framing(paper,state,{**request,'expected_tag_revision':2,'camera':'C'},'current',write=True)
    with pytest.raises(ValueError):framing(paper,state,{**request,'expected_tag_revision':2,'tag':'来路之外'},'current',write=True)
    assert paper.path.read_bytes()==proof and state.snapshot()['revision']==2

def test_private_contract_no_arrays_or_bulk_targets():
    request=dict(action='board_framing_read',project_id='p',expected_scope='s',expected_paper_revision=1)
    validate_request(request)
    with pytest.raises(ValueError):validate_request(dict(request,selected_rows=['a','b']))
    with pytest.raises(ValueError):validate_request(dict(request,filename='/Volumes/x'))
