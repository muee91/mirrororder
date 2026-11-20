import hashlib,json,shutil,sys,subprocess,os
from pathlib import Path
import pytest
from script_organizer.paper_source_binding import PaperSourceStore,canonical_native
from script_organizer.paper_preview_service import LocalPaperPreview
from pypdf import PdfReader
FIX=Path(__file__).parent/'fixtures/paper-native'

def setup(tmp_path):
    src=tmp_path/'selected.pdf';shutil.copyfile(FIX/'renderer/evidence/page-0.pdf',src)
    native=json.loads((FIX/'native-output/receipts.json').read_text())[0]
    pdf=PdfReader(src);receipt=canonical_native(native,page_count=len(pdf.pages),user_unit=pdf.pages[0].get('/UserUnit',1))
    paper=PaperSourceStore(tmp_path/'project','p')
    result=paper.ingest(dict(mode='structured_slate_log.v1',operation='ingest',format='json',expected_revision=0,
        content=json.dumps({'source_pdf':{'sha256':receipt['pdf_sha256']},'rows':[{'pdf_page':1,'row_index':1,'scene_raw':'003','notes_raw':'中文'}]})))
    doc=result['documents'][0];row=result['rows'][0];calls=[]
    def picker():calls.append('picker');return src
    def renderer(path,page,cache,expected_digest):
        calls.append('renderer');assert path==src and page==0
        out=cache/'native.png'
        if not out.exists():shutil.copyfile(FIX/'native-output/page-0.png',out)
        return receipt,out
    service=LocalPaperPreview(paper,tmp_path/'device',native_picker=picker,native_renderer=renderer)
    args=dict(document_id=doc['document_id'],expected_paper_revision=1,expected_document_digest=doc['digest'],page_index=0)
    return service,args,paper,row,calls,src

def test_actual_native_preview_highlight_restart(tmp_path):
    service,args,paper,row,calls,src=setup(tmp_path)
    before=paper.path.read_bytes();registered=service.register_selected(**args)
    assert calls==['picker','renderer'] and paper.path.read_bytes()==before
    binding=registered['binding_id']
    attachment=paper.attach(paper_row_id=row['paper_row_id'],expected_revision=1,expected_row_digest=row['row_digest'],expected_document_digest=row['document_digest'],render_binding_id=binding,
       pixel_polygon=[[20,60],[40,60],[40,80],[20,80]],cell_pointer='/notes_raw',receipt_reader=service.receipt_reader)
    fresh=LocalPaperPreview(PaperSourceStore(paper.path.parent,'p'),tmp_path/'device',native_picker=lambda:pytest.fail('no picker on read'),native_renderer=lambda *a:pytest.fail('no render on read'))
    dto,png=fresh.preview(binding,paper_row_id=row['paper_row_id'])
    direct=fresh.preview_geometry(attachment['geometry_id'])
    assert direct['png']==png and direct['geometry_id']==attachment['geometry_id']
    with pytest.raises(ValueError):fresh.preview_geometry('/etc/passwd')
    assert len(dto['highlights'])==1 and dto['source_bytes_currently_checked']
    assert dto['receipt']['render_map']['image_sha256']==hashlib.sha256(png).hexdigest()
    assert str(tmp_path) not in json.dumps(dto) and not dto['authority'] and not dto['ocr_performed']
    env={**os.environ,'PYTHONPATH':os.pathsep.join([str(Path(__file__).parent),str(Path(__import__('script_organizer').__file__).parent.parent)]),'PYTHONDONTWRITEBYTECODE':'1'}
    code='from script_organizer.paper_source_binding import PaperSourceStore;from script_organizer.paper_preview_service import LocalPaperPreview;import sys; p=LocalPaperPreview(PaperSourceStore(sys.argv[1],"p"),sys.argv[2],native_picker=None,native_renderer=None); d,b=p.preview(sys.argv[3],paper_row_id=sys.argv[4]);print(len(d["highlights"]))'
    child=subprocess.run([sys.executable,'-c',code,str(paper.path.parent),str(tmp_path/'device'),binding,row['paper_row_id']],env=env,text=True,capture_output=True,check=True)
    assert child.stdout.strip()=='1'

