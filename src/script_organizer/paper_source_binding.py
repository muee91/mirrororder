"""Internal-only source geometry append. No route, OCR or review authority."""
from copy import deepcopy
import hashlib,json
from pathlib import Path
from script_organizer.paper_geometry import digest,sha,polygon,project,rational,matrix
from script_organizer.paper_intake_store import PaperIntakeStore
from script_organizer.scene_interval_store import IntervalConflict


def bounded_hash(path,limit):
    with Path(path).open('rb') as stream:
        data=stream.read(limit+1)
    if len(data)>limit:raise ValueError('source_budget')
    return hashlib.sha256(data).hexdigest()


def local_reader(registry):
    """Registry comes from trusted local producer, never from renderer/HTTP input.

    Each entry contains receipt + private PDF/PNG paths. Rehash on selected use.
    This verifies the bytes named by producer, not arbitrary user CTM assertions.
    """
    def read(binding_id):
        item=registry.get(binding_id)
        if item is None:raise ValueError('unbound_render')
        result=deepcopy(item['receipt'])
        if bounded_hash(item['pdf_path'],32*1024*1024)!=result['pdf_sha256']:raise ValueError('pdf_replaced')
        if bounded_hash(item['png_path'],64*1024*1024)!=result['render_map']['image_sha256']:raise ValueError('raster_replaced')
        return result
    return read


def make_geometry(receipt,pixel_polygon):
    if set(receipt)!={'pdf_sha256','pdf_identity_state','page_index','page_number','page_count','cropbox','rotation','user_unit','pdf_space','render_map','authority','ocr_performed'}:raise ValueError('unknown_receipt_fields')
    if set(receipt['render_map'])!={'image_sha256','width','height','pixel_to_pdf','renderer','transform_history'}:raise ValueError('unknown_map_fields')
    if receipt.get('pdf_identity_state')!='exact_rendered_bytes_sha256' or receipt.get('ocr_performed') is not False or receipt.get('authority') is not False:
        raise ValueError('trusted_source_receipt_required')
    sha(receipt['pdf_sha256']);sha(receipt['render_map']['image_sha256'])
    idx,count=receipt['page_index'],receipt['page_count']
    if type(idx) is not int or type(count) is not int or not 0<=idx<count or receipt['page_number']!=idx+1:raise ValueError('page_convention')
    if receipt['pdf_space']!='unrotated_pdf_user_space_points_bottom_left' or receipt['user_unit']!='1':raise ValueError('unknown_coordinate_space')
    if type(receipt['rotation']) is not int or receipt['rotation'] not in (0,90,180,270):raise ValueError('rotation')
    rm=receipt['render_map'];w,h=rm['width'],rm['height']
    if type(w) is not int or type(h) is not int or min(w,h)<=0 or w*h>16_000_000:raise ValueError('raster_budget')
    points=polygon(pixel_polygon)
    if any(not(0<=x<=w and 0<=y<=h) for x,y in points):raise ValueError('outside_raster')
    result=project(points,rm['pixel_to_pdf'])
    x0,y0,x1,y1=map(rational,receipt['cropbox'])
    if x0>=x1 or y0>=y1 or any(not(x0<=x<=x1 and y0<=y<=y1) for x,y in result):raise ValueError('outside_pdf_cropbox')
    return [list(map(str,p)) for p in result]


