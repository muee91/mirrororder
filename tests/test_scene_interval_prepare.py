import json
from types import SimpleNamespace
import pytest
from test_scene_interval_ipc import setup_local
from script_organizer.scene_interval_prepare import prepare_selected,validate_targets
from script_organizer.scene_interval_store import SceneIntervalStore,IntervalConflict
from script_organizer.script_supervisor_store import ScriptSupervisorStore
from script_organizer.media_identity import DeviceMediaStore
from script_organizer.source_descriptor_receipt import _sampled_id,_digest


def setup(tmp_path,monkeypatch):
    _,store,source=setup_local(tmp_path,monkeypatch)
    store.path.unlink()
    config=SimpleNamespace(output_dir=tmp_path/'output')
    mid=_sampled_id(source)
    board=ScriptSupervisorStore(config.output_dir)
    board.apply_record({'record_id':'r','expected_revision':0,'actor':'test','record':{'scene':'TEST-1','attachments':[{'clip_id':'c','media_id':mid}]}})
    index={'clips':[{'clip_id':'c','media_id':mid}]}
    (config.output_dir/'material_index.json').write_text(json.dumps(index))
    targets={'record_id':'r','clip_id':'c','media_id':mid,'expected_board_revision':1,'expected_interval_revision':0,'expected_index_sha256':_digest(index),'source_start_frame':2,'source_end_frame':20}
    def run(target=targets,**kwargs):
        return prepare_selected(config,'w','p',target,DeviceMediaStore(),tmp_path/'device',probe=lambda _:pytest.fail('cached receipt should avoid probe'),**kwargs)
    return run,targets,store,source,board


def test_prepare_normal_saved_note_and_confirm_flow(tmp_path,monkeypatch):
    from script_organizer.scene_interval_ipc import cached_descriptor_reader,prepared_read_model,dispatch
    from test_scene_interval_ipc import request_for
    run,t,store,_,board=setup(tmp_path,monkeypatch)
    before=board.load()
    result=run();assert result['status']=='proposal_prepared' and not result['export_ready']
    row=store.read_model()['candidates'][0]
    assert row['provenance']['origin']=='editor_entered_note_snapshot'
    assert row['source_start_frame']==2 and row['review_state']=='proposal'
    reader=cached_descriptor_reader(DeviceMediaStore(),'w','p',tmp_path/'device')
    request=request_for(prepared_read_model(store,reader))
    assert len(dispatch(request,store,reader)['confirmed_intervals'])==1
    assert board.load()==before

@pytest.mark.parametrize('patch',[{'expected_board_revision':0},{'expected_index_sha256':'wrong'},{'media_id':'M_other'},{'clip_id':'unknown'},{'source_end_frame':101},{'expected_interval_revision':7},{'path':'evil'},{'fps':50}])
def test_fail_closed(tmp_path,monkeypatch,patch):
    run,t,store,_,_=setup(tmp_path,monkeypatch)
    with pytest.raises(ValueError):run({**t,**patch})
    assert store.snapshot()['revision']==0


def test_cancel_no_candidate(tmp_path,monkeypatch):
    run,_,store,_,_=setup(tmp_path,monkeypatch)
    assert run(cancelled=lambda:True)['status']=='cancelled'
    assert store.snapshot()['revision']==0


def test_replaced_source_blocked(tmp_path,monkeypatch):
    run,_,store,source,_=setup(tmp_path,monkeypatch)
    source.write_bytes(b'replaced')
    assert run()['status']=='blocked'
    assert store.snapshot()['revision']==0


def test_repeat_is_revision_conflict_not_demotion(tmp_path,monkeypatch):
    run,_,store,_,_=setup(tmp_path,monkeypatch)
    run()
    with pytest.raises(IntervalConflict):run()
    assert store.snapshot()['revision']==1


