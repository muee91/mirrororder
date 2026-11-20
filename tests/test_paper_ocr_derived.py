import json
from types import SimpleNamespace
import pytest
from test_paper_ocr_review import task,request
from script_organizer import paper_ocr_derived as mod
from script_organizer.paper_intake_store import PaperIntakeStore
from script_organizer.paper_ocr_review import OCRCellReviewStore
from script_organizer.paper_draft_ipc import dispatch
from script_organizer.scene_interval_store import IntervalConflict

def setup(tmp_path,monkeypatch):
    t=task();t['targets']={};(tmp_path/'tasks.json').write_text(json.dumps({'tasks':[t]}))
    monkeypatch.setattr(mod,'source_context',lambda *a:t['result']['source'])
    cfg=SimpleNamespace(output_dir=tmp_path);d=SimpleNamespace(project_id='p')
    p,r=request(t)
    req={'task_id':'t','row_id':p['rows'][0]['row_id'],'expected_candidate_sha256':p['expected_candidate_sha256'],
      'expected_review_revision':0,'expected_paper_revision':0,'cells':r['cells'],
      'column_mapping':[{'column_index':0,'field':'scene'},{'column_index':1,'field':'shot'},{'column_index':2,'field':'take'}]}
    return cfg,d,req

def public_import(store,scene,revision):
    return store.ingest({'mode':'structured_slate_log.v1','operation':'ingest','format':'json','expected_revision':revision,
       'content':json.dumps({'source_pdf':{'sha256':'a'*64},'rows':[{'pdf_page':1,'row_index':1,'scene':scene}]})})

def test_actual_private_dispatch_single_row_preserves_unknown(tmp_path,monkeypatch):
    cfg,d,req=setup(tmp_path,monkeypatch)
    read=dispatch({'action':'cell_review_read','project_id':'p','task_id':'t'},d,project_config=cfg)
    assert read['expected_paper_revision']==0 and read['column_meanings']=='unassigned'
    result=dispatch({'action':'reviewed_row','project_id':'p',**req},d,project_config=cfg)
    data=PaperIntakeStore(tmp_path,'p').snapshot();row=next(iter(data['rows'].values()))
    assert row['raw_row']['scene']=='003' and row['raw_row']['shot']=='02A ↑'
    assert 'take' not in row['raw_row'] and row['raw_row']['uncertainties'][0]['state']=='unreadable'
    assert not row['confirmed'] and row['state']=='review_required'
    assert result['transcription_origin']=='explicit_reviewed_ocr_derivation' and not result['interval_confirmed']
    assert row['raw_row']['derived_transcription']['reviewed_cells'][1]['machine_original']['raw_ocr_text']=='02A'
    assert PaperIntakeStore(tmp_path,'p').snapshot()==data

def test_same_pdf_derived_append_public_collision_unchanged(tmp_path,monkeypatch):
    cfg,d,req=setup(tmp_path,monkeypatch);store=PaperIntakeStore(tmp_path,'p')
    public_import(store,'old',0);old=store.snapshot();req['expected_paper_revision']=1
    mod.derive_row(cfg,'p',d,req)
    after=store.snapshot();assert len(after['documents'])==2
    for key,row in old['rows'].items():assert after['rows'][key]==row
    with pytest.raises(IntervalConflict):public_import(store,'different',2)
    req.update(expected_review_revision=1,expected_paper_revision=2)
    assert mod.derive_row(cfg,'p',d,req)['status']=='already_imported'
    assert len(store.snapshot()['documents'])==2

def test_column_mapping_never_guessed_or_unknown_blanked(tmp_path,monkeypatch):
    cfg,d,req=setup(tmp_path,monkeypatch)
    req['column_mapping']=[]
    with pytest.raises(ValueError):mod.derive_row(cfg,'p',d,req)
    assert not (tmp_path/'paper_intake.json').exists()

@pytest.mark.parametrize('field',['expected_candidate_sha256','expected_review_revision','expected_paper_revision'])
def test_stale_context_rejects_without_paper_overwrite(tmp_path,monkeypatch,field):
    cfg,d,req=setup(tmp_path,monkeypatch);req[field]='bad' if field.endswith('sha256') else 8
    with pytest.raises(ValueError):mod.derive_row(cfg,'p',d,req)
    assert not (tmp_path/'paper_intake.json').exists()

def test_source_changed_and_lineage_tamper(tmp_path,monkeypatch):
    cfg,d,req=setup(tmp_path,monkeypatch)
    monkeypatch.setattr(mod,'source_context',lambda *a:{'pdf_sha256':'f'*64})
    with pytest.raises(IntervalConflict):mod.derive_row(cfg,'p',d,req)
    assert not (tmp_path/'paper_intake.json').exists()