class PaperSourceStore(PaperIntakeStore):
    def snapshot(self):
        data=super().snapshot()
        for key,item in data.get('source_geometry',{}).items():
            payload={k:v for k,v in item.items() if k!='geometry_id'}
            row=data['rows'].get(item['paper_row_id'])
            if key!=digest(payload) or item['geometry_id']!=key or not row or row['row_digest']!=item['row_digest'] or row['document_digest']!=item['document_digest']:
                raise ValueError('source_geometry_integrity')
            if row['source_document_digest_claim']!=item['receipt']['pdf_sha256'] or item['cell_pointer'] not in {c['cell'] for c in row['raw_cells']}:raise ValueError('source_geometry_binding_changed')
            if str(row['raw_row'].get('pdf_page',row['raw_row'].get('page')))!=str(item['receipt']['page_number']):raise ValueError('source_geometry_page_changed')
            if item['pdf_polygon']!=make_geometry(item['receipt'],item['pixel_polygon']):raise ValueError('source_geometry_transform_changed')
            if item['authority'] is not False or item['ocr_performed'] is not False:raise ValueError('geometry_has_no_authority')
        return data

    def attach(self,*,paper_row_id,expected_revision,expected_row_digest,expected_document_digest,
               render_binding_id,pixel_polygon,cell_pointer,receipt_reader):
        """Trusted local selection/producer only; no frontend path, FPS or identity."""
        with self._transaction(expected_revision) as data:
            row=data['rows'].get(paper_row_id)
            if not row or row['row_digest']!=expected_row_digest or row['document_digest']!=expected_document_digest:raise IntervalConflict('paper_row_changed')
            if cell_pointer not in {c['cell'] for c in row['raw_cells']}:raise ValueError('unknown_paper_cell')
            receipt=receipt_reader(render_binding_id)
            claim=row['source_document_digest_claim']
            if not claim or claim!=receipt['pdf_sha256']:raise IntervalConflict('original_pdf_claim_missing_or_mismatch')
            # Only explicit machine pdf_page/page labels; printed_page never used.
            label=row['raw_row'].get('pdf_page',row['raw_row'].get('page'))
            if type(label) not in (int,str) or str(label)!=str(receipt['page_number']):raise ValueError('paper_pdf_page_not_exact')
            mapped=make_geometry(receipt,pixel_polygon)
            item=dict(paper_row_id=paper_row_id,row_digest=row['row_digest'],document_digest=row['document_digest'],
                cell_pointer=cell_pointer,receipt=deepcopy(receipt),pixel_polygon=[list(map(str,p)) for p in polygon(pixel_polygon)],
                pdf_polygon=mapped,authority=False,ocr_performed=False,provenance='local_original_pdf_geometry',
                binding_state='verified_bytes_at_attachment')
            gid=digest(item);item['geometry_id']=gid
            if receipt_reader(render_binding_id)!=receipt:raise IntervalConflict('source_changed_during_attach')
            target=data.setdefault('source_geometry',{})
            if gid in target:return {'status':'already_attached','geometry_id':gid,'revision':data['revision']}
            if len(target)>=10000:raise ValueError('geometry_quota')
            target[gid]=item
            self._commit(data)
            return {'status':'attached','geometry_id':gid,'revision':data['revision']}

    def source_read_model(self):
        data=self.snapshot()
        # No absolute path or client-supplied address. Endpoint is intentionally absent.
        return {'project_id':self.project_id,'revision':data['revision'],'geometries':list(data.get('source_geometry',{}).values()),
                'source_bytes_currently_checked':False,'image_route_available':False,'editorial_authority':False}


