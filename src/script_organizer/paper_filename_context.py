"""Trusted local review consumer; filename convention is NOT camera metadata.

No public route. header_reader must resolve a persisted explicit page-header
selection from the native review path, not return a client assertion.
"""
from pathlib import Path
import re
from .source_descriptor_receipt import _digest, _sampled_id, _stat
from .scene_interval_store import SceneIntervalStore, IntervalConflict
from .paper_source_suggestions import inventory

PATTERN=re.compile(r'([ABC])([0-9]{3})C([0-9]{3})_([0-9]{6})(?:[A-Z]{2}|_[A-Za-z0-9_-]+)?\.[Mm][Pp]4')

def _bindings(store,workspace,project):
    return store.load().get('workspaces',{}).get(workspace,{}).get('projects',{}).get(project,{}).get('bindings',{})


def discover(index, code, expected_index_sha256, *,device_store,workspace,project):
    if _digest(index)!=expected_index_sha256:raise IntervalConflict('media_index_changed')
    if not isinstance(code,str) or not re.fullmatch(r'[Cc]?[0-9]{1,8}',code):raise ValueError('literal_clip_code_required')
    value=int(code.lstrip('Cc'));rows=[];registered=set();indexed=set()
    bindings=_bindings(device_store,workspace,project)
    for asset in inventory(index):
        if not re.fullmatch(r'M_[0-9a-f]{24}',asset['media_id']):continue
        indexed.add(asset['media_id'])
        bound=bindings.get(asset['media_id'])
        if not isinstance(bound,str) or not Path(bound).is_absolute():continue
        registered.add(asset['media_id'])
        filename=Path(bound).name
        m=PATTERN.fullmatch(filename)
        if not m or int(m[3])!=value:continue
        # Keep an offline occurrence in the collision set. Availability only
        # checks the saved path; it cannot attest to the bytes at that path.
        try:
            path_state='present_identity_unchecked' if Path(bound).is_file() else 'missing_or_offline'
        except OSError:
            path_state='missing_or_offline'
        rows.append({**asset,'registration_path_state':path_state,'filename':filename,'card':m[1]+m[2],'filename_camera':m[1],
                     'basis':'filename_convention_not_camera_metadata'})
    counts={}
    for row in rows:
        key=(row['card'],row['filename_camera'])
        counts[key]=counts.get(key,0)+1
    status=('project_unbound' if not registered else 'no_matching_code' if not rows else
            'ambiguous_candidates' if len(rows)>1 else 'candidate_available')
    return {'status':status,'indexed_registered_media_count':len(registered),
            'indexed_sampled_media_count':len(indexed),
            'unregistered_indexed_sampled_media_count':len(indexed-registered),
            'missing_candidate_count':sum(row['registration_path_state']=='missing_or_offline' for row in rows),
            'same_card_collision':any(count>1 for count in counts.values()),
            'camera_conflict':any(row['camera']!=row['filename_camera'] for row in rows),
            'candidates':rows,'confirmed':False,'index_sha256':expected_index_sha256,
            'candidate_scope':'project_registered_basenames','media_identity_currently_checked':False}


def _registered(store,workspace,project,asset):
    def lookup():return _bindings(store,workspace,project).get(asset['media_id'])
    bound=lookup()
    if not isinstance(bound,str):raise ValueError('registered_media_required')
    try:
        path=Path(bound).resolve(strict=True);before=_stat(path)
    except OSError as exc:
        raise IntervalConflict('registered_media_missing_or_offline') from exc
    if not path.is_file() or path.name!=asset['filename']:raise ValueError('registered_basename_mismatch')
    if _sampled_id(path)!=asset['media_id']:raise ValueError('registered_identity_mismatch')
    if lookup()!=bound or Path(bound).resolve(strict=True)!=path or _stat(path)!=before:raise IntervalConflict('registered_media_changed')
    return _digest({'binding':bound,'stat':before,'media_id':asset['media_id']})


