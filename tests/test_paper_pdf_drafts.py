import json,shutil,os,sys,subprocess
from pathlib import Path
import pytest
from script_organizer.paper_pdf_drafts import PDFDrafts
from script_organizer.paper_draft_ipc import dispatch,validate
from script_organizer.paper_source_binding import canonical_native
FIX=Path(__file__).parent/'fixtures/paper-native'

def setup(tmp_path,picker=True):
    source=tmp_path/'selected.pdf';shutil.copyfile(FIX/'renderer/evidence/page-0.pdf',source)
    receipt=canonical_native(json.loads((FIX/'native-output/receipts.json').read_text())[0],page_count=1,user_unit=1)
    calls=[]
    def choose():calls.append('picker');return source if picker else None
    def render(path,page,cache,digest):
        calls.append('renderer');assert page==0 and digest==receipt['pdf_sha256']
        out=cache/'first.png';shutil.copyfile(FIX/'native-output/page-0.png',out);return receipt,out
    service=PDFDrafts(tmp_path/'device','workspace','project',native_picker=choose,native_renderer=render)
    return service,source,calls,receipt

def test_fresh_no_json_claim_and_restart_idempotence(tmp_path):
    service,source,calls,receipt=setup(tmp_path)
    assert service.read()['drafts']==[]
    created=dispatch({'action':'select','project_id':'project','expected_draft_revision':0},service)
    assert created['status']=='registered' and created['revision']==1
    draft=created['draft'];assert draft['pdf_sha256']==receipt['pdf_sha256'] and draft['page_count']==1
    assert draft['transcription_state']=='not_created' and draft['ocr_state']=='not_run' and not draft['authority']
    assert service.select(1)['status']=='already_registered' and service.read()['revision']==1
    fresh=PDFDrafts(tmp_path/'device','workspace','project',native_picker=None,native_renderer=None)
    assert fresh.read()['drafts']==[draft]
    assert str(tmp_path) not in json.dumps(fresh.read())
    env={**os.environ,'PYTHONPATH':str(Path(__import__('script_organizer').__file__).parent.parent),'PYTHONDONTWRITEBYTECODE':'1'}
    code='from script_organizer.paper_pdf_drafts import PDFDrafts;import sys;print(len(PDFDrafts(sys.argv[1],"workspace","project",native_picker=None,native_renderer=None).read()["drafts"]))'
    child=subprocess.run([sys.executable,'-c',code,str(tmp_path/'device')],env=env,capture_output=True,text=True,check=True)
    assert child.stdout.strip()=='1'
    assert not (tmp_path/'paper_intake.json').exists()

def test_missing_engine_typed_blocked_no_ocr_write(tmp_path):
    service,source,calls,_=setup(tmp_path);created=service.select(0);calls.clear()
    request={'action':'ocr_candidate','project_id':'project','draft_id':created['draft']['draft_id'],'expected_draft_revision':1,'page_index':0}
    result=dispatch(request,service)
    assert result['reason']=='ocr_engine_unavailable' and not result['engine_invoked'] and not result['candidate_created'] and not calls
    assert service.read()['revision']==1
    source.write_bytes(b'replaced')
    with pytest.raises(ValueError,match='changed'):dispatch(request,service)

@pytest.mark.parametrize('field',['path','pdf_sha256','page_count','grant','engine','workspace','url'])
def test_no_client_source_or_engine_authority(field):
    with pytest.raises(ValueError):validate({'action':'select','project_id':'p','expected_draft_revision':0,field:'fake'})

def test_cancel_and_scope_and_stale(tmp_path):
    service,_,calls,_=setup(tmp_path,picker=False)
    assert service.select(0)['status']=='cancelled' and service.read()['revision']==0
    calls.clear()
    with pytest.raises(ValueError):service.select(1)
    assert not calls
    other=PDFDrafts(tmp_path/'device','other-workspace','project',native_picker=None,native_renderer=None)
    assert other.read()['drafts']==[]

def test_race_and_page_budget_fail_without_draft(tmp_path):
    service,_,_,receipt=setup(tmp_path)
    original=service.renderer
    def racing(*a):
        result=original(*a)
        with service.connect() as db:db.execute('UPDATE states SET revision=1 WHERE scope=?',(service.scope,))
        return result
    service.renderer=racing
    with pytest.raises(ValueError):service.select(0)
    assert service.read()['drafts']==[]
    service.renderer=original;receipt['page_count']=501
    with pytest.raises(ValueError,match='budget'):service.select(1)
    assert service.read()['drafts']==[]

def test_draft_first_page_preview_no_paper_row_or_claim(tmp_path):
    import base64,hashlib
    service,source,calls,receipt=setup(tmp_path)
    created=service.select(0);calls.clear()
    req={'action':'preview_first_page','project_id':'project','draft_id':created['draft']['draft_id'],'expected_draft_revision':1}
    result=dispatch(req,service)
    assert result['page_index']==0 and result['highlights']==[] and not calls
    assert hashlib.sha256(base64.b64decode(result['png_base64'])).hexdigest()==receipt['render_map']['image_sha256']
    assert str(tmp_path) not in json.dumps(result)
    with pytest.raises(ValueError):dispatch({**req,'page_index':1},service)
    source.write_bytes(b'replaced')
    with pytest.raises(ValueError):dispatch(req,service)

def test_draft_metadata_tamper_and_unknown_identity_fail(tmp_path):
    service,_,_,_=setup(tmp_path);created=service.select(0)
    with pytest.raises(ValueError):service.ocr_candidate(draft_id='pdf-draft-'+'f'*64,expected_draft_revision=1,page_index=0)
    with service.connect() as db:db.execute('UPDATE drafts SET pages=-1 WHERE scope=?',(service.scope,))
    with pytest.raises(ValueError,match='metadata'):service.read()