def _canonical_native_numbers(native):
    """Only trusted native Float fields: explicit 9dp with measured corner proof.

    Generic/user geometry rational budget is deliberately NOT changed.
    """
    from decimal import Decimal, ROUND_HALF_EVEN, localcontext
    from fractions import Fraction as F
    import math
    def raw(values,count):
        if not isinstance(values,list) or len(values)!=count:raise ValueError('native_numeric_shape')
        out=[]
        for v in values:
            if type(v) not in (int,float) or not math.isfinite(v) or abs(v)>10**7:raise ValueError('native_numeric_bounds')
            exact=F(str(v))
            if exact.denominator>10**24:raise ValueError('native_numeric_precision_unsupported')
            out.append(exact)
        return out
    fwd=raw(native['pdf_to_pixel'],9);inv=raw(native['pixel_to_pdf'],9);box=raw(native['crop_box'],4)
    if fwd[6:]!=[0,0,1] or inv[6:]!=[0,0,1]:raise ValueError('native_affine_required')
    def quant(values):
        with localcontext() as context:
            context.prec=80
            return [F((Decimal(v.numerator)/Decimal(v.denominator)).quantize(Decimal('0.000000001'),rounding=ROUND_HALF_EVEN)) for v in values]
    qf,qi,qb=quant(fwd),quant(inv),quant(box)
    matrix(list(map(str,qf)));matrix(list(map(str,qi)))
    x0,y0,x1,y1=box
    if x0>=x1 or y0>=y1:raise ValueError('native_crop_invalid')
    w,h=native['raster_size']
    if type(w) is not int or type(h) is not int or min(w,h)<=0 or w*h>8_000_000:raise ValueError('native_raster_budget')
    pdf=[(x0,y0),(x1,y0),(x1,y1),(x0,y1)];pixels=[(0,0),(w,0),(w,h),(0,h)]
    def apply(m,p):return (m[0]*p[0]+m[1]*p[1]+m[2],m[3]*p[0]+m[4]*p[1]+m[5])
    def error(a,b):return max(abs(a[0]-b[0]),abs(a[1]-b[1]))
    forward_error=max(error(apply(fwd,p),apply(qf,p)) for p in pdf)
    inverse_error=max(error(apply(inv,p),apply(qi,p)) for p in pixels)
    native_pdf_roundtrip=max(error(apply(inv,apply(fwd,p)),p) for p in pdf)
    native_pixel_roundtrip=max(error(apply(fwd,apply(inv,p)),p) for p in pixels)
    crop_error=max(abs(a-b) for a,b in zip(box,qb))
    if max(forward_error,inverse_error,native_pdf_roundtrip,native_pixel_roundtrip)>F(1,100000) or crop_error>F(1,100000000):raise ValueError('native_projection_error_exceeds_bound')
    changed=(fwd!=qf or inv!=qi or box!=qb)
    witness=None
    if changed:
        witness=json.dumps({'kind':'native_decimal_canonicalization_v1','decimal_places':9,'rounding':'half_even',
          'raw_pdf_to_pixel':list(map(str,fwd)),'raw_pixel_to_pdf':list(map(str,inv)),'raw_cropbox':list(map(str,box)),
          'max_forward_error_px':str(forward_error),'max_inverse_error_pt':str(inverse_error),
          'max_crop_error_pt':str(crop_error),'native_pdf_roundtrip_pt':str(native_pdf_roundtrip),'native_pixel_roundtrip_px':str(native_pixel_roundtrip),
          'projection_error_limit':'1/100000','crop_error_limit':'1/100000000'},sort_keys=True,separators=(',',':'))
    return qi,qb,witness


def canonical_native(native, *, page_count, user_unit):
    """Normalize only actual native producer numbers, never stored/user geometry."""
    inverse,box,witness=_canonical_native_numbers(native)
    history=['captured CGContext.ctm then PNG top-left F=[1,0,0;0,-1,height;0,0,1]']
    if witness:history.append(witness)
    return dict(pdf_sha256=native['document_sha256'],pdf_identity_state='exact_rendered_bytes_sha256',
      page_index=native['page_index'],page_number=native['page_index']+1,page_count=page_count,
      cropbox=list(map(str,box)),rotation=native['rotation'],user_unit=str(user_unit),
      pdf_space='unrotated_pdf_user_space_points_bottom_left',
      render_map=dict(image_sha256=native['raster_sha256'],width=native['raster_size'][0],height=native['raster_size'][1],
        pixel_to_pdf=list(map(str,inverse)),renderer='CoreGraphics-actual-CTM',transform_history=history),
      authority=native['authority'],ocr_performed=native['ocr_performed'])


def validate_render_canvas(receipt):
    """Canvas may contain margins; only projected original CropBox is paper."""
    a,b,c,d,e,f,g,h,i=matrix(receipt['render_map']['pixel_to_pdf'])
    det=a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g)
    forward=[(e*i-f*h)/det,(c*h-b*i)/det,(b*f-c*e)/det,
             (f*g-d*i)/det,(a*i-c*g)/det,(c*d-a*f)/det,
             (d*h-e*g)/det,(b*g-a*h)/det,(a*e-b*d)/det]
    x0,y0,x1,y1=map(rational,receipt['cropbox'])
    paper=[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]
    pixels=project(paper,list(map(str,forward)))
    # The regular cell validator checks receipt shape, units, raster/page bounds.
    # Do NOT use entire raster as a cell: CoreGraphics may letterbox the page.
    mapped=make_geometry(receipt,[list(map(str,p)) for p in pixels])
    if mapped != [list(map(str,p)) for p in paper]:raise ValueError('page_projection_roundtrip')
    return [list(map(str,p)) for p in pixels]