def validate_binding(request,index,header_reader,device_store,workspace,project):
    fields={'paper_row_id','row_digest','header_id','header_digest','expected_index_sha256','code','card','camera','clip_id','media_id'}
    if not isinstance(request,dict) or set(request)!=fields:raise ValueError('invalid_filename_context')
    header=header_reader(request['header_id'])
    # This receipt comes from the owner of native page selection. It must bind
    # this row's original PDF, not a similarly titled page or a free text memo.
    if not isinstance(header,dict) or header.get('kind')!='explicit_original_page_header_selection' or _digest(header)!=request['header_digest']:raise IntervalConflict('header_selection_changed')
    for key in ('paper_row_id','row_digest','card','camera'):
        if header.get(key)!=request[key]:raise ValueError('header_context_conflict')
    for key in ('pdf_sha256','render_map_id','pdf_polygon','page_index','draft_revision'):
        if key not in header:raise ValueError('header_geometry_required')
    if header.get('current_source_verified') is not True:raise ValueError('header_source_not_current')
    if 'reviewed_paper_camera' in header and header['reviewed_paper_camera']!=request['camera']:
        raise IntervalConflict('reviewed_paper_camera_conflict')
    if header.get('clip_code')!=request['code']:raise ValueError('saved_clip_code_conflict')
    found=discover(index,request['code'],request['expected_index_sha256'],device_store=device_store,workspace=workspace,project=project)['candidates']
    narrowed=[a for a in found if a['card']==request['card'] and a['filename_camera']==request['camera']]
    if len(narrowed)!=1:raise ValueError('filename_context_not_unique')
    asset=narrowed[0]
    if (asset['clip_id'],asset['media_id'])!=(request['clip_id'],request['media_id']):raise ValueError('selected_occurrence_conflict')
    if asset['camera']!=request['camera']:raise ValueError('index_camera_conflict')
    token=_registered(device_store,workspace,project,asset)
    return {'kind':'operator_confirmed_filename_prefix','selection':dict(request),'header':header,
      'registered_binding_token':token,'identity_assurance':'sampled_identity_plus_device_stat_not_full_hash',
      'interval_confirmed':False,'exact_take_confirmed':False}

class FilenameContextStore(SceneIntervalStore):
    def __init__(self,output_dir,project_id):
        super().__init__(output_dir,project_id);self.path=Path(output_dir)/'paper_filename_contexts.json'
    @staticmethod
    def _slot(receipt):
        cell=receipt['header'].get('electronic_source_cell')
        if cell is None:return None
        if (cell.get('paper_row_id')!=receipt['selection'].get('paper_row_id') or
            cell.get('camera')!=receipt['selection'].get('camera')):
            raise IntervalConflict('electronic_source_slot_invalid')
        return _digest([cell['paper_row_id'],cell['raw_cell']])

    def _assert_generation(self,state,binding_id,saved,expected):
        if type(expected) is not int:raise IntervalConflict('source_context_revision_changed')
        slot=self._slot(saved)
        if slot is None:
            if state['revision']!=expected:raise IntervalConflict('source_context_revision_changed')
        elif state.get('electronic_source_current',{}).get(slot)!={'binding_id':binding_id,'revision':expected}:
            raise IntervalConflict('electronic_source_slot_superseded_or_generation_changed')

    def record(self,request,*,expected_revision,index_reader,header_reader,device_store,workspace):
        with self._transaction(expected_revision) as state:
            receipt=validate_binding(request,index_reader(),header_reader,device_store,workspace,self.project_id)
            key='filename-context-'+_digest(receipt);slot=self._slot(receipt)
            if key in state['intervals']:
                result={'binding_id':key,'revision':state['revision'],'status':'already_recorded'}
                if slot is not None:
                    current=state.get('electronic_source_current',{}).get(slot)
                    if not current or current['binding_id']!=key:raise IntervalConflict('electronic_source_slot_superseded_or_generation_changed')
                    result['source_context_revision']=current['revision']
                return result
            # Revalidate immediately before commit; prepare must repeat this check.
            if validate_binding(request,index_reader(),header_reader,device_store,workspace,self.project_id)!=receipt:raise IntervalConflict('context_changed')
            state['intervals'][key]=receipt
            if slot is not None:
                state.setdefault('electronic_source_current',{})[slot]={'binding_id':key,'revision':state['revision']+1}
            self._commit(state)
            result={'binding_id':key,'revision':state['revision'],'status':'recorded'}
            if slot is not None:result['source_context_revision']=state['revision']
            return result
    def require_for_prepare(self,binding_id,targets,*,index_reader,header_reader,device_store,workspace):
        initial=self.snapshot();saved=initial['intervals'].get(binding_id)
        if not saved:raise ValueError('context_binding_required')
        expected=targets['expected_source_context_revision']
        self._assert_generation(initial,binding_id,saved,expected)
        for key in ('paper_row_id','clip_id','media_id','expected_index_sha256'):
            if saved['selection'][key]!=targets.get(key):raise IntervalConflict('prepare_context_changed')
        if type(targets.get('source_start_frame')) is not int or type(targets.get('source_end_frame')) is not int or not 0<=targets['source_start_frame']<targets['source_end_frame']:raise ValueError('explicit_source_frame_range_required')
        current=validate_binding(saved['selection'],index_reader(),header_reader,device_store,workspace,self.project_id)
        latest=self.snapshot()
        self._assert_generation(latest,binding_id,saved,expected)
        if current!=saved or latest['intervals'].get(binding_id)!=saved:raise IntervalConflict('context_binding_stale')
        return current