@pytest.mark.parametrize('module',['tasks','tasks_v2'])
def test_actual_durable_dispatch_selected_only(tmp_path,monkeypatch,module):
    import importlib,time
    from script_organizer.workspace import ProjectConfig
    run,t,store,_,_=setup(tmp_path,monkeypatch)
    config=ProjectConfig.from_file(tmp_path/'project.toml')
    manager=importlib.import_module('script_organizer.'+module).TaskManager(lambda _:config,workspace_id='w')
    task=manager.submit('p','scene_interval_prepare',t,idempotency_key='same-prepare')
    for _ in range(100):
        current=next(x for x in manager.list('p') if x['task_id']==task['task_id'])
        if current['status'] in ('completed','failed','cancelled'):break
        time.sleep(.02)
    assert current['status']=='completed',current
    assert current['result']['status']=='proposal_prepared'
    assert store.snapshot()['revision']==1
    again=manager.submit('p','scene_interval_prepare',t,idempotency_key='same-prepare')
    assert again['task_id']==task['task_id']
    assert len(manager.list('p'))==1


def test_unknown_targets_rejected_before_queue(tmp_path,monkeypatch):
    from script_organizer.tasks import TaskManager
    from script_organizer.workspace import ProjectConfig
    _,t,_,_,_=setup(tmp_path,monkeypatch)
    config=ProjectConfig.from_file(tmp_path/'project.toml')
    manager=TaskManager(lambda _:config,workspace_id='w')
    with pytest.raises(ValueError):manager.submit('p','scene_interval_prepare',{**t,'source_path':'/evil'})
    assert manager.list('p')==[]


def test_http_existing_task_entrypoint_no_seeded_candidate(tmp_path,monkeypatch):
    import threading,urllib.request,time
    from http.server import ThreadingHTTPServer
    from script_organizer.web_server import WorkspaceService,make_handler
    from script_organizer.workspace import WorkspaceConfig
    _,t,store,_,_=setup(tmp_path,monkeypatch)
    # Remove test's descriptor cache: exercise real producer via injected synthetic probe.
    from script_organizer import scene_interval_prepare as module
    for cache in (tmp_path/'device'/'source-receipts').glob('*'):cache.unlink()
    calls=[]
    def probe(path,**kwargs):
        calls.append(path)
        return {'streams':[{'codec_name':'h264','nb_frames':'100','time_base':'1/50','r_frame_rate':'50/1','avg_frame_rate':'50/1'}],'packets':[{'pts':i,'duration':1} for i in range(100)]}
    monkeypatch.setattr(module,'bounded_probe',probe)
    service=WorkspaceService(WorkspaceConfig.from_file(tmp_path/'workspace.toml'))
    server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(service,tmp_path))
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/api/v1/projects/p/tasks',data=json.dumps({'type':'scene_interval_prepare','targets':t}).encode(),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=3) as response:task=json.load(response)
        for _ in range(100):
            current=service.tasks.list('p')[0]
            if current['status'] in ('completed','failed'):break
            time.sleep(.02)
        assert current['status']=='completed',current
        assert current['result']['review_required']
        assert len(calls)==1 and store.snapshot()['revision']==1
        assert not store.read_model()['confirmed_intervals']
    finally:server.shutdown();server.server_close();thread.join()


def test_probe_cancel_reaps_child(tmp_path,monkeypatch):
    from script_organizer.scene_interval_prepare import bounded_probe
    import subprocess
    state={'killed':False,'waited':False}
    class Child:
        returncode=None
        def poll(self):return self.returncode
        def kill(self):state['killed']=True;self.returncode=-9
        def wait(self):state['waited']=True;return self.returncode
    monkeypatch.setattr(subprocess,'Popen',lambda *a,**k:Child())
    monkeypatch.setattr('shutil.which',lambda _: '/test/ffprobe')
    with pytest.raises(ValueError,match='cancelled'):bounded_probe(tmp_path/'synthetic',cancelled=lambda:True)
    assert state=={'killed':True,'waited':True}


def test_fresh_prepare_preserves_prior_confirmation(tmp_path,monkeypatch):
    from script_organizer.scene_interval_ipc import cached_descriptor_reader,prepared_read_model,dispatch
    from test_scene_interval_ipc import request_for
    run,t,store,_,_=setup(tmp_path,monkeypatch)
    run();reader=cached_descriptor_reader(DeviceMediaStore(),'w','p',tmp_path/'device')
    dispatch(request_for(prepared_read_model(store,reader)),store,reader)
    before=store.snapshot()
    result=run({**t,'expected_interval_revision':before['revision']})
    assert result['status']=='already_prepared' and not result['writes_candidate']
    assert store.snapshot()==before
