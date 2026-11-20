"""Immutable electronic slate cell interpretation. Never inference or a new paper row."""
import re
from .source_descriptor_receipt import _digest
from .scene_interval_store import IntervalConflict
CAMERAS=('A','B','C')

def _read(row,camera):
    raw=row.get('raw_row',{})
    cameras=raw.get('cameras')
    cell=cameras.get(camera) if isinstance(cameras,dict) else None
    return cell.get('clip_raw') if isinstance(cell,dict) else None

def camera_cells(row):
    out=[]
    for camera in CAMERAS:
        raw=_read(row,camera)
        if raw is None or isinstance(raw,str) and not raw.strip():continue
        out.append({'camera':camera,'raw_cell':f'/cameras/{camera}/clip_raw',
                    'raw_code':raw[:40] if isinstance(raw,str) else '',
                    'status':'literal' if isinstance(raw,str) and re.fullmatch(r'[Cc]?[0-9]{1,8}',raw.strip()) else 'needs_review'})
    return out

def require_cell(row,camera,row_digest):
    if camera not in CAMERAS:raise ValueError('invalid_nested_camera')
    raw=row.get('raw_row')
    if not isinstance(raw,dict) or row.get('row_digest')!=row_digest or _digest(raw)!=row_digest:
        raise IntervalConflict('paper_row_digest_changed')
    value=_read(row,camera)
    if not isinstance(value,str) or not re.fullmatch(r'[Cc]?[0-9]{1,8}',value.strip()):
        raise ValueError('literal_nested_clip_code_required')
    proposal={'kind':'explicit_electronic_clip_cell','paper_row_id':row['paper_row_id'],
        'original_document_digest':row['document_digest'],'row_digest':row_digest,
        'page':row['page'],'row':row['row'],'camera':camera,
        'raw_cell':f'/cameras/{camera}/clip_raw','raw_code':value,'code':value.strip(),
        'authority':False,'interval_confirmed':False}
    return {**proposal,'source_cell_sha256':_digest(proposal)}
