"""Explicit single-page provider from a verified local draft, never UI pixels."""
import hashlib,json,math,os,subprocess,tempfile,time
from pathlib import Path
from .paper_source_binding import bounded_hash,make_geometry
from .source_descriptor_receipt import _digest

PROFILE='ppocrv5-mobile-rec-grid-v1'
MODEL_SHA='5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5'


def runtime(data_root):
    root=Path(data_root)/'paper-ocr'/PROFILE
    python=root/'python/bin/python3';packages=root/'site-packages';model=root/'model/ch_PP-OCRv5_rec_mobile.onnx'
    paths=[python,model,packages/'onnxruntime/__init__.py',packages/'onnx/__init__.py',packages/'cv2/__init__.py',packages/'numpy/__init__.py']
    try:
        if any(not p.is_file() or root.resolve() not in p.resolve(strict=True).parents for p in paths):return None
        if not os.access(python,os.X_OK):return None
    except OSError:return None
    return python,packages,model


def run_worker(data_root,png_bytes,cancelled,*,manual_region=None):
    selected=runtime(data_root)
    if selected is None:return {'status':'blocked','reason':'ocr_runtime_or_model_unavailable'}
    if cancelled():return {'status':'cancelled'}
    python,packages,model=selected
    if bounded_hash(model,32*1024*1024)!=MODEL_SHA:return {'status':'blocked','reason':'ocr_model_mismatch'}
    from .speech_worker import _stop,_rss_kib
    with tempfile.TemporaryDirectory(prefix='mirrororder-paper-ocr-') as tmp:
        png=Path(tmp)/'page.png';png.write_bytes(png_bytes);result=Path(tmp)/'result.json'
        env={'HOME':tmp,'TMPDIR':tmp,'OMP_NUM_THREADS':'2','OPENBLAS_NUM_THREADS':'2','DO_NOT_TRACK':'1'}
        args=[str(python),'-I','-B',str(Path(__file__).with_name('paper_ocr_entry.py')),str(packages),str(model),str(png),str(result)]
        if manual_region is not None:
            args.append(json.dumps({'pixel_rect':manual_region['pixel_rect'],'mode':'manual_body_region'},ensure_ascii=True,separators=(',',':')))
        process=subprocess.Popen(args,cwd=tmp,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        deadline=time.monotonic()+26;failure=None
        try:
            while process.poll() is None:
                if cancelled():failure='cancelled';break
                if time.monotonic()>deadline:failure='timeout';break
                rss=_rss_kib(process.pid)
                if rss is not None and rss>2*1024*1024:failure='memory_budget';break
                time.sleep(.1)
        finally:
            if process.poll() is None:_stop(process)
        if failure:return {'status':'cancelled' if failure=='cancelled' else 'failed','reason':failure}
        if process.returncode or not result.is_file():return {'status':'failed','reason':'worker_failed_or_budget'}
        with result.open('rb') as stream:raw=stream.read(2*1024*1024+1)
        if len(raw)>2*1024*1024:raise ValueError('ocr_result_budget')
        return json.loads(raw)


def _worker_polygon(points,receipt):
    """Bound internal proposed coordinates, not stored or client geometry."""
    from fractions import Fraction as F
    from decimal import Decimal,localcontext,ROUND_HALF_EVEN
    if not isinstance(points,list) or len(points)!=4:raise ValueError('ocr_polygon_shape')
    raw=[];result=[];errors=[]
    for point in points:
        if not isinstance(point,list) or len(point)!=2:raise ValueError('ocr_polygon_shape')
        old=[];new=[]
        for value in point:
            if type(value) not in (int,float) or not math.isfinite(value) or abs(value)>100000:raise ValueError('ocr_polygon_number')
            exact=F(str(value))
            if exact.denominator>10**24:raise ValueError('ocr_polygon_precision')
            with localcontext() as ctx:
                ctx.prec=80
                q=F(Decimal(str(value)).quantize(Decimal('0.000001'),rounding=ROUND_HALF_EVEN))
            error=abs(exact-q)
            if error>F(1,1000000):raise ValueError('ocr_polygon_projection_error')
            old.append(exact);new.append(str(q));errors.append(error)
        raw.append(old);result.append(new)
    rm=receipt['render_map'];m=list(map(F,rm['pixel_to_pdf']));x0,y0,x1,y1=map(F,receipt['cropbox'])
    for x,y in raw:
        if not (0<=x<=rm['width'] and 0<=y<=rm['height']):raise ValueError('outside_raster')
        z=m[6]*x+m[7]*y+m[8]
        if z==0:raise ValueError('invalid_projection')
        px,py=(m[0]*x+m[1]*y+m[2])/z,(m[3]*x+m[4]*y+m[5])/z
        if not(x0<=px<=x1 and y0<=py<=y1):raise ValueError('outside_pdf_cropbox')
    return result,{'kind':'worker_pixel_decimal_v1','raw_pixel_polygon':[[str(v) for v in p] for p in raw],
      'decimal_places':6,'rounding':'half_even','max_coordinate_error_px':str(max(errors)),'error_limit_px':'1/1000000'}


def analyze_draft_page(drafts,*,draft_id,expected_draft_revision,page_index,cancelled=lambda:False,worker=None,manual_region=None):
    """Trusted service only; test seam worker is NOT exposed by any IPC/schema."""
    if cancelled():return {'status':'cancelled','candidate_created':False}
    with drafts.selected_page(draft_id=draft_id,expected_draft_revision=expected_draft_revision,page_index=page_index) as (page,png):
        region=None
        if manual_region is not None:
            from .paper_body_region import PaperBodyRegions
            store=PaperBodyRegions(drafts)
            region=store.require_current(draft_id=draft_id,expected_draft_revision=expected_draft_revision,page_index=page_index,
                region_id=manual_region['region_id'],region_revision=manual_region['expected_region_revision'],page=page)
        result=_analyze_verified_page(drafts,page,png,cancelled,worker,region)
        if region is not None:
            store.require_current(draft_id=draft_id,expected_draft_revision=expected_draft_revision,page_index=page_index,
                region_id=manual_region['region_id'],region_revision=manual_region['expected_region_revision'],page=page)
        return result


def _analyze_verified_page(drafts,page,png,cancelled,worker,region=None):
    draft_id=page['draft_id'];page_index=page['page_index']
    receipt=page['receipt'];image_sha=hashlib.sha256(png).hexdigest()
    if image_sha!=receipt['render_map']['image_sha256']:raise ValueError('verified_page_hash_mismatch')
    def selected_worker(data,check):
        if region is None:return run_worker(drafts.root,data,check)
        return run_worker(drafts.root,data,check,manual_region=region)
    result=(worker or selected_worker)(png,cancelled)
    if cancelled():return {'status':'cancelled','candidate_created':False}
    if result.get('status') in ('blocked','cancelled','failed'):
        return {'status':result['status'],'reason':result.get('reason'),'candidate_created':False}
    if region is not None and result.get('recognition_mode')!='manual_body_region':raise ValueError('manual_region_worker_mode_mismatch')
    if result.get('schema')!='mirrororder.paper_ocr_worker.v1' or result.get('status') not in ('no_grid','ambiguous','grid_candidates') or result.get('png_sha256')!=image_sha or result.get('model_sha256')!=MODEL_SHA or result.get('authority') is not False:raise ValueError('invalid_ocr_worker_contract')
    cells=result.get('cells')
    if not isinstance(cells,list) or len(cells)>352:raise ValueError('ocr_cell_budget')
    if (result['status']=='no_grid' and cells) or (result['status']=='grid_candidates' and (len(cells)!=352 or any(c.get('state')!='proposal' for c in cells))):raise ValueError('incomplete_grid_result')
    normalized=[];seen=set()
    for cell in cells:
        row,col=cell.get('row_index'),cell.get('column_index');state=cell.get('state')
        if type(row) is not int or type(col) is not int or not(0<=row<22 and 0<=col<16) or (row,col) in seen or state not in ('proposal','ambiguous'):raise ValueError('invalid_ocr_cell')
        seen.add((row,col));points,geometry_witness=_worker_polygon(cell['pixel_polygon'],receipt)
        original=make_geometry(receipt,points)
        if region is not None:
            from fractions import Fraction
            x0,y0,x1,y1=region['pixel_rect']
            if any(not(x0<=Fraction(x)<=x1 and y0<=Fraction(y)<=y1) for x,y in points):raise ValueError('ocr_cell_outside_selected_body')
        text=cell.get('text','');score=cell.get('score')
        if not isinstance(text,str) or len(text)>2048:raise ValueError('ocr_text_budget')
        if state=='ambiguous' and text:raise ValueError('unproven_cell_text')
        if state=='proposal' and (type(score) not in (int,float) or not math.isfinite(score) or not 0<=score<=1):raise ValueError('invalid_ocr_score')
        normalized.append({'row_index':row,'column_index':col,'state':state,'raw_ocr_text':text,'score':score,
          'score_is_probability':False,'geometry_normalization':geometry_witness,'pixel_polygon':points,'pdf_polygon':original,'review_required':True,'authority':False})
    output={'contract':'mirrororder.paper_ocr_candidates.v1','status':result['status'],'draft_id':draft_id,'draft_version':1,
      'pdf_sha256':receipt['pdf_sha256'],'page_index':page_index,'image_sha256':image_sha,'render_map_id':_digest(receipt['render_map']),
      'profile':PROFILE,'form_profile':'studied_16_column_22_row_grid','model_sha256':MODEL_SHA,'cells':normalized,'candidate_created':bool(normalized),
      'review_required':True,'authority':False,'writes_to_paper':False}
    output['recognition_mode']='manual_body_region' if region is not None else 'automatic_full_page'
    if result.get('reason')=='grid_extrapolates_outside_manual_region':
        if region is None or result['status']!='ambiguous' or cells:raise ValueError('invalid_region_abstention')
        counts={k:result.get(k) for k in ('examined_cell_count','unsafe_cell_count','withheld_cell_count')}
        if any(type(v) is not int or not 0<=v<=352 for v in counts.values()) or not(1<=counts['unsafe_cell_count']<=counts['examined_cell_count']==counts['withheld_cell_count']):raise ValueError('invalid_region_abstention_counts')
        output.update(reason='grid_extrapolates_outside_manual_region',**counts)
    if region is not None:
        output['body_region']={key:region[key] for key in ('region_id','pixel_rect','pdf_polygon','region_origin')}
    output['candidate_id']=_digest(output)
    return output
