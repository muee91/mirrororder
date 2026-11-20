"""Focused read/write for an existing visible synchronized angle. Native bridge only."""
import json
from pathlib import Path

from .scene_interval_store import IntervalConflict
from .scene_interval_plan import _digest as index_digest
from .slate_sheet_first import project_sync_groups
from .source_descriptor_receipt import _digest
from .sync_angle_annotations import SyncAngleAnnotationStore, CONTRACT, _occurrence, register_verifier

GET={'expected_scope','expected_index_sha256','group_id','clip_id','media_id','camera'}
PATCH=GET|{'expected_annotation_revision','expected_anchor','fields'}
ID=('group_id','clip_id','media_id','camera')

def check_distinct_project_output(registry,project,config):
    root=config.output_dir.resolve()
    for row in registry.list():
        another=row.get('project_id')
        if not another or another==project:continue
        try:other=registry.project_config(another,bind_local_media=False)
        except (KeyError,OSError,ValueError):continue
        if other.output_dir.resolve()==root:raise IntervalConflict('shared_project_output_alias')

def _qualification(index,report,bindings,identity):
    gid=identity['group_id']; groups=[g for g in index.get('groups',[]) if g.get('group_id')==gid]
    if len(groups)!=1:return None,'sync_group_missing_or_ambiguous'
    # Reuse browse's exact eligibility checks on the requested group only.
    projected=project_sync_groups({**index,'groups':groups},report,bindings)
    candidate=[source for g in projected for source in g['sources'] if all(source.get(k)==identity[k] for k in ID[1:])]
    if len(candidate)!=1:return None,'sync_angle_not_in_current_sheet'
    try:occurrence=_occurrence(index,identity)
    except (ValueError,TypeError,KeyError):return None,'sync_extent_unverified'
    if candidate[0].get('connection')!='linked':return occurrence,'registered_source_required'
    return occurrence,None

def route(config,project,workspace,scope,request,device,*,change):
    if request['expected_scope']!=scope:raise IntervalConflict('workspace_scope_changed')
    identity={k:request[k] for k in ID}
    if any(not isinstance(v,str) or not v or len(v)>256 for v in identity.values()) or identity['camera'] not in ('A','B','C'):
        raise ValueError('sync_angle_identity_required')
    store=SyncAngleAnnotationStore(config.output_dir,workspace,project)
    def loaded():
        root=Path(config.output_dir)
        index=json.loads((root/'material_index.json').read_text(encoding='utf-8'))
        if index_digest(index)!=request['expected_index_sha256']:raise IntervalConflict('sync_index_changed')
        try:report=json.loads((root/'sync'/'sync_report.json').read_text(encoding='utf-8'))
        except (FileNotFoundError,ValueError):report={}
        state=device.load()
        bindings=state.get('workspaces',{}).get(workspace,{}).get('projects',{}).get(project,{}).get('bindings',{})
        occurrence,reason=_qualification(index,report,bindings,identity)
        anchor='sync-angle-'+_digest({'workspace':workspace,'project':project,'occurrence':occurrence}) if occurrence else None
        return index,anchor,reason
    index,anchor,reason=loaded()
    try: saved=store.snapshot()
    except (ValueError,OSError,TypeError):
        if change:raise IntervalConflict('sync_angle_annotations_unavailable') from None
        saved={'revision':None,'rows':{}}
        reason='sync_angle_annotations_unavailable'
    result={'contract':CONTRACT,'workspace_scope':scope,'index_sha256':request['expected_index_sha256'],
            'target':identity,'revision':saved['revision'],'anchor':anchor,
            'editable':reason is None,'reason':reason,'annotation':saved['rows'].get(anchor),
            'editorial_authority':False,'checks_current_original_bytes':False}
    if not change:return result
    if reason or not anchor or request['expected_anchor']!=anchor:raise IntervalConflict(reason or 'sync_angle_anchor_changed')
    def current_index():
        data,current_anchor,blocked=loaded()
        if blocked or current_anchor!=anchor:raise IntervalConflict(blocked or 'sync_angle_anchor_changed')
        return data
    saved=store.annotate({**identity,'expected_revision':request['expected_annotation_revision'],
        'expected_index_sha256':request['expected_index_sha256'],'fields':request['fields']},
        index_reader=current_index,registered_verifier=register_verifier(device,workspace,project),actor='desktop-local-confirmation')
    return {**result,'revision':saved['revision'],'annotation':saved['annotation'],'checks_current_original_bytes':True}
