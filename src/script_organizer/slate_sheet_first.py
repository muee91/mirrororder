"""Project-local sheet entry and conservative projection of existing sync groups."""
import hashlib
import json
import sqlite3
from pathlib import Path, PurePosixPath
import re

from .scene_interval_store import SceneIntervalStore, IntervalConflict
from .source_descriptor_receipt import _digest

READ={'expected_scope','expected_index_sha256'}
ADD=READ|{'expected_sheet_revision','request_id','fields'}
EDIT=READ|{'expected_sheet_revision','row_id','field','value'}
BASE_FIELDS={'scene_raw','shot_raw','take_raw','content_raw','notes_raw','atmosphere_raw','audio_raw'}
CAMERAS=('A','B','C')
FIELDS=BASE_FIELDS|{f'cameras.{cam}.{part}' for cam in CAMERAS for part in ('clip_raw','framing_raw','ok_raw')}

class ManualSlateStore(SceneIntervalStore):
    def __init__(self, out, project):
        super().__init__(out,project)
        self.path=Path(out)/'electronic_manual_slate.json'

def _label(value):
    return PurePosixPath(str(value or '').replace('\\','/')).name[:100]

def project_sync_groups(index, sync_report, bindings=None):
    # No filename-only matching: this is a view of already recorded project
    # synchronization, never a scene/shot/take assignment or asset verification.
    source=index.get('source',{})
    if (sync_report.get('status')!='completed' or source.get('analysis_input_kind')!='fcpxml' or
        not _label(source.get('derived_fcpxml')) or _label(source.get('derived_fcpxml')) not in
        {_label(sync_report.get('analysis_fcpxml')), _label(sync_report.get('fcpxml'))}):
        return []
    clips={}
    for item in index.get('clips',[]):
        cid=item.get('clip_id')
        if not cid:continue
        if cid in clips: clips[cid]=None
        else: clips[cid]=item
    result=[]; seen=set()
    for group in index.get('groups',[]):
        gid=group.get('group_id')
        if not isinstance(gid,str) or not gid or len(gid)>256 or gid in seen or group.get('kind')!='multicam':continue
        seen.add(gid)
        members=group.get('members',[]); declared=group.get('cameras',[])
        if not isinstance(declared,list) or not 2<=len(members)<=3 or len(declared)!=len(members):continue
        chosen={}
        for member in members:
            cam=member.get('camera'); cid=member.get('clip_id'); mid=member.get('media_id')
            entry=clips.get(cid)
            if (cam not in CAMERAS or cam in chosen or not entry or entry.get('camera')!=cam or
                entry.get('media_id')!=mid or not isinstance(mid,str) or not re.fullmatch(r'M_[0-9a-f]{24}',mid) or
                not _label(entry.get('name'))):break
            chosen[cam]={'camera':cam,'clip_id':cid,'media_id':mid,'label':_label(entry['name'])}
            if bindings is not None:
                # Registry metadata only. Do not touch the stored path or claim playback.
                registered=bindings.get(mid)
                if isinstance(registered,str) and registered and (registered.startswith('/') or re.match(r'^[A-Za-z]:[\\/]',registered)):
                    chosen[cam].update(connection='linked',file_name=_label(registered))
                else:chosen[cam].update(connection='not_connected')
        if (len(chosen)==len(members) and set(chosen)==set(declared)
            and len({x['media_id'] for x in chosen.values()})==len(chosen)):
            result.append({'group_id':gid, 'sources':[chosen[c] for c in CAMERAS if c in chosen]})
    # Large projects remain bounded; never turn pagination into fake completeness.
    return result

