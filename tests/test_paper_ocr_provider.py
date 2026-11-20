import hashlib,json,shutil
from pathlib import Path
import pytest
from script_organizer.paper_pdf_drafts import PDFDrafts
from script_organizer.paper_source_binding import canonical_native
from script_organizer.paper_ocr_geometry import cells_from_lines
from script_organizer.paper_ocr_provider import analyze_draft_page,MODEL_SHA
FIX=Path(__file__).parent/'fixtures/paper-native'

def setup(tmp_path):
    source=tmp_path/'original.pdf';shutil.copyfile(FIX/'renderer/evidence/page-0.pdf',source)
    native=json.loads((FIX/'native-output/receipts.json').read_text())[0]
    receipt=canonical_native(native,page_count=1,user_unit=1)
    def renderer(path,page,cache,digest):
        png=cache/'first.png';shutil.copyfile(FIX/'native-output/page-0.png',png);return receipt,png
    drafts=PDFDrafts(tmp_path/'device','w','p',native_picker=lambda:source,native_renderer=renderer)
    draft=drafts.select(0)['draft']
    args={'draft_id':draft['draft_id'],'expected_draft_revision':1,'page_index':0}
    return drafts,args,source

def grid():
    return {'bbox':[0,0,160,88],'v':[{'position':i*10,'slope':0,'coverage':1} for i in range(17)],
      'h':[{'position':i*4,'slope':0,'coverage':1} for i in range(23)]}

def synthetic_worker(data,cancelled):
    result=cells_from_lines(grid(),lambda a,b:1)
    for c in result['cells']:c.update(state='proposal',text='003 / 02A ↑',score=.7)
    result.update(schema='mirrororder.paper_ocr_worker.v1',png_sha256=hashlib.sha256(data).hexdigest(),model_sha256=MODEL_SHA,authority=False)
    return result

def test_proposal_only_hash_bound_no_transcription_write(tmp_path):
    drafts,args,_=setup(tmp_path);before=drafts.read()
    result=analyze_draft_page(drafts,**args,worker=synthetic_worker)
    assert len(result['cells'])==352 and result['cells'][0]['raw_ocr_text']=='003 / 02A ↑'
    assert not result['authority'] and not result['writes_to_paper'] and result['review_required']
    assert result['cells'][0]['score_is_probability'] is False
    assert drafts.read()==before
    assert analyze_draft_page(drafts,**args,worker=synthetic_worker)['candidate_id']==result['candidate_id']

def test_missing_runtime_and_unprepared_page_are_not_fake_no_grid(tmp_path):
    drafts,args,_=setup(tmp_path)
    result=analyze_draft_page(drafts,**args)
    assert result['status']=='blocked' and 'unavailable' in result['reason']
    with pytest.raises(ValueError,match='draft_page_out_of_range'):analyze_draft_page(drafts,**{**args,'page_index':1})

def test_cancel_and_changed_source_no_publication(tmp_path):
    drafts,args,source=setup(tmp_path)
    assert analyze_draft_page(drafts,**args,cancelled=lambda:True)['status']=='cancelled'
    def changed(data,cancelled):
        source.write_bytes(b'changed');return synthetic_worker(data,cancelled)
    with pytest.raises(ValueError):analyze_draft_page(drafts,**args,worker=changed)

@pytest.mark.parametrize('bad',['hash','model','authority','score','outside','duplicate','incomplete'])
def test_invalid_worker_result_rejected(tmp_path,bad):
    drafts,args,_=setup(tmp_path)
    def worker(data,cancelled):
        r=synthetic_worker(data,cancelled)
        if bad=='hash':r['png_sha256']='f'*64
        if bad=='model':r['model_sha256']='f'*64
        if bad=='authority':r['authority']=True
        if bad=='score':r['cells'][0]['score']=float('nan')
        if bad=='outside':r['cells'][0]['pixel_polygon']=[[-1,0],[10,0],[10,4],[-1,4]]
        if bad=='duplicate':r['cells'][1]['column_index']=0
        if bad=='incomplete':r['cells'].pop()
        return r
    with pytest.raises(ValueError):analyze_draft_page(drafts,**args,worker=worker)

def test_grid_not_assumed_and_merged_edge_abstains():
    assert cells_from_lines({},lambda a,b:1)['status']=='no_grid'
    g=grid();g['v'].pop();assert cells_from_lines(g,lambda a,b:1)['status']=='ambiguous'
    g=grid();r=cells_from_lines(g,lambda a,b:0 if a[0]==0 and b[0]==0 else 1)
    assert r['status']=='ambiguous' and r['cells'][0]['state']=='ambiguous'
    assert all('text' not in c for c in r['cells'])

def test_no_grid_is_actual_worker_state_not_empty_success(tmp_path):
    drafts,args,_=setup(tmp_path)
    def empty(data,cancelled):return {'schema':'mirrororder.paper_ocr_worker.v1','status':'no_grid','cells':[],
      'png_sha256':hashlib.sha256(data).hexdigest(),'model_sha256':MODEL_SHA,'authority':False}
    result=analyze_draft_page(drafts,**args,worker=empty)
    assert result['status']=='no_grid' and not result['candidate_created'] and not result['cells']

@pytest.mark.parametrize('mode',['cancelled','timeout','memory'])
def test_supervisor_kills_only_owned_session_on_budget(tmp_path,monkeypatch,mode):
    from script_organizer import paper_ocr_provider as provider,speech_worker
    model=tmp_path/'model';model.write_bytes(b'synthetic')
    monkeypatch.setattr(provider,'runtime',lambda root:(tmp_path/'python',tmp_path/'packages',model))
    monkeypatch.setattr(provider,'bounded_hash',lambda *a:MODEL_SHA)
    class Process:
        pid=12345;returncode=None
        def poll(self):return self.returncode
    process=Process();stopped=[];calls=[]
    def start(*a,**kw):calls.append(kw);return process
    monkeypatch.setattr(provider.subprocess,'Popen',start)
    def stop(p):assert p is process;stopped.append(True);p.returncode=-9
    monkeypatch.setattr(speech_worker,'_stop',stop)
    monkeypatch.setattr(speech_worker,'_rss_kib',lambda pid:3*1024*1024 if mode=='memory' else 0)
    ticks=iter([0,99])
    monkeypatch.setattr(provider.time,'monotonic',lambda:next(ticks) if mode=='timeout' else 0)
    checks=iter([False,True])
    result=provider.run_worker(tmp_path,b'synthetic',lambda:next(checks) if mode=='cancelled' else False)
    assert stopped and calls[0]['start_new_session'] is True
    assert 'PATH' not in calls[0]['env']
    assert result['status']==('cancelled' if mode=='cancelled' else 'failed')