def test_scope_unknown_paths_replaced_and_wrong_row(tmp_path):
    service,args,paper,row,_,src=setup(tmp_path);binding=service.register_selected(**args)['binding_id']
    for unknown in ('/etc/passwd','../selected.pdf','https://example.com/file','f'*64):
        with pytest.raises(ValueError):service.preview(unknown,paper_row_id=row['paper_row_id'])
    other=LocalPaperPreview(PaperSourceStore(tmp_path/'other','p'),tmp_path/'device',native_picker=None,native_renderer=None)
    with pytest.raises(ValueError,match='unregistered'):other.preview(binding,paper_row_id=row['paper_row_id'])
    with pytest.raises(ValueError,match='row_not'):service.preview(binding,paper_row_id='wrong')
    src.write_bytes(b'replaced')
    with pytest.raises(ValueError,match='original_pdf'):service.preview(binding,paper_row_id=row['paper_row_id'])

@pytest.mark.parametrize('mode',['stale','cancel','wrong_pdf','outside','bad_receipt','race'])
def test_failed_registration_no_registry_record(tmp_path,mode):
    service,args,paper,row,calls,src=setup(tmp_path)
    if mode=='stale':args['expected_paper_revision']=0
    if mode=='cancel':service.picker=lambda:None
    if mode=='wrong_pdf':src.write_bytes(b'not pdf')
    original=service.renderer
    if mode=='outside':
        def render(*a):r,p=original(*a);return r,src
        service.renderer=render
    if mode=='bad_receipt':
        def render(*a):r,p=original(*a);return {**r,'path':str(src)},p
        service.renderer=render
    if mode=='race':
        def render(*a):r,p=original(*a);src.write_bytes(b'changed');return r,p
        service.renderer=render
    if mode=='cancel':assert service.register_selected(**args)=={'status':'cancelled'}
    else:
        with pytest.raises(ValueError):service.register_selected(**args)
    with service._db() as db:assert db.execute('SELECT count(*) FROM renders').fetchone()[0]==0
    if mode=='stale':assert calls==[]

@pytest.mark.parametrize('field',['path','selected_path','workspace','native_helper','grant','url'])
def test_public_ipc_does_not_accept_file_authority(field):
    from script_organizer.paper_preview_ipc import validate
    request={'action':'preview','project_id':'p','geometry_id':'a'*64,field:'arbitrary'}
    with pytest.raises(ValueError):validate(request)

def test_dispatch_project_binding_and_actual_image(tmp_path):
    import base64
    from script_organizer.paper_preview_ipc import dispatch
    service,args,paper,row,_,_=setup(tmp_path)
    result=dispatch({'action':'register','project_id':'p',**args},service)
    page=dispatch({'action':'preview_page','project_id':'p','binding_id':result['binding_id'],'paper_row_id':row['paper_row_id']},service)
    assert page['highlights']==[] and base64.b64decode(page['png_base64'])
    attached=paper.attach(paper_row_id=row['paper_row_id'],expected_revision=1,expected_row_digest=row['row_digest'],expected_document_digest=row['document_digest'],render_binding_id=result['binding_id'],pixel_polygon=[[20,60],[40,60],[40,80],[20,80]],cell_pointer='/notes_raw',receipt_reader=service.receipt_reader)
    request={'action':'preview','project_id':'p','geometry_id':attached['geometry_id']}
    image=dispatch(request,service)
    assert hashlib.sha256(base64.b64decode(image['png_base64'])).hexdigest()==image['image_sha256']
    with pytest.raises(ValueError,match='project'):dispatch({**request,'project_id':'other'},service)

