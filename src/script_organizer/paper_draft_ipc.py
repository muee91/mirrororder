"""Dedicated private native PDF draft consumer. Not an HTTP endpoint."""
import argparse,base64,json,sys
from .paper_pdf_drafts import PDFDrafts
from .native_pdf_adapter import NativePDFRenderer
from .workspace import WorkspaceConfig,WorkspaceRegistry
from .media_identity import device_state_dir


def validate(request):
    fields={'read':{'action','project_id'},'select':{'action','project_id','expected_draft_revision'},'preview_first_page':{'action','project_id','draft_id','expected_draft_revision'},
            'ocr_candidate':{'action','project_id','draft_id','expected_draft_revision','page_index'}}
    common={'action','project_id','draft_id','expected_draft_revision','page_index'}
    fields.update(preview_page=common,region_read=common,
        region_set=common|{'expected_region_revision','expected_render_map_id','pixel_rect'},
        region_remove=common|{'expected_region_revision','expected_render_map_id'})
    fields.update(cell_review_read={'action','project_id','task_id'},reviewed_row={'action','project_id','task_id','row_id','expected_candidate_sha256','expected_review_revision','expected_paper_revision','cells','column_mapping'})
    fields.update(header_context={'action','project_id'}, header_read={'action','project_id','header_id','expected_selection_revision','expected_paper_revision'},
        header_select=common|{'expected_render_map_id','pixel_rect','expected_selection_revision','expected_paper_revision','paper_row_id','row_digest','card','camera'})
    fields.update(source_candidates={'action','project_id','paper_row_id','expected_paper_revision'},source_bind={'action','project_id','header_id','expected_selection_revision','expected_paper_revision','expected_index_sha256','expected_binding_revision','clip_id','media_id'})
    fields['adopt_registered_preview']={'action','project_id','binding_id','paper_row_id','expected_paper_revision'}
    if not isinstance(request,dict) or request.get('action') not in fields:raise ValueError('invalid_draft_request')
    action=request['action']; required=fields[action]
    nested={'source_candidates':{'nested_camera','row_digest'},'header_select':{'nested_camera'}}
    if set(request)!=required and (action not in nested or set(request)!=required|nested[action]):raise ValueError('invalid_draft_request')
    if 'nested_camera' in request and request['nested_camera'] not in ('A','B','C'):raise ValueError('invalid_nested_camera')
    if not isinstance(request['project_id'],str) or not request['project_id']:raise ValueError('project_required')
    if request['action']=='adopt_registered_preview':
        if type(request['expected_paper_revision']) is not int or request['expected_paper_revision']<0:raise ValueError('paper_revision_required')
        import re
        if any(not isinstance(request[key],str) or not re.fullmatch(pattern,request[key]) for key,pattern in (
            ('binding_id',r'[0-9a-f]{64}'),('paper_row_id',r'paper-row-[0-9a-f]{64}'))):raise ValueError('verified_original_binding_required')
        return
    if request['action'] in ('source_candidates','source_bind'):
        if type(request['expected_paper_revision']) is not int or request['expected_paper_revision']<0:raise ValueError('paper_revision_required')
        if request['action']=='source_bind' and any(type(request[k]) is not int or request[k]<0 for k in ('expected_selection_revision','expected_binding_revision')):raise ValueError('binding_revision_required')
        return
    if request['action'].startswith('header_'):
        if request['action']!='header_context' and any(type(request[k]) is not int or request[k]<0 for k in ('expected_selection_revision','expected_paper_revision')):raise ValueError('header_revision_required')
        return
    if request['action'] in ('cell_review_read','reviewed_row'):
        if not isinstance(request['task_id'],str) or not request['task_id']:raise ValueError('task_required')
        if request['action']=='reviewed_row' and any(type(request[k]) is not int or request[k]<0 for k in ('expected_review_revision','expected_paper_revision')):raise ValueError('review_revision_required')
        return
    if request['action']!='read' and (type(request['expected_draft_revision']) is not int or request['expected_draft_revision']<0):raise ValueError('draft_revision_required')
    if request['action'] in ('ocr_candidate','preview_first_page') and (not isinstance(request['draft_id'],str) or not request['draft_id'].startswith('pdf-draft-')):raise ValueError('draft_required')
    if request['action'] in ('ocr_candidate','preview_page','region_read','region_set','region_remove'):
        if not isinstance(request['draft_id'],str) or not request['draft_id'].startswith('pdf-draft-') or type(request['page_index']) is not int or request['page_index']<0:raise ValueError('draft_page_required')
    if request['action'] in ('region_set','region_remove'):
        if type(request['expected_region_revision']) is not int or request['expected_region_revision']<0 or not isinstance(request['expected_render_map_id'],str):raise ValueError('invalid_region_context')
        if request['action']=='region_set' and (not isinstance(request['pixel_rect'],list) or len(request['pixel_rect'])!=4 or any(type(v) is not int for v in request['pixel_rect'])):raise ValueError('integer_pixel_rect_required')


