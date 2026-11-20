import copy,hashlib,json
from pathlib import Path
import pytest
from test_paper_ocr_provider import setup,synthetic_worker
from script_organizer.paper_ocr_provider import analyze_draft_page,_worker_polygon

def test_selected_page_once_and_cleanup_and_restart(tmp_path):
    d,args,source=setup(tmp_path)
    with d.connect() as db:
        raw=json.loads(db.execute('SELECT receipt FROM drafts').fetchone()[0]);raw['page_count']=3
        db.execute('UPDATE drafts SET pages=3,receipt=?',(json.dumps(raw),))
    calls=[]
    def render(path,page,cache,sha):
        calls.append(page);r=copy.deepcopy(raw);r['page_index']=page;r['page_number']=page+1
        p=cache/'selected.png';p.write_bytes((cache/'first.png').read_bytes());return r,p
    d.renderer=render
    r=analyze_draft_page(d,**{**args,'page_index':2},worker=synthetic_worker)
    assert calls==[2] and r['page_index']==2 and not (d.cache/'selected.png').exists()
    assert d.read()['revision']==1
    with pytest.raises(ValueError,match='out_of_range'):analyze_draft_page(d,**{**args,'page_index':3},worker=synthetic_worker)
    assert calls==[2]

def test_render_mismatch_and_revision_race(tmp_path):
    d,args,_=setup(tmp_path)
    with d.connect() as db:db.execute('UPDATE drafts SET pages=2')
    d.renderer=lambda *a: (_ for _ in ()).throw(ValueError('wrong renderer'))
    with pytest.raises(ValueError,match='wrong renderer'):analyze_draft_page(d,**{**args,'page_index':1},worker=synthetic_worker)

def test_worker_fraction_noise_and_not_clamped():
    receipt={'cropbox':['0','0','1400','1517'],'render_map':{'width':1400,'height':1517,'pixel_to_pdf':['1','0','0','0','1','0','0','0','1']}}
    p=[[260.0,208.5],[319.99999999999994,208.5],[319.99999999999994,256.5],[260.0,256.5]]
    normalized,w=_worker_polygon(p,receipt)
    assert normalized[1][0]=='320' and w['max_coordinate_error_px']=='3/50000000000000'
    p[0][0]=-1e-14
    with pytest.raises(ValueError,match='outside_raster'):_worker_polygon(p,receipt)
