"""Local host prototype: append a classification draft on exact interval evidence."""
from copy import deepcopy
import re
from .scene_interval_plan import evidence_digest, _digest, build_marker_plan
from .scene_interval_store import IntervalConflict
from .paper_nested_camera import camera_cells

_SELECT={'evidence_id','expected_evidence_version','expected_evidence_sha256'}
_EXACT=('clip_id','media_id','asset_revision','source_start_frame','source_end_frame','source_fps')

def stage_correction(store,*,expected_revision,expected_draft_revision,selected,episode,scene_id,mode,script_pairs,actor):
    """Only call on explicit local desktop actions; never expose as open HTTP.
    script_pairs comes from current exact server-side catalog, not user input.
    Neither an interval classification nor its Resolve authority is overwritten.
    """
    if type(episode) is not int or not 1<=episode<=99999:
        raise ValueError('episode_number_required')
    if (not isinstance(scene_id,str) or not 1<=len(scene_id)<=80 or
        scene_id.casefold() in ('unknown','同上','ditto') or
        not re.fullmatch(r'[^\W_]+(?:[ ./_-][^\W_]+)*',scene_id,re.UNICODE)):
        raise ValueError('scene_label_required')
    if mode not in ('script_scene','local_correction'):
        raise ValueError('unsupported_scene_context_choice')
    if mode=='script_scene' and (episode,scene_id) not in script_pairs:
        raise ValueError('script_scene_not_in_episode')
    if not isinstance(actor,str) or not actor.strip():
        raise ValueError('review_actor_required')
    if not isinstance(selected,list) or not 1<=len(selected)<=24:
        raise ValueError('select_exact_intervals')
    with store._transaction(expected_revision) as payload:
        pending_revision=_check_draft_revision(payload,expected_draft_revision)
        targets=[]; seen=set(); pages=set(); docs=set(); extant_scene=set()
        for request in selected:
            if not isinstance(request,dict) or set(request)!=_SELECT:
                raise ValueError('invalid_interval_selection_fields')
            eid=request['evidence_id'];version=request['expected_evidence_version']
            if not isinstance(eid,str) or not eid or eid in seen or type(version) is not int:
                raise ValueError('invalid_or_duplicate_interval_selection')
            seen.add(eid)
            row=payload['intervals'].get(eid)
            if not row or row.get('version')!=version or evidence_digest(row)!=request['expected_evidence_sha256']:
                raise IntervalConflict('selected_interval_changed')
            if row.get('review_state') not in ('proposal','human_verified') or row.get('boundary_status')!='exact_source_frames' or any(k not in row for k in _EXACT):
                raise ValueError('existing_exact_interval_required')
            provenance=row.get('provenance',{})
            docs.add(provenance.get('document_digest'));pages.add(provenance.get('page'))
            if row.get('scene'):extant_scene.add(row['scene'])
            targets.append({**deepcopy(request),**{k:deepcopy(row[k]) for k in _EXACT}})
        if len(targets)>1 and (len(docs)!=1 or None in docs or len(pages)!=1 or None in pages or len(extant_scene)>1):
            raise ValueError('same_document_page_scene_required_for_batch')
        draft={'status':'review_draft','episode':episode,'scene_id':scene_id,'mode':mode,
               'script_match_asserted':mode=='script_scene','editorial_authority':False,
               'actor':actor.strip(),'targets':targets,'previous_interval_revision':payload['revision']}
        draft['draft_id']='scene-context-draft-'+_digest({'project_id':store.project_id,'draft':draft})
        payload.setdefault('scene_context_drafts',[]).append(draft)
        payload['events'].append({'action':'scene_context_draft','draft_id':draft['draft_id']})
        payload['draft_revision']=pending_revision+1
        result=store._commit(payload,bump_revision=False)
        return {'draft':deepcopy(draft),'revision':result['revision'],'draft_revision':result['draft_revision']}

def _check_draft_revision(payload,expected):
    revision=payload.get('draft_revision',0)
    if type(expected) is not int or revision!=expected:
        raise IntervalConflict('scene_context_draft_revision_changed')
    return revision