def sheet(config, project, request, scope, index, index_digest, *,add=False,edit=False,bindings=None,suggestions=None):
    if request['expected_index_sha256']!=index_digest(index):raise IntervalConflict('sheet_index_changed')
    store=ManualSlateStore(config.output_dir,project)
    def read(state):
        report=Path(config.output_dir)/'sync'/'sync_report.json'
        try: sync=json.loads(report.read_text(encoding='utf-8'))
        except (FileNotFoundError,ValueError):sync={}
        groups=project_sync_groups(index,sync,bindings)
        related,annotations=suggestions(sync,groups[:1200]) if suggestions is not None else (None,{})
        base={'contract':'mirrororder.sheet_first.v1','workspace_scope':scope,'index_sha256':request['expected_index_sha256'],
                'revision':state['revision'],'manual_rows':list(state['intervals'].values()),'sync_groups':groups[:1200],
                'sync_group_count':len(groups),'sync_angle_edit':{'contract':'mirrororder.sync_angle_annotations.v1',
                  'available':bool(groups),'max_note_length':500}}
        extra={**({'paper_suggestions':related} if related is not None else {}),
               **({'paper_field_annotations':annotations} if annotations else {})}
        # An optional evidence feature may never make the normal sheet exceed
        # the dedicated IPC envelope. No partial subset that could revive a clear.
        return {**base,**extra} if extra and len(json.dumps({'ok':True,'data':{**base,**extra}},ensure_ascii=True))<1_000_000 else base
    if edit:
        rid,field,value=(request[k] for k in ('row_id','field','value'))
        if (not isinstance(rid,str) or not re.fullmatch(r'sheet-manual-[0-9a-f]{32}',rid) or
            not isinstance(field,str) or field not in FIELDS or not isinstance(value,str) or value!=value.strip() or
            len(value)>240 or any(ord(ch)<32 for ch in value)):
            raise ValueError('invalid_manual_slate_cell')
        with store._transaction(request['expected_sheet_revision']) as state:
            row=state['intervals'].get(rid)
            if not row:raise IntervalConflict('manual_slate_row_changed')
            previous=row['fields'].get(field,'')
            if previous!=value:
                if value:row['fields'][field]=value
                else:row['fields'].pop(field,None)
                state['events'].append({'action':'edit_cell','row_id':rid,'field':field,'before':previous,'after':value,'revision':state['revision']+1})
                store._commit(state)
        return read(state)
    if not add:return read(store.snapshot())
    fields=request['fields']
    if not isinstance(fields,dict) or not fields or set(fields)-FIELDS or not all(isinstance(v,str) and v==v.strip() and v and len(v)<=240 and not any(ord(ch)<32 for ch in v) for v in fields.values()):
        raise ValueError('invalid_manual_slate_fields')
    request_id=request['request_id']
    if not isinstance(request_id,str) or not re.fullmatch(r'[a-f0-9]{32}',request_id):
        raise ValueError('invalid_manual_slate_request_id')
    rid='sheet-manual-'+request_id
    snapshot=store.snapshot()
    existing=snapshot['intervals'].get(rid)
    if existing:
        if existing['fields']!=fields:raise IntervalConflict('manual_slate_request_reused')
        return read(snapshot)
    with store._transaction(request['expected_sheet_revision']) as state:
        if len(state['intervals'])>=1200:raise ValueError('manual_slate_limit')
        state['intervals'][rid]={'row_id':rid,'sequence':state['revision']+1,'fields':dict(fields)}
        store._commit(state)
    return read(state)


def pdf_browse_sources(device_dir, workspace_id, project):
    """Existing native PDF document/page receipt only; never reopen the PDF or its raster."""
    db=Path(device_dir)/'paper-drafts.sqlite3'
    if not db.is_file():return {}
    scope=hashlib.sha256(json.dumps([workspace_id,project],separators=(',',':')).encode()).hexdigest()
    verified={}
    try:
        with sqlite3.connect(db.absolute().as_uri()+'?mode=ro',uri=True,timeout=1) as conn:
            rows=conn.execute('SELECT id,pdf_sha,pages,receipt FROM drafts WHERE scope=? LIMIT 101',(scope,)).fetchall()
        if len(rows)>100:return {}
        from .paper_source_binding import validate_render_canvas
        for draft_id,sha,pages,raw in rows:
            if not isinstance(sha,str) or not re.fullmatch(r'[0-9a-f]{64}',sha) or type(pages) is not int or not 1<=pages<=500:continue
            expected='pdf-draft-'+hashlib.sha256(json.dumps([scope,sha],separators=(',',':')).encode()).hexdigest()
            receipt=json.loads(raw)
            if draft_id!=expected or receipt.get('pdf_sha256')!=sha or receipt.get('page_count')!=pages or receipt.get('page_index')!=0:continue
            validate_render_canvas(receipt)
            verified[sha]=pages
    except (sqlite3.Error,OSError,ValueError,TypeError,AttributeError):
        return {}
    return verified
