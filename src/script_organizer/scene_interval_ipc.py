"""One-shot private-stdin local owner consumer, intentionally NOT an HTTP route.

Only packaged Tauri main-window command should invoke this production entry.
This verifies a dedicated trusted local path, not a natural person's identity.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
from .scene_interval_store import SceneIntervalStore,IntervalConflict
from .media_identity import DeviceMediaStore,device_state_dir
from .source_descriptor_receipt import _digest,_stat
from .scene_interval_plan import evidence_digest
from .paper_scene_token import PAUSE_REASON, blocked_paper_interval_scene
from .workspace import WorkspaceConfig,WorkspaceRegistry

BASE={'action','project_id'}
BOARD_STAGE={'expected_revision','expected_draft_revision','selected','episode','scene_id','mode'}
BOARD_APPROVE={'expected_revision','expected_draft_revision','draft_id'}
BOARD_PAPER_READ={'expected_scope','expected_paper_revision'}
BOARD_PAPER_INGEST=BOARD_PAPER_READ|{'format','content'}
BOARD_PAPER_ACTIONS={'board_paper_read':BOARD_PAPER_READ,'board_paper_ingest':BOARD_PAPER_INGEST}
from .electronic_source_context import READ_FIELDS as ELECTRONIC_SOURCE_READ, WRITE_FIELDS as ELECTRONIC_SOURCE_WRITE
BOARD_SOURCE_ACTIONS={'board_source_candidates':ELECTRONIC_SOURCE_READ|{'expected_scope'},
                      'board_link_source':ELECTRONIC_SOURCE_WRITE|{'expected_scope'}}
BOARD_TRIAGE={'expected_scope','expected_paper_revision','expected_index_sha256'}
from .slate_framing_tags import READ as FRAMING_READ, WRITE as FRAMING_WRITE
BOARD_FRAMING={'board_framing_read':FRAMING_READ,'board_framing_set':FRAMING_WRITE}
from .slate_sheet_first import READ as SHEET_READ, ADD as SHEET_ADD, EDIT as SHEET_EDIT
BOARD_SHEET={'board_sheet_read':SHEET_READ,'board_sheet_add':SHEET_ADD,'board_sheet_edit':SHEET_EDIT}
from .slate_field_write import WRITE as FIELD_WRITE
from .slate_thumbnail import ACTION_FIELDS as THUMBNAIL_FIELDS
from .sync_angle_board_route import GET as ANGLE_GET, PATCH as ANGLE_PATCH
BOARD_ANGLES={'board_sync_angle_read':ANGLE_GET,'board_sync_angle_set':ANGLE_PATCH}
STANDARD_REQUEST_LIMIT=8192
INGEST_REQUEST_LIMIT=4_194_304
BOARD_PAGE={'offset','expected_revision','expected_draft_revision','expected_paper_revision','expected_index_sha256'}
CONFIRM={'evidence_id','expected_revision','expected_evidence_version','expected_evidence_sha256','expected_descriptor_revision'}


def validate_request(request):
    if not isinstance(request,dict) or request.get('action') not in ('read','confirm','board_read','board_stage','board_approve','board_paper_read','board_paper_ingest','board_source_candidates','board_link_source','board_source_triage','board_framing_read','board_framing_set','board_sheet_read','board_sheet_add','board_sheet_edit','board_sync_angle_read','board_sync_angle_set','board_paper_field_set','board_slate_thumbnail'):raise ValueError('invalid_action')
    action=request['action']
    allowed=BASE|({'confirm':CONFIRM,'board_stage':BOARD_STAGE,'board_approve':BOARD_APPROVE,'board_source_triage':BOARD_TRIAGE,'board_paper_field_set':FIELD_WRITE,'board_slate_thumbnail':THUMBNAIL_FIELDS}|BOARD_PAPER_ACTIONS|BOARD_SOURCE_ACTIONS|BOARD_FRAMING|BOARD_SHEET|BOARD_ANGLES).get(action,set())
    if set(request)!=allowed and not (action in ('board_stage','board_approve') and set(request)==allowed|{'expected_scope'}) and not (action=='board_read' and set(request) in (BASE|{'offset'},BASE|BOARD_PAGE)):raise ValueError('unexpected_or_missing_request_fields')
    if not isinstance(request['project_id'],str) or not request['project_id'].strip():raise ValueError('project_id_required')
    if request['action']=='confirm':
        if any(type(request[k]) is not int or request[k]<0 for k in ('expected_revision','expected_evidence_version')):raise ValueError('invalid_revision')
        if any(not isinstance(request[k],str) or not request[k] for k in ('evidence_id','expected_evidence_sha256','expected_descriptor_revision')):raise ValueError('invalid_evidence_identity')


def receipt_cache_path(directory,workspace_id,project_id,media_id):
    scope=json.dumps([workspace_id,project_id,media_id],separators=(',',':')).encode()
    return Path(directory)/'source-receipts'/(hashlib.sha256(scope).hexdigest()+'.json')


def cached_descriptor_reader(store,workspace_id,project_id,directory):
    def read(media_id):
        path=receipt_cache_path(directory,workspace_id,project_id,media_id)
        if not path.is_file():return None
        cached=json.loads(path.read_text(encoding="utf-8"))
        project=store.load().get('workspaces',{}).get(workspace_id,{}).get('projects',{}).get(project_id,{})
        bound=project.get('bindings',{}).get(media_id)
        if not isinstance(bound,str):return None
        source=Path(bound).resolve(strict=True)
        token=_digest({'workspace':workspace_id,'project':project_id,'media_id':media_id,'canonical_path':str(source),'stat':_stat(source)})
        public=cached.get('public',{})
        return public if cached.get('private_token')==token and public.get('status')=='verified' and public.get('media_id')==media_id else None
    return read


def prepared_read_model(store,descriptor_reader):
    view=store.read_model();receipts={}
    for row in view['candidates']+view['confirmed_intervals']:
        mid=row.get('media_id')
        if mid not in receipts:
            try:receipts[mid]=descriptor_reader(mid)
            except Exception:receipts[mid]=None
        receipt=receipts[mid]
        if receipt and (receipt.get('asset_revision')!=row.get('asset_revision') or receipt.get('fps')!=row.get('source_fps')):
            receipt=None
        row['review_context']={'expected_revision':view['revision'],
            'expected_evidence_version':row['version'],'expected_evidence_sha256':evidence_digest(row),
            'expected_descriptor_revision':receipt.get('descriptor_revision') if receipt else None,
            'descriptor_state':'prepared' if receipt else 'missing_or_stale'}
        if blocked_paper_interval_scene(row):row['review_context']['blocked_reason']=PAUSE_REASON
    return view


def dispatch(request,store,descriptor_reader,*,source_guard=None):
    validate_request(request)
    if request['project_id']!=store.project_id:raise IntervalConflict('project_changed')
    if request['action']=='read':return prepared_read_model(store,descriptor_reader)
    from contextlib import nullcontext
    from .paper_source_context import is_bound_interval
    row=store.snapshot()['intervals'].get(request['evidence_id'],{})
    bound=is_bound_interval(row)
    if bound and not source_guard:raise IntervalConflict('source_context_guard_required')
    revision=(row.get('source_context_fence') or {}).get('expected_paper_revision')
    if bound and type(revision) is not int:raise IntervalConflict('source_context_prepare_again')
    lock=source_guard[0]._transaction(revision) if bound else nullcontext()
    with lock:
        store.confirm(request['evidence_id'],expected_revision=request['expected_revision'],
            expected_evidence_version=request['expected_evidence_version'],
            expected_evidence_sha256=request['expected_evidence_sha256'],
            expected_descriptor_revision=request['expected_descriptor_revision'],
            actor='desktop-local-confirmation',descriptor_reader=descriptor_reader,source_guard=source_guard[1] if bound else None)
    return prepared_read_model(store,descriptor_reader)


def dispatch_board(request,store,descriptor_reader,source_guard,config,scope,workspace_id,device):
    from .scene_context_board import approve_draft, read_board, stage_correction
    from .paper_source_context import is_bound_interval
    from .script_parser import parse_script
    if request['project_id']!=store.project_id:raise IntervalConflict('project_changed')
    paper,bound_guard=source_guard
    if 'expected_scope' in request and request['expected_scope']!=scope:
        raise IntervalConflict('workspace_scope_changed')
    if request['action'] in BOARD_SOURCE_ACTIONS:
        from .electronic_source_context import bind, candidates
        action=bind if request['action']=='board_link_source' else candidates
        return action(config,workspace_id,store.project_id,device,{k:v for k,v in request.items() if k not in BASE|{'expected_scope'}})
    if request['action'] in BOARD_FRAMING:
        from .slate_framing_tags import FramingStore, framing
        return framing(paper,FramingStore(config.output_dir,store.project_id),request,scope,write=request['action']=='board_framing_set')
    if request['action'] in BOARD_PAPER_ACTIONS:
        revision=request['expected_paper_revision']
        if type(revision) is not int or revision<0:raise ValueError('invalid_paper_revision')
        if request['action']=='board_paper_read':
            model=paper.read_model()
            if model['revision']!=revision:raise IntervalConflict('paper_revision_changed')
            # A private native document receipt enables original-page browsing.
            # It is not an OCR/scene review and does not reopen any original.
            if any(d.get('source_document_digest_claim') for d in model['documents']):
                from .slate_sheet_first import pdf_browse_sources
                verified=pdf_browse_sources(device_state_dir(),workspace_id,store.project_id)
                for d in model['documents']:
                    pages=verified.get(d.get('source_document_digest_claim'))
                    if pages:d['native_pdf_page_count']=pages
            return model
        staged=paper.ingest({'mode':'structured_slate_log.v1','operation':'ingest',**{k:request[k] for k in ('format','content','expected_revision') if k in request},'expected_revision':revision})
        return {'count':staged['summary']['total_rows'],'duplicate':staged['import_status']=='already_imported'}
    def index_read():
        try:return json.loads((Path(config.output_dir)/'material_index.json').read_text(encoding='utf-8'))
        except FileNotFoundError:return {}
    if request['action']=='board_slate_thumbnail':
        from .slate_thumbnail import prepare
        from .scene_interval_plan import _digest as index_digest
        index=index_read()
        if index_digest(index)!=request['expected_index_sha256']:raise IntervalConflict('thumbnail_index_changed')
        result=prepare(index,request,device,workspace_id,store.project_id,device_state_dir())
        if index_digest(index_read())!=request['expected_index_sha256']:raise IntervalConflict('thumbnail_index_changed')
        return result
    if request['action']=='board_paper_field_set' or request['action'] in BOARD_SHEET:
        from .slate_sheet_first import sheet, project_sync_groups
        from .scene_interval_plan import _digest as index_digest
        from .paper_filename_context import _bindings
        from .slate_field_suggestions import read_suggestions
        from .slate_field_write import PaperFieldStore, contexts, project_fields, read_saved, write
        ledger=PaperFieldStore(config.output_dir,store.project_id)
        def read_proof(index,report,groups):
            return read_suggestions(config.output_dir,store.project_id,scope,paper,index,report,groups,device_state_dir(),workspace_id)
        if request['action']=='board_paper_field_set':
            def exact():
                index=index_read()
                if index_digest(index)!=request['expected_index_sha256']:return {}
                try:report=json.loads((Path(config.output_dir)/'sync'/'sync_report.json').read_text(encoding='utf-8'))
                except (OSError,ValueError):return {}
                groups=project_sync_groups(index,report)[:1200]
                return contexts(scope,index,report,read_proof(index,report,groups))
            reading=write(ledger,request,exact)
            return {'workspace_scope':scope,'group_id':request['group_id'],'field':request['field'],'reading':reading,'editorial_authority':False}
        index=index_read()
        def project_paper_fields(report,groups):
            proof=read_proof(index,report,groups)
            try:
                valid={g['group_id'] for g in groups}
                saved={k:v for k,v in read_saved(ledger).items() if k[0] in valid}
                return proof,project_fields(saved,contexts(scope,index,report,proof))
            except (ValueError,OSError,TypeError,KeyError):
                return None,{}
        return sheet(config,store.project_id,request,scope,index,index_digest,add=request['action']=='board_sheet_add',edit=request['action']=='board_sheet_edit',bindings=_bindings(device,workspace_id,store.project_id),suggestions=project_paper_fields)
    if request['action']=='board_source_triage':
        from .electronic_source_triage import source_triage
        from .paper_filename_context import _bindings
        return source_triage(paper.snapshot(),index_read(),_bindings(device,workspace_id,store.project_id),scope=scope,
                             expected_paper_revision=request['expected_paper_revision'],expected_index_sha256=request['expected_index_sha256'])
    def catalog():
        path=getattr(config,'script',None)
        if path is None or not path.is_file():return set()
        return {(s.episode,s.scene_id) for s in parse_script(path).segments if s.scene_id!='UNKNOWN'}
    args={k:v for k,v in request.items() if k not in BASE|{'expected_scope'}}
    if request['action']=='board_read':return {**read_board(store,paper,index_read(),descriptor_reader=descriptor_reader,**args),'workspace_scope':scope}
    if request['action']=='board_stage':
        return stage_correction(store,script_pairs=catalog() if args.get('mode')=='script_scene' else set(),actor='desktop-local-confirmation',**args)
    with paper._transaction(paper.snapshot()['revision']):
        def row_guard(row):
            if is_bound_interval(row):bound_guard(row)
            index=index_read()
            clips=index.get('clips',[])+[c for g in index.get('groups',[]) for c in g.get('members',[])]
            ids={c.get('media_id') for c in clips if c.get('clip_id')==row['clip_id']}
            if ids!={row['media_id']}:raise IntervalConflict('interval_occurrence_changed')
            if row.get('paper_row_id'):
                source=paper.snapshot()['rows'].get(row['paper_row_id'])
                provenance=row.get('provenance',{})
                if not source or source['row_digest']!=provenance.get('row_digest'):
                    raise IntervalConflict('paper_row_changed')
        return approve_draft(store,catalog_reader=catalog,descriptor_reader=descriptor_reader,row_guard=row_guard,
                             actor='desktop-local-confirmation',**args)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--workspace',required=True);args=parser.parse_args()
    request={}
    try:
        data=sys.stdin.buffer.read(INGEST_REQUEST_LIMIT+1)
        if len(data)>INGEST_REQUEST_LIMIT:raise ValueError('request_too_large')
        request=json.loads(data);validate_request(request)
        if request['action']!='board_paper_ingest' and len(data)>STANDARD_REQUEST_LIMIT:raise ValueError('request_too_large')
        workspace=WorkspaceConfig.from_file(args.workspace)
        registry=WorkspaceRegistry(workspace)
        config=registry.project_config(request['project_id'])
        store=SceneIntervalStore(config.output_dir,request['project_id'])
        device=DeviceMediaStore()
        from .paper_source_context import prepared_source_guard
        guard=prepared_source_guard(config,workspace.workspace_id,request['project_id'],device,device_state_dir())
        reader=cached_descriptor_reader(device,workspace.workspace_id,request['project_id'],device_state_dir())
        scope=_digest({'workspace_config':str(Path(args.workspace).resolve()),'workspace_id':workspace.workspace_id,
                       'project_config':str(config.config_path.resolve()),'project_output':str(config.output_dir.resolve()),'project_id':request['project_id']})
        if request['action'] in BOARD_ANGLES:
            from .sync_angle_board_route import check_distinct_project_output,route
            check_distinct_project_output(registry,request['project_id'],config)
            result=route(config,request['project_id'],workspace.workspace_id,scope,request,device,change=request['action']=='board_sync_angle_set')
        else:
            if request['action']=='board_paper_field_set':
                from .sync_angle_board_route import check_distinct_project_output
                check_distinct_project_output(registry,request['project_id'],config)
            result=dispatch_board(request,store,reader,guard,config,scope,workspace.workspace_id,device) if request['action'].startswith('board_') else dispatch(request,store,reader,source_guard=guard)
        if request['action']=='read':
            from .scene_interval_prepare import preparation_context
            try:result['prepare_context']=preparation_context(config)
            except Exception:result['prepare_context']=None
        response={'ok':True,'data':result}
    except IntervalConflict as exc:
        if isinstance(request,dict) and request.get('action') in BOARD_ANGLES:
            response={'ok':False,'error':{'code':'conflict','reason':str(exc),'message':'同步机位或来源已变化；原标注保留，请重新核对。'}}
        else:
            response={'ok':False,'error':{'code':'conflict','message':'证据、媒体凭据或项目版本已变化，请重新核对'}}
    except ValueError as exc:
        if str(exc)==f'interval_not_confirmable:{PAUSE_REASON}':
            response={'ok':False,'error':{'code':PAUSE_REASON,'message':'纸面场号是简写符号，请核对明确场号；未确认区间'}}
        else:
            response={'ok':False,'error':{'code':'unavailable','message':'本机区间确认未就绪；未将候选自动确认为事实'}}
    except Exception:
        response={'ok':False,'error':{'code':'unavailable','message':'本机区间确认未就绪；未将候选自动确认为事实'}}
    sys.stdout.write(json.dumps(response,ensure_ascii=True,allow_nan=False))

if __name__=='__main__':main()
