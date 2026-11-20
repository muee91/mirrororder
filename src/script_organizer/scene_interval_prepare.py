"""Selected saved-note proposal preparation. No recognition, confirmation or NLE I/O."""
import json
import os
import tempfile
from pathlib import Path
from .scene_interval_store import SceneIntervalStore, IntervalConflict
from .script_supervisor_store import ScriptSupervisorStore
from .source_descriptor_receipt import produce_receipt, _digest
from .scene_interval_ipc import receipt_cache_path
from .paper_scene_token import PAUSE_REASON, is_paper_scene_shorthand

FIELDS={'record_id','clip_id','media_id','expected_board_revision','expected_interval_revision','expected_index_sha256','source_start_frame','source_end_frame'}
PAPER_FIELDS=(FIELDS-{'record_id','expected_board_revision'})|{'paper_row_id','expected_paper_revision'}
CONTEXT_FIELDS={'source_context_id','expected_source_context_revision','expected_selection_revision'}
LOCATION_FIELDS=PAPER_FIELDS|CONTEXT_FIELDS|{'prepare_location_only'}
def validate_targets(targets):
    if not isinstance(targets,dict) or set(targets) not in (FIELDS,PAPER_FIELDS,PAPER_FIELDS|CONTEXT_FIELDS,LOCATION_FIELDS):raise ValueError('invalid_prepare_fields')
    if 'prepare_location_only' in targets and targets['prepare_location_only'] is not True:raise ValueError('location_only_confirmation_required')
    if 'source_context_id' in targets:
        if not isinstance(targets['source_context_id'],str) or not targets['source_context_id']:raise ValueError('source_context_required')
        if any(type(targets[k]) is not int or targets[k]<0 for k in ('expected_source_context_revision','expected_selection_revision')):raise ValueError('source_context_revision_required')
    paper='paper_row_id' in targets
    for key in (('paper_row_id' if paper else 'record_id'),'clip_id','media_id','expected_index_sha256'):
        if not isinstance(targets[key],str) or not targets[key]:raise ValueError('missing_prepare_identity')
    for key in (('expected_paper_revision' if paper else 'expected_board_revision'),'expected_interval_revision','source_start_frame','source_end_frame'):
        if type(targets[key]) is not int or targets[key]<0:raise ValueError('invalid_prepare_integer')
    if targets['source_end_frame']<=targets['source_start_frame']:raise ValueError('invalid_source_range')


