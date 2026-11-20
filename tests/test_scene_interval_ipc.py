import json,os,subprocess,sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import pytest
from script_organizer.scene_interval_ipc import dispatch,validate_request,receipt_cache_path,prepared_read_model
from script_organizer.scene_interval_store import SceneIntervalStore,IntervalConflict
from script_organizer.source_descriptor_receipt import produce_receipt,_sampled_id
from script_organizer.media_identity import DeviceMediaStore
from test_scene_interval_plan import fixture


def setup_local(tmp_path,monkeypatch):
    device=tmp_path/'device';device.mkdir();monkeypatch.setenv('MIRRORORDER_DEVICE_STATE_DIR',str(device))
    workspace=tmp_path/'workspace.toml';workspace.write_text('[workspace]\nid="w"\nregistry="registry.json"\n')
    project=tmp_path/'project.toml';project.write_text('[project]\nname="synthetic"\n[input]\nkind="fcpxml"\n[output]\ndirectory="output"\n')
    (tmp_path/'registry.json').write_text(json.dumps({'projects':[{'project_id':'p','config_path':'project.toml'}]}))
    source=tmp_path/'synthetic.mov';source.write_bytes(b'synthetic media');mid=_sampled_id(source)
    (device/'media-bindings.json').write_text(json.dumps({'workspaces':{'w':{'projects':{'p':{'bindings':{mid:str(source)}}}}}}))
    probe=lambda _:{'streams':[{'codec_name':'h264','nb_frames':'100','time_base':'1/50','r_frame_rate':'50/1','avg_frame_rate':'50/1'}],'packets':[{'pts':i,'duration':1} for i in range(100)]}
    receipt=produce_receipt(DeviceMediaStore(),'w','p',mid,probe=probe)
    cache=receipt_cache_path(device,'w','p',mid);cache.parent.mkdir();cache.write_text(json.dumps(receipt))
    _,row=fixture();row.update(media_id=mid,asset_revision=receipt['public']['asset_revision'],source_fps=receipt['public']['fps'])
    store=SceneIntervalStore(tmp_path/'output','p');store.put_candidate(row,expected_revision=0)
    return workspace,store,source

def call(workspace,request):
    # pytest's pythonpath setting is not inherited by a fresh interpreter.
    # Pin the child to this candidate, never an installed or ambient checkout.
    env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1] / 'src'))
    proc=subprocess.run([sys.executable,'-m','script_organizer.scene_interval_ipc','--workspace',str(workspace)],input=json.dumps(request),text=True,capture_output=True,timeout=8,env=env)
    assert proc.returncode==0,proc.stderr
    return json.loads(proc.stdout)

def request_for(view):
    row=view['candidates'][0]
    return {'action':'confirm','project_id':'p','evidence_id':row['evidence_id'],**{k:v for k,v in row['review_context'].items() if k.startswith('expected_')}}

def test_real_private_stdin_read_confirm_repeat_is_conflict(tmp_path,monkeypatch):
    workspace,store,_=setup_local(tmp_path,monkeypatch)
    view=call(workspace,{'action':'read','project_id':'p'})['data']
    request=request_for(view)
    assert view['candidates'][0]['review_context']['descriptor_state']=='prepared'
    assert call(workspace,request)['ok']
    assert call(workspace,request)['error']['code']=='conflict'
    saved=store.snapshot()['intervals']['record1']
    assert saved['review']['actor']=='desktop-local-confirmation'

def test_two_real_processes_share_cas_lock(tmp_path,monkeypatch):
    workspace,store,_=setup_local(tmp_path,monkeypatch)
    req=request_for(call(workspace,{'action':'read','project_id':'p'})['data'])
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses=list(pool.map(lambda _:call(workspace,req),range(2)))
    assert sorted(r['ok'] for r in responses)==[False,True]
    assert store.snapshot()['revision']==2

def test_untrusted_fields_wrong_project_digest_descriptor_and_replacement_fail(tmp_path,monkeypatch):
    workspace,store,source=setup_local(tmp_path,monkeypatch)
    req=request_for(call(workspace,{'action':'read','project_id':'p'})['data'])
    for patch in [{'actor':'human'},{'workspace':'/evil'},{'review_state':'human_verified'},{'action':'export'}, {'project_id':'other'}, {'expected_evidence_sha256':'0'*64}, {'expected_descriptor_revision':'wrong'}, {'expected_revision':100}]:
        assert not call(workspace,{**req,**patch})['ok']
    source.write_bytes(b'replaced')
    assert not call(workspace,req)['ok']
    assert store.snapshot()['revision']==1

def test_read_missing_receipt_is_honest_and_never_probes(tmp_path,monkeypatch):
    workspace,store,_=setup_local(tmp_path,monkeypatch)
    for path in (tmp_path/'device'/'source-receipts').glob('*'):path.unlink()
    result=call(workspace,{'action':'read','project_id':'p'})
    assert result['ok'] and result['data']['candidates'][0]['review_context']['descriptor_state']=='missing_or_stale'
    assert not result['data']['export_ready']


def test_loopback_relay_and_agent_http_have_no_confirmation_entry(tmp_path,monkeypatch):
    import threading,urllib.request,urllib.error
    from http.server import ThreadingHTTPServer
    from script_organizer.web_server import WorkspaceService,make_handler
    from script_organizer.workspace import WorkspaceConfig
    workspace,store,_=setup_local(tmp_path,monkeypatch)
    req=request_for(call(workspace,{'action':'read','project_id':'p'})['data'])
    service=WorkspaceService(WorkspaceConfig.from_file(workspace))
    server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(service,tmp_path))
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        for path,headers in [('/api/v1/projects/p/scene-interval-confirm',{}),('/api/v1/projects/p/scene-interval-confirm',{'Origin':'https://evil.example','X-Forwarded-For':'127.0.0.1'}),('/api/agent/v1/projects/p/scene-interval-confirm',{'Authorization':'Bearer fake'})]:
            request=urllib.request.Request(f'http://127.0.0.1:{server.server_port}'+path,data=json.dumps(req).encode(),headers={'Content-Type':'application/json',**headers})
            with pytest.raises(urllib.error.HTTPError) as error:urllib.request.urlopen(request,timeout=3)
            assert error.value.code in (401,403,404)
        assert store.snapshot()['revision']==1
    finally:server.shutdown();server.server_close();thread.join()
