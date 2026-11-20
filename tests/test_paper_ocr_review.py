from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace
import pytest
from script_organizer.paper_ocr_review import *
from script_organizer.source_descriptor_receipt import _digest

def task():
    cells=[]
    for i,(state,text) in enumerate([('proposal','003'),('proposal','02A'),('ambiguous','')]):
        cells.append({'row_index':0,'column_index':i,'state':state,'raw_ocr_text':text,'score':.7 if text else None,
          'pixel_polygon':[['0','0'],['1','0'],['1','1'],['0','1']], 'pdf_polygon':[['0','0'],['1','0'],['1','1'],['0','1']],
          'authority':False,'review_required':True})
    r={'contract':'mirrororder.paper_ocr_candidates.v1','status':'ambiguous','draft_id':'d','page_index':0,'pdf_sha256':'a'*64,'model_sha256':'b'*64,
       'cells':cells,'authority':False,'writes_to_paper':False}
    r['candidate_id']=_digest(r);r['source']={k:r[k] for k in ('draft_id','page_index','pdf_sha256','model_sha256')}
    return {'task_id':'t','project_id':'p','type':'paper_ocr_page','status':'completed','result':r}

def request(t):
    p=candidate_projection(t,'p');c=p['rows'][0]['cells']
    return p,{'expected_candidate_sha256':p['expected_candidate_sha256'],'cells':[{'cell_id':c[0]['cell_id'],'action':'accept','text':'003'},
      {'cell_id':c[1]['cell_id'],'action':'correct','text':'02A ↑'}, {'cell_id':c[2]['cell_id'],'action':'unreadable','text':''}]}

def test_literal_and_unknown_no_semantic_assignment():
    t=task();p,r=request(t);out=accepted_cells(p,r)
    assert [c['reviewed_text'] for c in out['cells']]==['003','02A ↑',None]
    assert out['cells'][1]['machine_original']['raw_ocr_text']=='02A'
    assert not out['transcription_document_created'] and all(c['semantic_field'] is None for c in out['cells'])

@pytest.mark.parametrize('bad',['ambiguous_accept','silent_blank','duplicate','wrong_digest','foreign_cell'])
def test_bad_decision_rejected(bad):
    p,r=request(task())
    if bad=='ambiguous_accept':r['cells'][2].update(action='accept')
    if bad=='silent_blank':r['cells'][1].update(text='')
    if bad=='duplicate':r['cells'].append(r['cells'][0])
    if bad=='wrong_digest':r['expected_candidate_sha256']='f'*64
    if bad=='foreign_cell':r['cells'][0]['cell_id']='elsewhere'
    with pytest.raises(ValueError):accepted_cells(p,r)

def test_cas_restart_and_machine_provenance_immutable(tmp_path):
    t=task();p,r=request(t);store=OCRCellReviewStore(tmp_path,'p')
    result=store.record('t',r,expected_revision=0,task_reader=lambda _:t,source_validator=lambda _:True)
    assert store.record('t',r,expected_revision=1,task_reader=lambda _:t,source_validator=lambda _:True)['status']=='already_recorded'
    assert OCRCellReviewStore(tmp_path,'p').snapshot()==store.snapshot()
    with pytest.raises(IntervalConflict):store.record('t',r,expected_revision=0,task_reader=lambda _:t,source_validator=lambda _:True)
    assert not (tmp_path/'paper_intake.json').exists()

def test_source_or_candidate_change_rejected(tmp_path):
    t=task();p,r=request(t);store=OCRCellReviewStore(tmp_path,'p')
    with pytest.raises(ValueError):store.record('t',r,expected_revision=0,task_reader=lambda _:t,source_validator=lambda _:False)
    t['result']['cells'][0]['raw_ocr_text']='different'
    with pytest.raises(ValueError):candidate_projection(t,'p')
    assert not store.path.exists()

def test_persisted_project_task_projection(tmp_path):
    t=task();(tmp_path/'tasks.json').write_text(json.dumps({'tasks':[t]}))
    reader=project_task_reader(SimpleNamespace(output_dir=tmp_path),'p')
    assert candidate_projection(reader('t'),'p')['rows'][0]['cells'][0]['raw_ocr_text']=='003'
    with pytest.raises(ValueError):project_task_reader(SimpleNamespace(output_dir=tmp_path),'other')('t')