def prepare_selected(config,workspace_id,project_id,targets,device_store,device_directory,*,probe,cancelled=lambda:False,source_context_reader=None):
    """Called by explicit durable task. Selected range is tentative user intent.

    Editor note snapshot is NOT original paper. No claim of whole-file/take fact.
    Host reads index/board and registered local binding; request has no path/FPS.
    """
    validate_targets(targets)
    paper='paper_row_id' in targets
    location_only=targets.get('prepare_location_only') is True
    from .electronic_source_context import PREFIX as ELECTRONIC_PREFIX, BASIS as ELECTRONIC_BASIS
    electronic=paper and targets.get('source_context_id','').startswith(ELECTRONIC_PREFIX)
    if electronic and not location_only:raise ValueError('electronic_link_requires_explicit_classification')
    if paper:
        from .paper_intake_store import PaperIntakeStore
        board_store=PaperIntakeStore(config.output_dir,project_id)
    else:board_store=ScriptSupervisorStore(config.output_dir)
    interval_store=SceneIntervalStore(config.output_dir,project_id)
    index_path=Path(config.output_dir)/'material_index.json'
    if 'source_context_id' in targets and source_context_reader is None:
        from .paper_source_context import prepare_reader
        source_context_reader=prepare_reader(config,workspace_id,project_id,targets,device_store,cancelled)
    def read_inputs(*,paper_locked=False):
        index=json.loads(index_path.read_text(encoding="utf-8"));board=board_store.snapshot() if paper else board_store.load()
        if _digest(index)!=targets['expected_index_sha256'] or board['revision']!=targets['expected_paper_revision' if paper else 'expected_board_revision']:raise IntervalConflict('project_inputs_changed')
        pair=(targets['clip_id'],targets['media_id'])
        if paper:
            row=board['rows'].get(targets['paper_row_id'])
            if electronic:
                if not row:raise ValueError('paper_row_requires_review')
            elif row and is_paper_scene_shorthand(row['normalized_fields']['scene']):raise ValueError(PAUSE_REASON)
            if location_only and not electronic:
                # Trust only an exact registered source for a truly blank scene.
                if (not row or row.get('review_reasons')!=['scene_requires_review'] or
                    row.get('normalized_fields',{}).get('scene')!=''):
                    raise ValueError('paper_row_requires_review')
            elif not electronic and (not row or not row.get('candidate_ready')):raise ValueError('paper_row_requires_review')
            from .paper_header_selection import reviewed_paper_camera
            if reviewed_paper_camera(board,row) is not None and 'source_context_id' not in targets:
                raise IntervalConflict('reviewed_paper_camera_requires_source_context')
            record={'scene':'' if electronic else row['normalized_fields']['scene'],'note':row['normalized_fields'].get('notes',''), 'paper_evidence':row}
        else:
            record=board['records'].get(targets['record_id'])
            if not record or not record.get('scene'):raise ValueError('saved_scene_note_required')
            if not any((a.get('clip_id'),a.get('media_id'))==pair for a in record.get('attachments',[])):raise ValueError('selected_attachment_not_in_record')
        clips=list(index.get('clips',[]))
        for group in index.get('groups',[]):clips.extend(group.get('members',[]))
        hits=[c for c in clips if c.get('clip_id')==pair[0]]
        if not hits or any(c.get('media_id')!=pair[1] for c in hits):raise ValueError('occurrence_media_binding_ambiguous')
        if 'source_context_id' in targets:
            record['source_context']=source_context_reader(paper_locked=paper_locked)
            if electronic and record['source_context'].get('kind')!=ELECTRONIC_BASIS:
                raise IntervalConflict('untrusted_electronic_source_context')
        return record
    record=read_inputs()
    if interval_store.snapshot()['revision']!=targets['expected_interval_revision']:raise IntervalConflict('interval_revision_changed')
    if cancelled():return {'status':'cancelled','writes_candidate':False}
    cache_path=receipt_cache_path(device_directory,workspace_id,project_id,targets['media_id'])
    try:cached=json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError,ValueError):cached=None
    receipt=produce_receipt(device_store,workspace_id,project_id,targets['media_id'],probe=probe,cached=cached)
    if cancelled():return {'status':'cancelled','writes_candidate':False}
    public=receipt['public']
    if public.get('status')!='verified':return {'status':'blocked','reason':public.get('reason','source_descriptor_unknown'),'writes_candidate':False}
    if targets['source_end_frame']>public['frame_count']:raise ValueError('source_range_out_of_bounds')
    candidate={'evidence_id':'note-'+_digest({'project':project_id,'record':record,'selection':{k:targets[k] for k in ('clip_id','media_id','source_start_frame','source_end_frame')}}),
        'media_id':targets['media_id'],'clip_id':targets['clip_id'],'slate_record_id':targets.get('record_id',''),
        'asset_revision':public['asset_revision'],'source_fps':public['fps'],
        'source_start_frame':targets['source_start_frame'],'source_end_frame':targets['source_end_frame'],
        'boundary_status':'exact_source_frames','extent_basis':'user_selected_tentative',
        'scene':record['scene'],'note':record.get('note',''),
        'raw_cells':record,'provenance':{'origin':'editor_entered_note_snapshot','record_id':targets.get('record_id',''),
            'board_revision':targets.get('expected_board_revision'),'index_sha256':targets['expected_index_sha256']},
        'whole_clip_authorized':False,'exact_take_confirmed':False}
    if paper:
        row=record['paper_evidence']
        candidate['evidence_id']='paper-interval-'+_digest({'project':project_id,'paper_row_id':row['paper_row_id'],'row_digest':row['row_digest'],'selection':{k:targets[k] for k in ('clip_id','media_id','source_start_frame','source_end_frame')}})
        candidate['paper_row_id']=row['paper_row_id']
        candidate['raw_cells']={'cells':row['raw_cells'],'raw_row':row['raw_row']}
        candidate['provenance']={'origin':'imported_paper_transcription','record_id':row['paper_row_id'],
            'document_digest':row['document_digest'],'document_digest_basis':row['document_digest_basis'],
            'row_digest':row['row_digest'],'page':row['page'],'row':row['row'],
            'original_document_verified':False,'source_document_digest_claim':row.get('source_document_digest_claim'),'source_document_digest_verification':row.get('source_document_digest_verification'),'paper_revision':targets['expected_paper_revision'],
            'index_sha256':targets['expected_index_sha256']}
    if location_only:candidate['classification_pending']=True
    if 'source_context' in record:
        candidate['source_context']=record['source_context']
        candidate['source_context_fence']={k:targets[k] for k in CONTEXT_FIELDS|{'expected_paper_revision','expected_index_sha256'}}
        candidate['evidence_id']='context-interval-'+_digest({'evidence':candidate['evidence_id'],'context':record['source_context'],
                                                               'fence':candidate['source_context_fence']})
    # Hold the source store's existing cross-process transaction lock through publication.
    source_lock=board_store._transaction(targets['expected_paper_revision']) if paper else board_store._write_lock()

    with source_lock:
        if read_inputs(paper_locked=paper)!=record:raise IntervalConflict('saved_note_changed')
        if cancelled():return {'status':'cancelled','writes_candidate':False}
        # Recheck source without another probe before publication.
        def no_reprobe(_):raise ValueError('source_changed_after_probe')
        current=produce_receipt(device_store,workspace_id,project_id,targets['media_id'],probe=no_reprobe,cached=receipt)
        if current.get('private_token')!=receipt.get('private_token') or current['public']!=public:raise IntervalConflict('source_changed')
        cache_path.parent.mkdir(parents=True,exist_ok=True)
        fd,tmp=tempfile.mkstemp(dir=cache_path.parent,prefix='receipt.')
        try:
            with os.fdopen(fd,'w',encoding='utf-8') as out:json.dump(receipt,out);out.flush();os.fsync(out.fileno())
            os.replace(tmp,cache_path)
        finally:
            if os.path.exists(tmp):os.unlink(tmp)
        snapshot=interval_store.snapshot()
        if snapshot['revision']!=targets['expected_interval_revision']:raise IntervalConflict('interval_revision_changed')
        prior=snapshot['intervals'].get(candidate['evidence_id'])
        if prior:
            if paper:
                old_provenance=prior.get('provenance',{})
                stable=lambda p:{k:v for k,v in p.items() if k not in ('paper_revision','index_sha256')}
                if stable(old_provenance)==stable(candidate['provenance']):
                    candidate['provenance']=old_provenance  # Preserve first preparation snapshot.
            if any(prior.get(k)!=value for k,value in candidate.items()):raise IntervalConflict('candidate_identity_conflict')
            return {'status':'already_prepared','evidence_id':candidate['evidence_id'],'revision':snapshot['revision'],
                    'review_required':prior.get('review_state')!='human_verified','writes_candidate':False,'export_ready':False}
        saved=interval_store.put_candidate(candidate,expected_revision=targets['expected_interval_revision'])
    return {'status':'location_draft_prepared' if location_only else 'proposal_prepared','evidence_id':candidate['evidence_id'],'revision':saved['revision'],
            'review_required':True,'writes_candidate':True,'export_ready':False}