def dispatch(request,service,*,project_config=None,workspace_id=None,device_store=None):
    validate(request)
    if request['project_id']!=service.project_id:raise ValueError('project_mismatch')
    if request['action']=='adopt_registered_preview':
        if project_config is None or workspace_id is None:raise ValueError('host_project_config_required')
        from .paper_source_binding import PaperSourceStore
        from .paper_preview_service import LocalPaperPreview
        store=PaperSourceStore(project_config.output_dir,service.project_id)
        preview=LocalPaperPreview(store,service.root,native_picker=None,native_renderer=None)
        with store._transaction(request['expected_paper_revision']):
            original,sha=preview.verified_original_for_row(request['binding_id'],paper_row_id=request['paper_row_id'],
                                                          expected_paper_revision=request['expected_paper_revision'])
            return service.adopt_verified_preview(original,sha)
    if request['action'] in ('source_candidates','source_bind'):
        if project_config is None:raise ValueError('host_project_config_required')
        from .paper_source_context import candidates,bind
        if workspace_id is None or device_store is None:raise ValueError('host_media_binding_required')
        if request['action']=='source_candidates':return candidates(project_config,service.project_id,request['paper_row_id'],request['expected_paper_revision'],device_store=device_store,workspace_id=workspace_id,nested_camera=request.get('nested_camera'),row_digest=request.get('row_digest'))
        return bind(project_config,service,workspace_id,device_store,{k:v for k,v in request.items() if k not in ('action','project_id')})
    if request['action'].startswith('header_'):
        if project_config is None:raise ValueError('host_project_config_required')
        from .paper_header_selection import PaperHeaderSelections
        from .paper_intake_store import PaperIntakeStore
        from .source_descriptor_receipt import _digest
        paper=PaperIntakeStore(project_config.output_dir,service.project_id)
        headers=PaperHeaderSelections(service,paper.snapshot,paper_lock=paper._transaction)
        if request['action']=='header_context':return {'selection_revision':headers.revision(),'paper_revision':paper.snapshot()['revision'],'basis':'operator_reviewed_filename_convention_not_camera_metadata'}
        args={k:v for k,v in request.items() if k not in ('action','project_id')}
        header=headers.set(**args) if request['action']=='header_select' else headers.read_current(**args)
        return {'header':header,'header_digest':_digest(header),'interval_confirmed':False,'basis':'operator_reviewed_filename_convention_not_camera_metadata'}
    if request['action'] in ('cell_review_read','reviewed_row'):
        if project_config is None:raise ValueError('host_project_config_required')
        from .paper_ocr_derived import read_review,derive_row
        if request['action']=='cell_review_read':return read_review(project_config,service.project_id,request['task_id'])
        return derive_row(project_config,service.project_id,service,{k:v for k,v in request.items() if k not in ('action','project_id')})
    if request['action']=='read':return service.read()
    if request['action']=='select':return service.select(request['expected_draft_revision'])
    if request['action']=='preview_first_page':
        result,png=service.preview_first_page(draft_id=request['draft_id'],expected_draft_revision=request['expected_draft_revision'])
        return {**result,'png_base64':base64.b64encode(png).decode('ascii'),'mime_type':'image/png'}
    args={k:v for k,v in request.items() if k not in ('action','project_id')}
    if request['action']=='preview_page':
        from .source_descriptor_receipt import _digest
        with service.selected_page(**args) as (result,png):
            return {**result,'render_map_id':_digest(result['receipt']['render_map']),
                    'png_base64':base64.b64encode(png).decode('ascii'),'mime_type':'image/png'}
    if request['action'] in ('region_read','region_set','region_remove'):
        from .paper_body_region import PaperBodyRegions
        store=PaperBodyRegions(service)
        return getattr(store,{'region_read':'read','region_set':'set','region_remove':'remove'}[request['action']])(**args)
    return service.ocr_candidate(**args)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--workspace',required=True);parser.add_argument('--native-helper',required=True);args=parser.parse_args()
    try:
        raw=sys.stdin.buffer.read(16385)
        if len(raw)>16384:raise ValueError('request_budget')
        envelope=json.loads(raw)
        if not isinstance(envelope,dict) or set(envelope)!={'request','selected_path'}:raise ValueError('private_envelope_required')
        request=envelope['request'];validate(request)
        if request['action']!='select' and envelope['selected_path'] is not None:raise ValueError('unexpected_selection')
        workspace=WorkspaceConfig.from_file(args.workspace)
        project_config=WorkspaceRegistry(workspace).project_config(request['project_id']) # validates real project, no client root
        service=PDFDrafts(device_state_dir(),workspace.workspace_id,request['project_id'],native_picker=lambda:envelope['selected_path'],native_renderer=NativePDFRenderer(args.native_helper))
        from .media_identity import DeviceMediaStore
        result={'ok':True,'data':dispatch(request,service,project_config=project_config,workspace_id=workspace.workspace_id,device_store=DeviceMediaStore())}
    except Exception:
        result={'ok':False,'error':{'code':'pdf_draft_unavailable','message':'PDF 草稿或本机来源已变化；未生成识别结果'}}
    sys.stdout.write(json.dumps(result,ensure_ascii=True,allow_nan=False))
if __name__=='__main__':main()
