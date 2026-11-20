"""Native electronic-slate source linking: no PDF, hash guessing, or path input."""
import re
from pathlib import Path
import json
from .paper_filename_context import _registered, discover
from .paper_nested_camera import require_cell
from .paper_intake_store import PaperIntakeStore
from .scene_interval_store import SceneIntervalStore, IntervalConflict
from .source_descriptor_receipt import _digest

BASIS='operator_selected_electronic_cell'
PREFIX='electronic-context-'
READ_FIELDS={'paper_row_id','row_digest','expected_paper_revision','nested_camera'}
WRITE_FIELDS=READ_FIELDS|{'clip_id','media_id','expected_binding_revision','expected_index_sha256'}

def validate(request,write=False):
    if set(request)!=(WRITE_FIELDS if write else READ_FIELDS):
        raise ValueError('unexpected_electronic_source_fields')
    if type(request['expected_paper_revision']) is not int or request['expected_paper_revision']<0:
        raise ValueError('expected_paper_revision_required')
    if request['nested_camera'] not in ('A','B','C'):
        raise ValueError('literal_camera_required')
    checks={'paper_row_id':r'paper-row-[0-9a-f]{64}','row_digest':r'[0-9a-f]{64}'}
    if write:
        checks.update(media_id=r'M_[0-9a-f]{24}',expected_index_sha256=r'[0-9a-f]{64}',clip_id=r'[^/\\\x00-\x1f]{1,256}')
        if type(request['expected_binding_revision']) is not int or request['expected_binding_revision']<0:
            raise ValueError('expected_binding_revision_required')
    if any(not isinstance(request[k],str) or not re.fullmatch(pat,request[k]) for k,pat in checks.items()):
        raise ValueError('invalid_electronic_source_identity')

def _cell(snapshot,request):
    if snapshot['revision']!=request['expected_paper_revision']:
        raise IntervalConflict('paper_revision_changed')
    row=snapshot['rows'].get(request['paper_row_id'])
    if not row:raise ValueError('unknown_electronic_row')
    return require_cell(row,request['nested_camera'],request['row_digest'])

def _index(config):
    try:return json.loads((Path(config.output_dir)/'material_index.json').read_text(encoding='utf-8'))
    except FileNotFoundError:return {}

def _matches(index,cell,sha,device,workspace,project):
    found=discover(index,cell['code'],sha,device_store=device,workspace=workspace,project=project)
    camera=cell['camera']
    rows=[a for a in found['candidates'] if a['filename_camera']==camera and a['camera']==camera]
    return {**found,'candidates':rows,'status':('project_unbound' if not found['indexed_registered_media_count'] else 'ambiguous_candidates' if len(rows)>1 else 'candidate_available' if rows else 'no_matching_code'),
            'camera_conflict':len(rows)!=len(found['candidates']),
            'same_card_collision':len({(a['card'],a['filename']) for a in rows})!=len(rows),
            'missing_candidate_count':sum(a['registration_path_state']=='missing_or_offline' for a in rows)}

def candidates(config,workspace,project,device,request):
    validate(request)
    cell=_cell(PaperIntakeStore(config.output_dir,project).snapshot(),request)
    index=_index(config); found=_matches(index,cell,_digest(index),device,workspace,project)
    return {**found,'paper_row_id':cell['paper_row_id'],'row_digest':cell['row_digest'],'reviewed_paper_camera':cell['camera'],
            'electronic_source_cell':cell,'expected_binding_revision':ElectronicSourceStore(config.output_dir,project).snapshot()['revision'],
            'interval_confirmed':False,'original_document_verified':False}

class ElectronicSourceStore(SceneIntervalStore):
    def __init__(self,output_dir,project_id):
        super().__init__(output_dir,project_id)
        self.path=Path(output_dir)/'electronic_source_contexts.json'