def _latest(payload):
    """Map selected evidence to last draft not already explicitly approved."""
    accepted=set(payload.get('approved_scene_context_drafts',[]))
    drafts=payload.get('scene_context_drafts',[])
    for d in drafts:
        signature='scene-context-draft-'+_digest({'project_id':payload['project_id'],'draft':{k:v for k,v in d.items() if k!='draft_id'}})
        if d.get('draft_id')!=signature:raise IntervalConflict('scene_context_draft_digest_mismatch')
    by_id={t['evidence_id']:d for d in drafts for t in d['targets']}
    return {eid:d for eid,d in by_id.items() if d['draft_id'] not in accepted
            and all(by_id[t['evidence_id']]==d for t in d['targets'])}

def paper_source_camera(interval, original):
    """Return only the immutable electronic paper cell proven by this interval.

    Index camera is a display hint; same-row A and B intervals must not
    substitute each other based on a mutable material-index field.
    """
    from .electronic_source_context import BASIS
    context=interval.get('source_context') or {}
    if context.get('kind')!=BASIS:
        return None
    cell=context.get('electronic_source_cell') or {}
    selection=context.get('selection') or {}
    camera=cell.get('camera')
    pid=interval.get('paper_row_id')
    digest=(interval.get('provenance') or {}).get('row_digest')
    if (camera not in ('A','B','C') or not pid or not digest or original.get('paper_row_id')!=pid
        or original.get('row_digest')!=digest or cell.get('paper_row_id')!=pid or cell.get('row_digest')!=digest
        or cell.get('raw_cell')!=f'/cameras/{camera}/clip_raw' or selection.get('nested_camera')!=camera
        or selection.get('paper_row_id')!=pid or selection.get('row_digest')!=digest
        or selection.get('clip_id')!=interval.get('clip_id') or selection.get('media_id')!=interval.get('media_id')):
        return None
    return camera


def read_board(store,paper,index,*,offset=0,expected_revision=None,expected_draft_revision=None,expected_paper_revision=None,expected_index_sha256=None,descriptor_reader=None):
    # 40 bounded rows avoid loading source media or sending raw transcription.
    if type(offset) is not int or offset<0:raise ValueError('invalid_board_offset')
    state=store.snapshot();paper=paper.snapshot();pending=_latest(state)
    index_sha256=_digest(index)
    if offset and (expected_index_sha256!=index_sha256 or type(expected_revision) is not int or expected_revision!=state['revision'] or
                   type(expected_draft_revision) is not int or expected_draft_revision!=state.get('draft_revision',0) or
                   type(expected_paper_revision) is not int or expected_paper_revision!=paper['revision']):
        raise IntervalConflict('slate_board_changed_between_pages')
    def basename(value):return str(value or '').replace(chr(92),'/').rsplit('/',1)[-1][:100]
    material={}
    for c in index.get('clips',[])+[x for g in index.get('groups',[]) for x in g.get('members',[])]:
        pair=(c.get('clip_id'),c.get('media_id'))
        material.setdefault(pair,{'camera':str(c.get('camera',''))[:16],
            'filename':basename(c.get('name') or c.get('filename'))})
    result=[];represented=set()
    for eid,row in state['intervals'].items():
        if row.get('review_state') not in ('proposal','human_verified'):continue
        provenance=row.get('provenance',{});pid=row.get('paper_row_id')
        if pid:represented.add(pid)
        draft=pending.get(eid);source={k:row.get(k) for k in _EXACT}
        original=paper['rows'].get(pid,{})
        from .electronic_source_context import BASIS as ELECTRONIC_BASIS
        context=row.get('source_context',{})
        electronic=context.get('kind')==ELECTRONIC_BASIS and row.get('classification_pending') is True
        source_scene=original.get('normalized_fields',{}).get('scene','') if electronic else row.get('scene','')
        result.append({'kind':'interval','evidence_id':eid,'paper_row_id':pid,
            'document_digest':provenance.get('document_digest'),'page':provenance.get('page'),'row':provenance.get('row'),
            'camera_cells':camera_cells(original), 'paper_row_digest':provenance.get('row_digest'),
            'paper_source_camera':paper_source_camera(row,original),
            'existing_scene':str(source_scene)[:100],'assignment':row.get('classification'),
            'classification_pending':row.get('classification_pending') is True,'review_state':row['review_state'],
            'expected_evidence_version':row['version'],'expected_evidence_sha256':evidence_digest(row),
            'draft':{k:draft[k] for k in ('draft_id','episode','scene_id','mode','status','targets')} if draft else None,
            **source, **material.get((row.get('clip_id'),row.get('media_id')),{})})
    for pid,row in paper['rows'].items():
        if pid in represented:continue
        labels=row.get('normalized_fields',{})
        result.append({'kind':'paper_only','paper_row_id':pid,'page':row.get('page'),'row':row.get('row'),
            'document_digest':row.get('document_digest'),'existing_scene':str(labels.get('scene',''))[:100],
            'camera_cells':camera_cells(row),'paper_row_digest':row.get('row_digest'),
            'filename':basename(labels.get('filename')),
            'assignment':None,'draft':None,'review_reasons':row['review_reasons']})
    count=len(result);end=offset+40
    visible=result[offset:end];receipts={}
    if descriptor_reader is not None:
        for r in visible:
            if r['kind']!='interval':continue
            mid=r['media_id']
            if mid not in receipts:
                try:receipts[mid]=descriptor_reader(mid)
                except (OSError,ValueError,TypeError):receipts[mid]=None
            rr=receipts[mid]
            r['descriptor_state']='prepared' if rr and rr.get('status')=='verified' and rr.get('asset_revision')==r['asset_revision'] and rr.get('fps')==r['source_fps'] else 'missing_or_stale'
    return {'revision':state['revision'],'draft_revision':state.get('draft_revision',0),
            'paper_revision':paper['revision'],'index_sha256':index_sha256,'rows':visible,
            'total':count,'next_offset':end if end<count else None}

