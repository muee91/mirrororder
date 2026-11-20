"""One explicit reviewed OCR row to append-only derived paper transcription."""
import json
from .paper_ocr_review import candidate_projection,accepted_cells,OCRCellReviewStore,project_task_reader
from .paper_intake_store import PaperIntakeStore
from .slate_log_intake import FIELDS
from .paper_ocr_task import source_context
from .scene_interval_store import IntervalConflict


def read_review(config,project_id,task_id):
    projection=candidate_projection(project_task_reader(config,project_id)(task_id),project_id)
    return {**projection,'expected_review_revision':OCRCellReviewStore(config.output_dir,project_id).snapshot()['revision'],
      'expected_paper_revision':PaperIntakeStore(config.output_dir,project_id).snapshot()['revision'],
      'allowed_fields':list(FIELDS),'current_source_validation':'not_checked'}


def build_row(projection,row_id,decisions,column_mapping):
    selected=[r for r in projection['rows'] if r['row_id']==row_id]
    if len(selected)!=1:raise ValueError('unknown_source_row')
    row=selected[0];allowed={c['cell_id']:c for c in row['cells']}
    if any(item['cell_id'] not in allowed for item in decisions):raise ValueError('cross_row_decision')
    reviewed=accepted_cells(projection,{'expected_candidate_sha256':projection['expected_candidate_sha256'],'cells':decisions})
    if not isinstance(column_mapping,list) or not 1<=len(column_mapping)<=len(FIELDS):raise ValueError('explicit_column_mapping_required')
    mapping={};used=set()
    for pair in column_mapping:
        if not isinstance(pair,dict) or set(pair) not in ({'column_index','field'},{'column_index','field','paper_camera'}):raise ValueError('invalid_column_mapping')
        if 'paper_camera' in pair and (pair['field']!='filename' or pair['paper_camera'] not in ('A','B','C')):
            raise ValueError('invalid_paper_camera_column')
        col,field=pair['column_index'],pair['field']
        if type(col) is not int or not 0<=col<16 or field not in FIELDS or col in mapping or field in used:raise ValueError('duplicate_or_invalid_column_mapping')
        mapping[col]=field;used.add(field)
    raw={'pdf_page':projection['source']['page_index']+1,'row_index':row_id}
    missing=[];emitted=0
    bycol={c['machine_original']['column_index']:c for c in reviewed['cells']}
    for col,field in mapping.items():
        cell=bycol.get(col)
        if not cell:raise ValueError('mapped_cell_requires_explicit_decision')
        pair=next(pair for pair in column_mapping if pair['column_index']==col)
        if 'paper_camera' in pair and cell['reviewed_text'] is None:
            raise ValueError('paper_camera_requires_literal_reviewed_filename')
        if cell['reviewed_text'] is None:missing.append({'field':field,'state':cell['transcription_status'],'cell_id':cell['cell_id']})
        else:raw[field]=cell['reviewed_text'];emitted+=1
    if not emitted:raise ValueError('no_reviewed_mapped_value')
    raw['uncertainties']=missing
    return raw,reviewed


def derive_row(config,project_id,drafts,request):
    fields={'task_id','row_id','expected_candidate_sha256','expected_review_revision','expected_paper_revision','cells','column_mapping'}
    if not isinstance(request,dict) or set(request)!=fields:raise ValueError('invalid_derived_row_request')
    reader=project_task_reader(config,project_id);task=reader(request['task_id'])
    projection=candidate_projection(task,project_id)
    if projection['expected_candidate_sha256']!=request['expected_candidate_sha256']:raise IntervalConflict('ocr_candidate_changed')
    def current(t):
        now=source_context(drafts,t['targets']);prior=t['result']['source']
        return all(now.get(k)==prior.get(k) for k in ('draft_id','draft_revision','page_index','pdf_sha256','mode','region_id','region_revision'))
    if current(task) is not True:raise IntervalConflict('ocr_source_changed')
    raw,reviewed=build_row(projection,request['row_id'],request['cells'],request['column_mapping'])
    # Both operations append only. Paper CAS failure leaves an honest reusable
    # review receipt, never a partially overwritten old paper document.
    store=OCRCellReviewStore(config.output_dir,project_id)
    saved=store.record(request['task_id'],{'expected_candidate_sha256':request['expected_candidate_sha256'],'cells':request['cells']},
      expected_revision=request['expected_review_revision'],task_reader=reader,source_validator=current)
    lineage={'kind':'explicit_reviewed_ocr_row_v1','review_receipt_id':saved['receipt_id'],
      'candidate_id':projection['candidate_id'],'candidate_sha256':projection['expected_candidate_sha256'],
      'source_row_id':request['row_id'],'source':projection['source'],'column_mapping':request['column_mapping'],
      'reviewed_cells':reviewed['cells'],'unselected_cell_count':reviewed['unselected_cell_count'],
      'editorial_authority':False,'original_machine_proposals_preserved':True}
    raw['derived_transcription']=lineage
    if current(reader(request['task_id'])) is not True:raise IntervalConflict('ocr_source_changed')
    content=json.dumps({'source_pdf':{'sha256':projection['source']['pdf_sha256']},'rows':[raw]},ensure_ascii=False)
    paper=PaperIntakeStore(config.output_dir,project_id)
    result=paper._ingest({'mode':'structured_slate_log.v1','operation':'ingest','format':'json','content':content,
      'expected_revision':request['expected_paper_revision']},derived_lineage=lineage)
    return {'status':result['import_status'],'paper_revision':result['revision'],'document_id':result['imported_document_id'],
      'review_revision':saved['revision'],'review_receipt_id':saved['receipt_id'],'transcription_origin':'explicit_reviewed_ocr_derivation',
      'editorial_authority':False,'interval_confirmed':False}
