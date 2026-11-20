import copy,hashlib
import pytest
from script_organizer.paper_ocr_geometry import guard_manual_region
from script_organizer.paper_ocr_provider import analyze_draft_page,MODEL_SHA
from test_paper_body_region import setup

def cell(points):return {'pixel_polygon':points,'state':'geometry_candidate'}
def test_actual_anonymous_extrapolation_rejects_grid_without_clamping():
    good=[[330.,700.],[340.,700.],[340.,710.],[330.,710.]]
    cells=[cell(copy.deepcopy(good)) for _ in range(352)]
    cells[14]['pixel_polygon'][1]=[821.2362310486421,696.8985583570472]
    cells[15]['pixel_polygon'][0]=[821.2362310486421,696.8985583570472]
    cells[15]['pixel_polygon'][1]=[871.968092383989,696.6968082214778]
    original=copy.deepcopy(cells)
    out=guard_manual_region({'status':'ambiguous','cells':cells},[327,697,883,1039])
    assert out['status']=='ambiguous' and out['cells']==[]
    assert out['unsafe_cell_count']==2 and out['withheld_cell_count']==352
    assert cells==original

def test_exact_edges_allowed_no_epsilon():
    good={'status':'grid_candidates','cells':[cell([[0,0],[100,0],[100,100],[0,100]])]}
    assert guard_manual_region(good,[0,0,100,100]) is good
    bad=copy.deepcopy(good);bad['cells'][0]['pixel_polygon'][0][1]=-1e-15
    assert guard_manual_region(bad,[0,0,100,100])['cells']==[]

def test_region_abstention_survives_provider(setup):
    drafts,store,ctx,render,_=setup
    item=store.set(**ctx,expected_region_revision=0,expected_render_map_id=render,pixel_rect=[10,10,90,90])
    manual={'region_id':item['region']['region_id'],'expected_region_revision':1}
    def worker(png,c):
        return {'schema':'mirrororder.paper_ocr_worker.v1','status':'ambiguous','reason':'grid_extrapolates_outside_manual_region','cells':[],
           'examined_cell_count':352,'unsafe_cell_count':2,'withheld_cell_count':352,
           'png_sha256':hashlib.sha256(png).hexdigest(),'model_sha256':MODEL_SHA,'authority':False,'recognition_mode':'manual_body_region'}
    result=analyze_draft_page(drafts,**ctx,manual_region=manual,worker=worker)
    assert result['unsafe_cell_count']==2 and result['withheld_cell_count']==352 and result['cells']==[]
    assert not result['candidate_created'] and not result['authority']

def test_guard_precedes_any_recognition():
    from script_organizer import paper_ocr_entry
    from pathlib import Path
    src=Path(paper_ocr_entry.__file__).read_text()
    assert src.index('output=guard_manual_region')<src.index('ready=[')<src.index('recognizer=CPURecognizer')