def approve_draft(store,*,expected_revision,expected_draft_revision,draft_id,catalog_reader,actor,descriptor_reader,row_guard):
    """One explicit approval, same source evidence version guarded under repo lock."""
    if not isinstance(actor,str) or not actor.strip():raise ValueError('review_actor_required')
    with store._transaction(expected_revision) as state:
        revision=_check_draft_revision(state,expected_draft_revision)
        pending=_latest(state)
        drafts=[d for d in state.get('scene_context_drafts',[]) if d['draft_id']==draft_id]
        if len(drafts)!=1:raise IntervalConflict('scene_context_draft_changed')
        draft=drafts[0];pair=(draft['episode'],draft['scene_id'])
        if draft['mode']=='script_scene' and pair not in catalog_reader():raise IntervalConflict('script_scene_pair_changed')
        rows=[];before=[]
        for t in draft['targets']:
            eid=t['evidence_id'];row=state['intervals'].get(eid)
            if not row or pending.get(eid)!=draft or row['version']!=t['expected_evidence_version'] or evidence_digest(row)!=t['expected_evidence_sha256']:
                raise IntervalConflict('selected_interval_changed')
            row_guard(row)
            receipt=descriptor_reader(row['media_id'])
            if not receipt or receipt.get('status')!='verified' or receipt.get('media_id')!=row['media_id'] or not receipt.get('descriptor_revision'):
                raise IntervalConflict('verified_descriptor_missing_or_changed')
            updated=deepcopy(row);updated.pop('review',None);updated.pop('classification_pending',None)
            updated.update(scene=pair[1],classification={k:draft[k] for k in ('episode','scene_id','mode','draft_id')},version=row['version']+1,review_state='human_verified')
            updated['classification']['actor']=actor.strip()
            updated['review']={'actor':actor.strip(),'evidence_version':updated['version'],'evidence_sha256':evidence_digest(updated),'descriptor_revision':receipt['descriptor_revision']}
            check=build_marker_plan(store.project_id,[updated],[receipt],[])['rows'][0]
            if check['action']!='propose_add_marker':raise ValueError('interval_not_confirmable')
            before.append({k:deepcopy(row[k]) for k in ('scene','version','review','classification') if k in row})
            rows.append((eid,updated,receipt))
        if draft['mode']=='script_scene' and pair not in catalog_reader():raise IntervalConflict('script_scene_pair_changed')
        for eid,updated,receipt in rows:
            row_guard(state['intervals'][eid])
            if descriptor_reader(updated['media_id'])!=receipt:raise IntervalConflict('descriptor_changed_during_review')
        for eid,updated,_ in rows:state['intervals'][eid]=updated
        state.setdefault('approved_scene_context_drafts',[]).append(draft_id)
        state['events'].append({'action':'approve_scene_context','draft_id':draft_id,'actor':actor.strip(),
            'evidence_ids':[eid for eid,_,_ in rows],'prior':before})
        state['draft_revision']=revision+1
        saved=store._commit(state)
        return {'revision':saved['revision'],'draft_revision':saved['draft_revision'],
                'approved':[eid for eid,_,_ in rows],'export_ready':False}
