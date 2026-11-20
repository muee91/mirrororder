"""Internal explicit transcription review receipts, not editorial/paper authority."""
from copy import deepcopy
import json,re
from pathlib import Path
from .scene_interval_store import SceneIntervalStore,IntervalConflict
from .source_descriptor_receipt import _digest

CONTRACT='mirrororder.paper_ocr_cell_review.v1'

def candidate_projection(task,project_id):
    if not isinstance(task,dict) or task.get('project_id')!=project_id or task.get('type')!='paper_ocr_page' or task.get('status')!='completed':raise ValueError('completed_project_ocr_task_required')
    result=task.get('result',{})
    if result.get('contract')!='mirrororder.paper_ocr_candidates.v1' or result.get('status') not in ('grid_candidates','ambiguous','no_grid') or result.get('authority') is not False or result.get('writes_to_paper') is not False:raise ValueError('ocr_candidate_contract')
    # Task execution adds source context after provider seals candidate_id.
    payload={k:v for k,v in result.items() if k not in ('candidate_id','source')}
    if result.get('candidate_id')!=_digest(payload):raise ValueError('ocr_candidate_digest_mismatch')
    source=result.get('source',{})
    if any(source.get(k)!=result.get(k) for k in ('draft_id','page_index','pdf_sha256','model_sha256')):raise ValueError('ocr_source_binding_mismatch')
    cells=result.get('cells')
    if not isinstance(cells,list) or len(cells)>352:raise ValueError('ocr_cells_invalid')
    rows={};seen=set()
    for c in cells:
        row,col=c.get('row_index'),c.get('column_index')
        if type(row) is not int or type(col) is not int or not(0<=row<22 and 0<=col<16) or (row,col) in seen or c.get('state') not in ('proposal','ambiguous'):raise ValueError('ocr_cell_identity_invalid')
        seen.add((row,col))
        if not isinstance(c.get('raw_ocr_text'),str) or c.get('authority') is not False:raise ValueError('ocr_cell_invalid')
        cid='ocr-cell-'+_digest({'candidate_id':result['candidate_id'],'cell':c})
        rows.setdefault(row,[]).append({'cell_id':cid,**deepcopy(c),'semantic_field':None})
    return {'task_id':task['task_id'],'candidate_id':result['candidate_id'],'expected_candidate_sha256':_digest(result),
      'source':deepcopy(source),'rows':[{'row_index':i,'row_id':'ocr-row-'+_digest([result['candidate_id'],i]),'cells':sorted(v,key=lambda c:c['column_index'])} for i,v in sorted(rows.items())],
      'column_meanings':'unassigned','authority':False,'transcription_document_created':False}


def accepted_cells(projection,request):
    if not isinstance(request,dict) or set(request)!={'expected_candidate_sha256','cells'} or request['expected_candidate_sha256']!=projection['expected_candidate_sha256']:raise IntervalConflict('ocr_candidate_changed')
    cells=request['cells']
    if not isinstance(cells,list) or not 1<=len(cells)<=352:raise ValueError('explicit_cell_selection_required')
    available={c['cell_id']:c for row in projection['rows'] for c in row['cells']}
    accepted=[];seen=set()
    for item in cells:
        if not isinstance(item,dict) or set(item)!={'cell_id','action','text'}:raise ValueError('invalid_cell_decision')
        cid,action,text=item['cell_id'],item['action'],item['text']
        if cid not in available or cid in seen or action not in ('accept','correct','unreadable','not_transcribed'):raise ValueError('invalid_cell_decision')
        seen.add(cid);original=available[cid]
        if not isinstance(text,str) or len(text)>2048:raise ValueError('review_text_budget')
        if action=='accept' and (original['state']!='proposal' or not original['raw_ocr_text'] or text!=original['raw_ocr_text']):raise ValueError('unsafe_machine_text_accept')
        if action=='correct' and not text.strip():raise ValueError('explicit_nonblank_correction_required')
        if action in ('unreadable','not_transcribed') and text!='':raise ValueError('unknown_text_must_remain_unknown')
        accepted.append({'cell_id':cid,'action':action,'reviewed_text':text if action in ('accept','correct') else None,
           'machine_original':deepcopy(original),'semantic_field':None,'transcription_status':'reviewed_text' if action in ('accept','correct') else action})
    return {'source':projection['source'],'candidate_id':projection['candidate_id'],'candidate_sha256':projection['expected_candidate_sha256'],
        'cells':accepted,'unselected_cell_count':len(available)-len(accepted),'editorial_authority':False,
        'transcription_document_created':False,'column_meanings':'unassigned'}

