"""Compose trusted native page-header review with registered filename bindings."""
import json
from pathlib import Path
from .paper_header_selection import PaperHeaderSelections,reviewed_paper_camera
from .paper_intake_store import PaperIntakeStore
from .paper_filename_context import FilenameContextStore,discover
from .source_descriptor_receipt import _digest
from .scene_interval_store import IntervalConflict


def _index(config):return json.loads((Path(config.output_dir)/'material_index.json').read_text(encoding='utf-8'))

def candidates(config,project_id,paper_row_id,expected_paper_revision,*,device_store,workspace_id,nested_camera=None,row_digest=None):
    paper=PaperIntakeStore(config.output_dir,project_id).snapshot()
    if paper['revision']!=expected_paper_revision:raise IntervalConflict('paper_revision_changed')
    row=paper['rows'].get(paper_row_id)
    if not row:raise ValueError('unknown_paper_row')
    index=_index(config)
    original=None
    known=reviewed_paper_camera(paper,row)
    if nested_camera is not None:
        from .paper_nested_camera import require_cell
        original=require_cell(row,nested_camera,row_digest)
        if known is not None and known!=nested_camera:raise IntervalConflict('reviewed_paper_camera_conflict')
    result=discover(index,original['code'] if original else row['normalized_fields'].get('filename',''),_digest(index),device_store=device_store,workspace=workspace_id,project=project_id)
    # Inventory paths are never exposed; basename/card labels only.
    if original is not None:
        result={**result,'electronic_source_cell':original}
    return {**result,'paper_row_id':paper_row_id,'row_digest':row['row_digest'],
      'reviewed_paper_camera':original['camera'] if original else known,
      'expected_binding_revision':FilenameContextStore(config.output_dir,project_id).snapshot()['revision'],
      'basis':'filename_convention_not_camera_metadata','interval_confirmed':False}


def bind(config,drafts,workspace_id,device_store,request):
    expected={'header_id','expected_selection_revision','expected_paper_revision','expected_index_sha256','expected_binding_revision','clip_id','media_id'}
    if set(request)!=expected:raise ValueError('invalid_source_binding_request')
    paper=PaperIntakeStore(config.output_dir,drafts.project_id)
    # One paper lock covers repeated header validation and binding publication.
    with paper._transaction(request['expected_paper_revision']):
        headers=PaperHeaderSelections(drafts,paper.snapshot)
        def reader(hid):return headers.read_current(header_id=hid,expected_selection_revision=request['expected_selection_revision'],expected_paper_revision=request['expected_paper_revision'])
        header=reader(request['header_id'])
        payload={k:header[k] for k in ('paper_row_id','row_digest','card','camera')}
        payload.update(header_id=header['header_id'],header_digest=_digest(header),code=header['clip_code'],
          expected_index_sha256=request['expected_index_sha256'],clip_id=request['clip_id'],media_id=request['media_id'])
        saved=FilenameContextStore(config.output_dir,drafts.project_id).record(payload,expected_revision=request['expected_binding_revision'],
          index_reader=lambda:_index(config),header_reader=reader,device_store=device_store,workspace=workspace_id)
        return {**saved,'expected_selection_revision':request['expected_selection_revision'],'basis':'operator_confirmed_filename_prefix',
          'interval_confirmed':False,'exact_take_confirmed':False}


def prepare_reader(config,workspace_id,project_id,targets,device_store,cancelled,*,drafts=None):
    """Worker-only constructor; fixed packaged helper, never a target pathname."""
    from .electronic_source_context import PREFIX, read_current
    if targets['source_context_id'].startswith(PREFIX):
        return lambda **_:read_current(config,workspace_id,project_id,device_store,targets)
    if drafts is None:
        from .paper_ocr_task import service
        drafts=service(workspace_id,project_id,cancelled)
    paper=PaperIntakeStore(config.output_dir,project_id)
    def read(*,paper_locked=False):
        contexts=FilenameContextStore(config.output_dir,project_id)
        headers=PaperHeaderSelections(drafts,paper.snapshot,paper_lock=None if paper_locked else paper._transaction)
        def header_reader(hid):return headers.read_current(header_id=hid,expected_selection_revision=targets['expected_selection_revision'],expected_paper_revision=targets['expected_paper_revision'])
        return contexts.require_for_prepare(targets['source_context_id'],targets,index_reader=lambda:_index(config),header_reader=header_reader,device_store=device_store,workspace=workspace_id)
    return read

def is_bound_interval(row):
    return 'source_context' in row or 'source_context_fence' in row or str(row.get('evidence_id','')).startswith('context-interval-')


def prepared_source_guard(config,workspace_id,project_id,device_store,device_directory):
    from .paper_pdf_drafts import PDFDrafts
    paper=PaperIntakeStore(config.output_dir,project_id)
    def check(row):
        if not is_bound_interval(row):return
        fence=row.get('source_context_fence')
        expected={'source_context_id','expected_source_context_revision','expected_selection_revision','expected_paper_revision','expected_index_sha256'}
        if not isinstance(fence,dict) or set(fence)!=expected:
            raise IntervalConflict('source_context_prepare_again')
        from .electronic_source_context import PREFIX, read_current
        targets={**fence,**{k:row[k] for k in ('paper_row_id','clip_id','media_id','source_start_frame','source_end_frame')}}
        if isinstance(fence['source_context_id'],str) and fence['source_context_id'].startswith(PREFIX):
            current=read_current(config,workspace_id,project_id,device_store,targets)
            if current!=row.get('source_context'):raise IntervalConflict('prepared_source_context_changed')
            return
        drafts=PDFDrafts(device_directory,workspace_id,project_id,native_picker=None,native_renderer=None)
        headers=PaperHeaderSelections(drafts,paper.snapshot)
        contexts=FilenameContextStore(config.output_dir,project_id)
        def header_reader(hid):
            return headers.read_bound_source(header_id=hid,expected_selection_revision=fence['expected_selection_revision'],
                                             expected_paper_revision=fence['expected_paper_revision'])
        current=contexts.require_for_prepare(fence['source_context_id'],targets,index_reader=lambda:_index(config),
            header_reader=header_reader,device_store=device_store,workspace=workspace_id)
        if current!=row.get('source_context'):raise IntervalConflict('prepared_source_context_changed')
    return paper,check


def delivery_source_epoch(config,workspace_id,project_id,interval_snapshot,device_store,device_directory):
    """Cache key and availability fence for already confirmed bound intervals."""
    from .scene_interval_plan import evidence_digest
    from .paper_scene_token import PAUSE_REASON, blocked_paper_interval_scene
    confirmed=[row for row in interval_snapshot['intervals'].values()
               if row.get('review_state')=='human_verified']
    # Hide stale DRPs from current delivery only when a past paper marker
    # contains a known shorthand. Leave any files and all other epochs intact.
    states={row['evidence_id']:[evidence_digest(row),PAUSE_REASON] for row in confirmed
            if blocked_paper_interval_scene(row)}
    rows=[row for row in confirmed if row['evidence_id'] not in states and is_bound_interval(row)]
    if rows:
        paper,check=prepared_source_guard(config,workspace_id,project_id,device_store,device_directory)
        with paper._transaction(paper.snapshot()['revision']):
            for row in rows:
                try:
                    check(row)
                    current=True
                except (OSError,ValueError,KeyError,RuntimeError):
                    current=False
                states[row['evidence_id']]=[evidence_digest(row),current]
    return _digest(states) if states else None