def test_fixed_helper_exact_envelope_and_fail_closed(tmp_path,monkeypatch):
    from script_organizer.native_pdf_adapter import NativePDFRenderer
    from script_organizer.resource_scheduler import ResourceCancelled
    helper=tmp_path/'fixed-native';helper.write_bytes(b'not executed')
    source=FIX/'renderer/evidence/page-0.pdf'
    native=json.loads((FIX/'native-output/receipts.json').read_text())[0]
    calls=[];processes=[]
    mode='render'
    class Process:
        def __init__(self,command,**kwargs):
            assert command==[str(helper)]
            assert kwargs=={'stdin':subprocess.PIPE,'stdout':subprocess.PIPE,'stderr':subprocess.DEVNULL}
            self.returncode=None;self.request=None;self.killed=False;self.waited=False
            processes.append(self)
        def communicate(self,*,input,timeout):
            assert timeout==.1
            if self.request is None:
                request=self.request=json.loads(input);calls.append(request)
                assert set(request)=={'pdf_path','expected_pdf_sha256','page_index','output_png','selection_id'}
                assert request['pdf_path']==str(source) and request['page_index']==0
                assert request['expected_pdf_sha256']==native['document_sha256']
                assert len(request['selection_id'])==32
                assert Path(request['output_png'])==tmp_path/(request['selection_id']+'.png')
                shutil.copyfile(FIX/'native-output/page-0.png',request['output_png'])
                # Polling must send the envelope once, not again on timeout.
                raise subprocess.TimeoutExpired([str(helper)],timeout)
            assert input is None
            self.returncode=0
            return json.dumps({**native,'status':'rendered',
                'schema':'mirrororder.native_pdf_render.v1' if mode!='malformed' else 'wrong-schema',
                'selection_id':self.request['selection_id'],'page_count':1,'user_unit':1}).encode(),None
        def poll(self):
            return self.returncode
        def kill(self):
            self.killed=True;self.returncode=-9
        def wait(self):
            self.waited=True
            return self.returncode
    monkeypatch.setattr('script_organizer.native_pdf_adapter.subprocess.Popen',Process)
    receipt,png=NativePDFRenderer(helper)(source,0,tmp_path,native['document_sha256'])
    assert png.exists() and receipt['page_count']==1 and len(calls)==1
    with pytest.raises(ValueError,match='missing'):
        NativePDFRenderer(tmp_path/'missing')(source,0,tmp_path,native['document_sha256'])
    assert len(processes)==1
    mode='malformed'
    with pytest.raises(ValueError,match='native_pdf_receipt_mismatch'):
        NativePDFRenderer(helper)(source,0,tmp_path,native['document_sha256'])
    mode='cancel'
    with pytest.raises(ResourceCancelled):
        NativePDFRenderer(helper,cancelled=lambda:len(calls)==3)(source,0,tmp_path,native['document_sha256'])
    assert processes[-1].killed and processes[-1].waited
    assert not Path(calls[-1]['output_png']).exists()


def test_durable_row_discovery_without_binding_input(tmp_path):
    from script_organizer.paper_preview_ipc import dispatch,validate
    service,args,paper,row,calls,source=setup(tmp_path)
    request={'action':'discover','project_id':'p','paper_row_id':row['paper_row_id']}
    assert dispatch(request,service)['status']=='not_registered' and not calls
    registered=service.register_selected(**args);calls.clear()
    restarted=LocalPaperPreview(PaperSourceStore(paper.path.parent,'p'),tmp_path/'device',native_picker=None,native_renderer=None)
    found=dispatch(request,restarted)
    assert found['status']=='available' and found['binding_id']==registered['binding_id'] and not calls
    assert str(tmp_path) not in json.dumps(found)
    env={**os.environ,'PYTHONPATH':str(Path(__import__('script_organizer').__file__).parent.parent),'PYTHONDONTWRITEBYTECODE':'1'}
    code='from script_organizer.paper_source_binding import PaperSourceStore;from script_organizer.paper_preview_service import LocalPaperPreview;import sys; p=LocalPaperPreview(PaperSourceStore(sys.argv[1],"p"),sys.argv[2],native_picker=None,native_renderer=None);print(p.discover_row(sys.argv[3])["status"])'
    child=subprocess.run([sys.executable,'-c',code,str(paper.path.parent),str(tmp_path/'device'),row['paper_row_id']],env=env,text=True,capture_output=True,check=True)
    assert child.stdout.strip()=='available'
    source.write_bytes(b'replaced')
    assert dispatch(request,restarted)['status']=='unavailable'
    with pytest.raises(ValueError):validate({**request,'binding_id':'a'*64})

def test_explicit_reselection_rebinds_same_bytes_moved_path(tmp_path):
    service,args,paper,row,_,source=setup(tmp_path)
    first=service.register_selected(**args);moved=tmp_path/'moved.pdf';source.rename(moved)
    assert service.discover_row(row['paper_row_id'])['status']=='unavailable'
    service.picker=lambda:moved
    old=service.renderer
    def render(path,page,cache,claim):return old(source,page,cache,claim)
    service.renderer=render
    second=service.register_selected(**args)
    assert second['binding_id']==first['binding_id']
    assert service.discover_row(row['paper_row_id'])['status']=='available'