def bounded_probe(path,*,cancelled=lambda:False):
    """Local ffprobe only, cancellation reaps subprocess and no model/network."""
    import subprocess,time,shutil
    from .source_descriptor_receipt import MAX_PACKETS
    executable=shutil.which('ffprobe')
    if not executable:raise ValueError('bundled_ffprobe_unavailable')
    command=[executable,'-v','error','-select_streams','v:0','-read_intervals',f'%+#{MAX_PACKETS+1}',
        '-show_packets','-show_streams','-show_entries','stream=codec_name,nb_frames,time_base,r_frame_rate,avg_frame_rate:packet=pts,duration','-of','json',str(path)]
    with tempfile.TemporaryFile() as output:
        child=subprocess.Popen(command,stdout=output,stderr=subprocess.DEVNULL)
        deadline=time.monotonic()+20
        try:
            while child.poll() is None:
                if cancelled():raise ValueError('preparation_cancelled')
                if time.monotonic()>deadline:raise ValueError('probe_time_budget_exceeded')
                if os.fstat(output.fileno()).st_size>8*1024*1024:raise ValueError('probe_output_budget_exceeded')
                time.sleep(.05)
            if child.returncode:raise ValueError('probe_failed')
            output.seek(0);raw=output.read(8*1024*1024+1)
            if len(raw)>8*1024*1024:raise ValueError('probe_output_budget_exceeded')
            return json.loads(raw)
        finally:
            if child.poll() is None:child.kill()
            child.wait()


def preparation_context(config):
    """Cheap read projection; no probe or local device path exposure."""
    board=ScriptSupervisorStore(config.output_dir).load()
    index=json.loads((Path(config.output_dir)/'material_index.json').read_text(encoding="utf-8"))
    return {'expected_board_revision':board['revision'],'expected_index_sha256':_digest(index),
            'range_coordinates':'zero_based_source_frames_half_open','provenance_kind':'editor_entered_note_snapshot'}
