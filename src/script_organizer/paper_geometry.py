"""Optional pure geometry prototype; no PDF/OCR engine, route or authority."""
from fractions import Fraction as F
import hashlib
import json
import re

CONTRACT = 'mirrororder.paper_geometry.v1'

def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('ascii')).hexdigest()

def sha(value):
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{64}', value):
        raise ValueError('invalid_digest')
    return value

def rational(value):
    if type(value) not in (str, int) or len(str(value)) > 80:
        raise ValueError('exact_rational_required')
    n = F(value)
    if abs(n) > 10**12 or n.denominator > 10**12:
        raise ValueError('geometry_budget')
    return n

def matrix(value):
    if not isinstance(value, list) or len(value) != 9:
        raise ValueError('matrix_required')
    a,b,c,d,e,f,g,h,i = map(rational, value)
    if a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g) == 0:
        raise ValueError('singular_transform')
    return [a,b,c,d,e,f,g,h,i]

def polygon(value):
    if not isinstance(value, list) or len(value) != 4 or any(not isinstance(p,list) or len(p)!=2 for p in value):
        raise ValueError('quadrilateral_required')
    points = [list(map(rational,p)) for p in value]
    cross = []
    for k in range(4):
        a,b,c = points[k],points[(k+1)%4],points[(k+2)%4]
        cross.append((b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]))
    if not (all(x>0 for x in cross) or all(x<0 for x in cross)):
        raise ValueError('nonconvex_or_degenerate_polygon')
    return points

def project(points, transform):
    a,b,c,d,e,f,g,h,i = matrix(transform)
    denominators = [g*x+h*y+i for x,y in points]
    if not (all(v>0 for v in denominators) or all(v<0 for v in denominators)):
        raise ValueError('projective_horizon_crossing')
    return [[(a*x+b*y+c)/w,(d*x+e*y+f)/w] for (x,y),w in zip(points,denominators)]

def evidence(*, pdf_sha256, transcription_sha256, paper_row_id, cell_pointer,
             page_index, page_count, cropbox, rotation, render_map, ocr_polygon,
             ocr_text, engine):
    """Internal producer input only. A map is geometry, NOT proof of PDF identity."""
    sha(pdf_sha256);sha(transcription_sha256)
    if type(page_index) is not int or type(page_count) is not int or not 0 <= page_index < page_count:
        raise ValueError('invalid_zero_based_page')
    if rotation not in (0,90,180,270) or type(rotation) is not int:
        raise ValueError('invalid_pdf_rotation')
    if not isinstance(cropbox,list) or len(cropbox)!=4:
        raise ValueError('cropbox_required')
    x0,y0,x1,y1 = map(rational,cropbox)
    if x1<=x0 or y1<=y0:raise ValueError('invalid_cropbox')
    if not isinstance(paper_row_id,str) or not paper_row_id or not isinstance(cell_pointer,str) or not cell_pointer.startswith('/'):
        raise ValueError('missing_paper_cell_link')
    if not isinstance(ocr_text,str) or len(ocr_text)>10000 or not isinstance(engine,str) or not engine:
        raise ValueError('invalid_ocr_candidate')
    base = dict(contract=CONTRACT, pdf_sha256=pdf_sha256, transcription_sha256=transcription_sha256,
        paper_row_id=paper_row_id, cell_pointer=cell_pointer, page_index=page_index,
        page_number=page_index+1, page_count=page_count,
        pdf_space='unrotated_pdf_user_space_points_bottom_left', cropbox=list(map(str,(x0,y0,x1,y1))),
        rotation=rotation, pdf_identity_state='producer_binding_required',
        candidate=dict(text=ocr_text,engine=engine,state='unreviewed',authority=False))
    if render_map is None or ocr_polygon is None:
        base.update(geometry_state='unavailable', reason='original_transform_or_polygon_missing', pdf_polygon=None, render_map=None, ocr_polygon=None)
    else:
        if set(render_map)!= {'image_sha256','width','height','pixel_to_pdf','renderer','transform_history'}:
            raise ValueError('invalid_render_map_fields')
        sha(render_map['image_sha256'])
        w,h = render_map['width'],render_map['height']
        if type(w) is not int or type(h) is not int or not 0<w<=100000 or not 0<h<=100000:
            raise ValueError('invalid_raster_dimensions')
        if not isinstance(render_map['renderer'],str) or not render_map['renderer'] or not isinstance(render_map['transform_history'],list) or not render_map['transform_history']:
            raise ValueError('missing_transform_provenance')
        points=polygon(ocr_polygon)
        if any(not (0<=x<=w and 0<=y<=h) for x,y in points):raise ValueError('outside_ocr_raster')
        mapped=project(points,render_map['pixel_to_pdf'])
        if any(not (x0<=x<=x1 and y0<=y<=y1) for x,y in mapped):raise ValueError('outside_pdf_cropbox')
        clean=json.loads(json.dumps(render_map,allow_nan=False))
        clean['pixel_to_pdf']=list(map(str,matrix(clean['pixel_to_pdf'])))
        base.update(geometry_state='mapped_not_pdf_verified', render_map=clean,
                    render_map_id=digest(clean), ocr_polygon=[list(map(str,p)) for p in points],
                    pdf_polygon=[list(map(str,p)) for p in mapped])
    return {**base,'evidence_id':digest(base)}

def reload_evidence(serialized):
    """Recompute derived geometry after persistence, never trust stored polygon."""
    value=json.loads(serialized)
    regenerated=evidence(pdf_sha256=value['pdf_sha256'],transcription_sha256=value['transcription_sha256'],
        paper_row_id=value['paper_row_id'],cell_pointer=value['cell_pointer'],page_index=value['page_index'],
        page_count=value['page_count'],cropbox=value['cropbox'],rotation=value['rotation'],
        render_map=value['render_map'],ocr_polygon=value['ocr_polygon'],ocr_text=value['candidate']['text'],engine=value['candidate']['engine'])
    if regenerated!=value:raise ValueError('geometry_receipt_mismatch')
    return regenerated