def _receipt(config,workspace,project,device,request,snapshot):
    cell=_cell(snapshot,request); idx=_index(config)
    sha=request['expected_index_sha256']
    found=_matches(idx,cell,sha,device,workspace,project)
    exact=[a for a in found['candidates'] if (a['clip_id'],a['media_id'])==(request['clip_id'],request['media_id'])]
    if len(exact)!=1:raise IntervalConflict('selected_electronic_occurrence_changed')
    asset=exact[0]
    alternatives=[a for a in found['candidates'] if a['card']==asset['card'] and a['filename']==asset['filename']]
    if len(alternatives)!=1:raise IntervalConflict('same_electronic_filename_ambiguous')
    token=_registered(device,workspace,project,asset)
    selection={k:request[k] for k in READ_FIELDS|{'clip_id','media_id','expected_index_sha256'}}
    return {'kind':BASIS,'selection':selection,'electronic_source_cell':cell,'card':asset['card'],
            'registered_binding_token':token,'identity_assurance':'sampled_identity_plus_device_stat_not_full_hash',
            'original_document_verified':False,'interval_confirmed':False,'exact_take_confirmed':False}

def _slot(receipt):
    cell=receipt['electronic_source_cell']
    return _digest([cell['paper_row_id'],cell['raw_cell']])

def bind(config,workspace,project,device,request):
    validate(request,True)
    paper=PaperIntakeStore(config.output_dir,project);store=ElectronicSourceStore(config.output_dir,project)
    with paper._transaction(request['expected_paper_revision']) as snapshot, store._transaction(request['expected_binding_revision']) as state:
        receipt=_receipt(config,workspace,project,device,request,snapshot)
        bid=PREFIX+_digest(receipt);slot=_slot(receipt)
        current=state.get('electronic_source_current',{}).get(slot)
        if current and current['binding_id']==bid and state['intervals'].get(bid)==receipt:
            status='already_recorded'; revision=current['revision']
        else:
            if _receipt(config,workspace,project,device,request,paper.snapshot())!=receipt:
                raise IntervalConflict('electronic_context_changed')
            state['intervals'][bid]=receipt;revision=state['revision']+1
            state.setdefault('electronic_source_current',{})[slot]={'binding_id':bid,'revision':revision}
            store._commit(state);status='recorded'
        return {'binding_id':bid,'revision':state['revision'],'source_context_revision':revision,'expected_selection_revision':0,
                'basis':BASIS,'status':status,'interval_confirmed':False,'exact_take_confirmed':False}

def read_current(config,workspace,project,device,targets):
    if targets.get('expected_selection_revision')!=0:raise IntervalConflict('electronic_context_has_no_paper_selection')
    store=ElectronicSourceStore(config.output_dir,project);paper=PaperIntakeStore(config.output_dir,project)
    bid=targets['source_context_id'];generation=targets['expected_source_context_revision']
    before=store.snapshot(); saved=before['intervals'].get(bid)
    if not saved or saved['kind']!=BASIS or bid!=PREFIX+_digest(saved):
        raise IntervalConflict('electronic_context_unknown')
    cursor={'binding_id':bid,'revision':generation};slot=_slot(saved)
    if before.get('electronic_source_current',{}).get(slot)!=cursor:
        raise IntervalConflict('electronic_context_replaced')
    req=saved['selection']
    for name in ('paper_row_id','expected_paper_revision','clip_id','media_id','expected_index_sha256'):
        if req[name]!=targets.get(name):raise IntervalConflict('electronic_context_target_changed')
    try:current=_receipt(config,workspace,project,device,req,paper.snapshot())
    except (OSError,ValueError) as exc:raise IntervalConflict(str(exc)) from exc
    if current!=saved:raise IntervalConflict('electronic_context_stale')
    after=store.snapshot()
    if after.get('electronic_source_current',{}).get(slot)!=cursor or after['intervals'].get(bid)!=saved:
        raise IntervalConflict('electronic_context_replaced')
    return saved
