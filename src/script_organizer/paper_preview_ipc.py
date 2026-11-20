"""Private one-shot consumer. No HTTP registration/preview endpoint."""
import argparse,base64,json,sys
from pathlib import Path
from script_organizer.paper_source_binding import PaperSourceStore
from script_organizer.paper_preview_service import LocalPaperPreview
from script_organizer.native_pdf_adapter import NativePDFRenderer
from script_organizer.workspace import WorkspaceConfig,WorkspaceRegistry
from script_organizer.media_identity import device_state_dir


def validate(request):
    if not isinstance(request,dict):raise ValueError('request_required')
    common={'action','project_id'}
    allowed={'register':common|{'document_id','expected_paper_revision','expected_document_digest','page_index'},'preview':common|{'geometry_id'},'preview_page':common|{'binding_id','paper_row_id'},'discover':common|{'paper_row_id'}}
    if request.get('action') not in allowed or set(request)!=allowed[request['action']]:raise ValueError('invalid_request_fields')
    if not isinstance(request['project_id'],str) or not request['project_id']:raise ValueError('project_required')
    if request['action']=='register':
        if any(type(request[k]) is not int or request[k]<0 for k in ('expected_paper_revision','page_index')):raise ValueError('invalid_revision_or_page')
        if not isinstance(request['document_id'],str) or not request['document_id']:raise ValueError('document_required')
        if not isinstance(request['expected_document_digest'],str) or len(request['expected_document_digest'])!=64:raise ValueError('digest_required')
    elif request['action']=='discover':
        if not isinstance(request['paper_row_id'],str) or not request['paper_row_id']:raise ValueError('paper_row_required')
    elif request['action']=='preview_page':
        if not isinstance(request['binding_id'],str) or len(request['binding_id'])!=64 or not isinstance(request['paper_row_id'],str) or not request['paper_row_id']:raise ValueError('bound_page_required')
    elif not isinstance(request['geometry_id'],str) or len(request['geometry_id'])!=64:raise ValueError('geometry_required')


def dispatch(request,service):
    validate(request)
    if request['project_id']!=service.paper.project_id:raise ValueError('project_mismatch')
    if request['action']=='discover':return service.discover_row(request['paper_row_id'])
    if request['action']=='register':
        return service.register_selected(**{k:v for k,v in request.items() if k not in ('action','project_id')})
    if request['action']=='preview_page':
        result,png=service.preview(request['binding_id'],paper_row_id=request['paper_row_id'])
    else:
        result=service.preview_geometry(request['geometry_id']);png=result.pop('png')
    if len(png)>8*1024*1024:raise ValueError('preview_transport_budget')
    return {**result,'png_base64':base64.b64encode(png).decode('ascii'),'mime_type':'image/png'}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--workspace',required=True);parser.add_argument('--native-helper',required=True);args=parser.parse_args()
    try:
        raw=sys.stdin.buffer.read(16385)
        if len(raw)>16384:raise ValueError('request_budget')
        envelope=json.loads(raw)
        if set(envelope)!={'request','selected_path'}:raise ValueError('private_envelope_required')
        request=envelope['request'];validate(request)
        # selected_path is added by native Rust dialog, never accepted as a public request field.
        selected=envelope['selected_path']
        if request['action']!='register' and selected is not None:raise ValueError('unexpected_selection')
        workspace=WorkspaceConfig.from_file(args.workspace)
        config=WorkspaceRegistry(workspace).project_config(request['project_id'])
        service=LocalPaperPreview(PaperSourceStore(config.output_dir,request['project_id']),device_state_dir(),native_picker=lambda:selected,native_renderer=NativePDFRenderer(args.native_helper))
        result={'ok':True,'data':dispatch(request,service)}
    except Exception:
        result={'ok':False,'error':{'code':'source_preview_unavailable','message':'原始 PDF 或本机预览凭据不可用；未更改原纸记录'}}
    sys.stdout.write(json.dumps(result,ensure_ascii=True,allow_nan=False))
if __name__=='__main__':main()
