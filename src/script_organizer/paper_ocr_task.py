"""Explicit single-page OCR task. Paths come only from the packaged Host."""
import hashlib,json,os
from pathlib import Path
from .paper_pdf_drafts import PDFDrafts
from .paper_ocr_provider import analyze_draft_page,MODEL_SHA,PROFILE
from .native_pdf_adapter import NativePDFRenderer
from .media_identity import device_state_dir
from .paper_source_binding import bounded_hash

FIELDS={'draft_id','expected_draft_revision','page_index'}
def validate_targets(targets):
    if not isinstance(targets,dict) or set(targets) not in (FIELDS,FIELDS|{'mode','region_id','expected_region_revision'}):raise ValueError('invalid_paper_ocr_targets')
    if 'mode' in targets:
        if targets['mode']!='manual_body_region' or not isinstance(targets['region_id'],str) or type(targets['expected_region_revision']) is not int or targets['expected_region_revision']<1:raise ValueError('invalid_manual_region')
    if not isinstance(targets['draft_id'],str) or not targets['draft_id'].startswith('pdf-draft-') or len(targets['draft_id'])!=74:raise ValueError('invalid_draft_id')
    if type(targets['expected_draft_revision']) is not int or targets['expected_draft_revision']<0:raise ValueError('draft_revision_required')
    if type(targets['page_index']) is not int or not 0<=targets['page_index']<500:raise ValueError('draft_page_required')

def implementation_digest():
    root=Path(__file__).parent
    names=('paper_ocr_task.py','paper_ocr_provider.py','paper_ocr_entry.py','paper_ocr_geometry.py','paper_grid_geometry.py','paper_rec_profile.py','paper_pdf_drafts.py','native_pdf_adapter.py','paper_source_binding.py','paper_body_region.py')
    return hashlib.sha256(b''.join(name.encode()+b'\0'+(root/name).read_bytes() for name in names)).hexdigest()

def service(workspace_id,project_id,cancelled=lambda:False):
    # Set only by packaged Host startup, never task request or renderer JSON.
    helper=os.environ.get('MIRRORORDER_NATIVE_PDF_HELPER','')
    if os.environ.get('MIRRORORDER_PACKAGED_RUNTIME')!='1' or not helper:raise ValueError('packaged_pdf_renderer_unavailable')
    path=Path(helper)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():raise ValueError('packaged_pdf_renderer_unavailable')
    return PDFDrafts(device_state_dir(),workspace_id,project_id,native_picker=None,native_renderer=NativePDFRenderer(path,cancelled=cancelled))

def source_context(drafts,targets):
    validate_targets(targets)
    with drafts.connect() as db:
        db.execute('BEGIN');drafts.expected(db,targets['expected_draft_revision'])
        row=db.execute('SELECT pdf_sha,pages,private_path FROM drafts WHERE scope=? AND id=?',(drafts.scope,targets['draft_id'])).fetchone()
    if not row:raise ValueError('unknown_draft')
    sha,pages,path=row;drafts.public((targets['draft_id'],sha,pages))
    if targets['page_index']>=pages:raise ValueError('draft_page_out_of_range')
    if bounded_hash(path,33554432)!=sha:raise ValueError('original_pdf_changed')
    context={'draft_id':targets['draft_id'],'draft_revision':targets['expected_draft_revision'],'page_index':targets['page_index'],
      'pdf_sha256':sha,'model_sha256':MODEL_SHA,'profile':PROFILE, 'implementation_sha256':implementation_digest()}
    if 'mode' in targets:
        from .paper_body_region import PaperBodyRegions
        item=PaperBodyRegions(drafts).read(draft_id=targets['draft_id'],expected_draft_revision=targets['expected_draft_revision'],page_index=targets['page_index'])
        if item['region_revision']!=targets['expected_region_revision'] or not item.get('region') or item['region']['region_id']!=targets['region_id']:raise ValueError('manual_region_changed')
        context.update(mode='manual_body_region',region_id=targets['region_id'],region_revision=targets['expected_region_revision'])
    return context

def request_key(workspace_id,project_id,targets):
    context=source_context(service(workspace_id,project_id),targets)
    return 'paper-ocr-'+hashlib.sha256(json.dumps([workspace_id,project_id,context],sort_keys=True,separators=(',',':')).encode()).hexdigest()

def run(workspace_id,project_id,targets,cancelled):
    drafts=service(workspace_id,project_id,cancelled)
    context=source_context(drafts,targets)
    if cancelled():return {'status':'cancelled','candidate_created':False,'source':context}
    request={k:targets[k] for k in FIELDS}
    manual={k:targets[k] for k in ('region_id','expected_region_revision')} if 'mode' in targets else None
    result=analyze_draft_page(drafts,**request,cancelled=cancelled,manual_region=manual)
    if cancelled():return {'status':'cancelled','candidate_created':False,'source':context}
    if source_context(drafts,targets)!=context:raise ValueError('ocr_source_changed')
    return {**result,'source':context,'review_required':True,'authority':False,'writes_to_paper':False}