class OCRCellReviewStore(SceneIntervalStore):
    def __init__(self,output_dir,project_id):
        super().__init__(output_dir,project_id);self.path=Path(output_dir)/'paper_ocr_reviews.json'
    def snapshot(self):
        if not self.path.exists():return {'contract':CONTRACT,'project_id':self.project_id,'revision':0,'receipts':{}}
        data=json.loads(self.path.read_text(encoding='utf-8'))
        if data.get('contract')!=CONTRACT or data.get('project_id')!=self.project_id or type(data.get('revision')) is not int or not isinstance(data.get('receipts'),dict):raise ValueError('review_store_invalid')
        for key,item in data['receipts'].items():
            if key!='ocr-review-'+_digest(item) or item.get('editorial_authority') is not False or item.get('transcription_document_created') is not False:raise ValueError('review_receipt_invalid')
        return data
    def record(self,task_id,request,*,expected_revision,task_reader,source_validator):
        """Trusted explicit local action seam only; actor is not accepted in payload.

        Route not exposed yet. source_validator must check registered draft/current
        original bytes and page/region; task_reader reads local persisted tasks.
        """
        task=task_reader(task_id);projection=candidate_projection(task,self.project_id)
        if source_validator(task) is not True:raise ValueError('current_source_validation_required')
        receipt=accepted_cells(projection,request)
        receipt['review_origin']='explicit_local_cell_review'
        rid='ocr-review-'+_digest(receipt)
        with self._transaction(expected_revision) as data:
            current=candidate_projection(task_reader(task_id),self.project_id)
            if current!=projection or source_validator(task) is not True:raise IntervalConflict('ocr_candidate_or_source_changed')
            if rid in data['receipts']:return {'receipt_id':rid,'revision':data['revision'],'status':'already_recorded'}
            if len(data['receipts'])>=1000:raise ValueError('review_quota')
            data['receipts'][rid]=receipt
            if len(json.dumps(data,ensure_ascii=False).encode('utf-8'))>20000000:raise ValueError('review_bytes_quota')
            self._commit(data)
            return {'receipt_id':rid,'revision':data['revision'],'status':'recorded'}

def project_task_reader(config,project_id):
    """Config is Host-loaded, never a caller filename. No arbitrary task payload."""
    def read(task_id):
        path=config.output_dir/'tasks.json'
        with path.open('rb') as stream:raw=stream.read(20000001)
        if len(raw)>20000000:raise ValueError('task_read_budget')
        tasks=json.loads(raw).get('tasks',[])
        matches=[t for t in tasks if isinstance(t,dict) and t.get('task_id')==task_id and t.get('project_id')==project_id]
        if len(matches)!=1:raise ValueError('unknown_or_duplicate_task')
        return matches[0]
    return read

def record_project_review(config,workspace_id,project_id,task_id,request,*,expected_revision):
    """Internal trusted-local action consumer; not an exposed HTTP API."""
    from .paper_ocr_task import service,source_context
    drafts=service(workspace_id,project_id)
    def source_check(task):
        current=source_context(drafts,task['targets']);prior=task['result']['source']
        # New code does not invalidate the historical engine evidence; replacing
        # PDF/page/revision/manual selection does invalidate this review action.
        keys=('draft_id','draft_revision','page_index','pdf_sha256','mode','region_id','region_revision')
        return all(current.get(k)==prior.get(k) for k in keys)
    return OCRCellReviewStore(config.output_dir,project_id).record(task_id,request,expected_revision=expected_revision,
        task_reader=project_task_reader(config,project_id),source_validator=source_check)
