import hashlib
import pytest
from test_paper_body_region import setup
from script_organizer.paper_draft_ipc import dispatch,validate
from script_organizer.paper_ocr_provider import analyze_draft_page,MODEL_SHA
from script_organizer.paper_ocr_task import validate_targets

def test_actual_private_dispatch_preview_save_read_remove(setup):
    drafts,store,ctx,render,_=setup
    common={**ctx,'project_id':'p'}
    page=dispatch({**common,'action':'preview_page'},drafts)
    assert page['render_map_id']==render and page['page_index']==0 and page['png_base64']
    result=dispatch({**common,'action':'region_set','expected_region_revision':0,'expected_render_map_id':render,'pixel_rect':[10,10,90,90]},drafts)
    assert result['region']['region_origin']=='explicit_user_selection'
    assert dispatch({**common,'action':'region_read'},drafts)==result
    assert dispatch({**common,'action':'region_remove','expected_region_revision':1,'expected_render_map_id':render},drafts)['status']=='removed'

def worker(png,cancelled):
    return {'schema':'mirrororder.paper_ocr_worker.v1','status':'ambiguous','reason':'unsupported_grid_topology',
            'cells':[],'png_sha256':hashlib.sha256(png).hexdigest(),'model_sha256':MODEL_SHA,'authority':False,'recognition_mode':'manual_body_region'}

def test_manual_mode_proposals_and_removed_during_inference(setup):
    d,store,ctx,render,_=setup
    selection=store.set(**ctx,expected_region_revision=0,expected_render_map_id=render,pixel_rect=[10,10,90,90])
    manual={'region_id':selection['region']['region_id'],'expected_region_revision':1}
    result=analyze_draft_page(d,**ctx,manual_region=manual,worker=worker)
    assert result['recognition_mode']=='manual_body_region' and result['status']=='ambiguous' and not result['candidate_created']
    assert result['body_region']['pdf_polygon']==selection['region']['pdf_polygon']
    def changed(png,c):
        store.remove(**ctx,expected_region_revision=1,expected_render_map_id=render);return worker(png,c)
    with pytest.raises(Exception,match='body_region_changed'):analyze_draft_page(d,**ctx,manual_region=manual,worker=changed)

def test_no_manual_mode_claim_without_worker_support(setup):
    d,store,ctx,render,_=setup
    item=store.set(**ctx,expected_region_revision=0,expected_render_map_id=render,pixel_rect=[10,10,90,90])
    def bad(png,c):
        r=worker(png,c);r.pop('recognition_mode');return r
    with pytest.raises(ValueError,match='mode_mismatch'):analyze_draft_page(d,**ctx,manual_region={'region_id':item['region']['region_id'],'expected_region_revision':1},worker=bad)

def test_no_client_path_or_direct_task_polygon(setup):
    d,store,ctx,render,_=setup
    with pytest.raises(ValueError):validate({**ctx,'project_id':'p','action':'region_set','path':'fake'})
    validate_targets({**ctx,'mode':'manual_body_region','region_id':'paper-body-x','expected_region_revision':1})
    with pytest.raises(ValueError):validate_targets({**ctx,'pixel_rect':[1,1,2,2]})
