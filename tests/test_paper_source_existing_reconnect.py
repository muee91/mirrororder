import hashlib
import json
from contextlib import nullcontext
import pytest
from types import SimpleNamespace

from script_organizer import media_inventory_task_runtime as runtime, tasks
from script_organizer.media_identity import DeviceMediaStore, media_id_for_path
from script_organizer.paper_draft_ipc import dispatch
from script_organizer.paper_intake_store import PaperIntakeStore
from script_organizer.source_descriptor_receipt import _digest


@pytest.mark.parametrize("interrupt", [False, True])
def test_existing_durable_scan_feeds_paper_candidates(tmp_path, monkeypatch, interrupt):
    # Scope state to QA and simulate explicit selection of one project root.
    monkeypatch.setenv('MIRRORORDER_DEVICE_STATE_DIR', str(tmp_path/'device'))
    root=tmp_path/'selected-camera-roots';root.mkdir()
    project='p';workspace='w';output=tmp_path/'output';output.mkdir()
    files={card:root/(card+'C218_261110UA.MP4') for card in ('A001','B001','B002','C001','C002')}
    for card,path in files.items():path.write_bytes(card.encode()*41)
    (root/'A009C218_261110UA.MP4').write_bytes(b'unrelated same code is not in project index')
    originals={p.name:hashlib.sha256(p.read_bytes()).digest() for p in root.iterdir()}
    index={'clips':[{'clip_id':'clip-'+card,'media_id':media_id_for_path(path),'camera':card[0],'media_path':'','name':path.stem}
                    for card,path in files.items()]}
    index_path=output/'material_index.json';index_path.write_text(json.dumps(index),encoding='utf-8');prior_index=index_path.read_bytes()
    config=SimpleNamespace(output_dir=output,is_media_directory=True,camera_patterns={})
    paper=PaperIntakeStore(output,project)
    record=paper.ingest({'mode':'structured_slate_log.v1','operation':'ingest','format':'json','expected_revision':0,
        'content':json.dumps({'rows':[{'pdf_page':1,'row_index':1,'filename':'218'},
                                      {'pdf_page':1,'row_index':2,'filename':'219'}]})})
    prior_paper=paper.path.read_bytes()
    device=DeviceMediaStore()
    def candidates(row=0):
        return dispatch({'action':'source_candidates','project_id':project,
            'paper_row_id':record['rows'][row]['paper_row_id'],'expected_paper_revision':1},
            SimpleNamespace(project_id=project),project_config=config,workspace_id=workspace,device_store=device)
    assert candidates()['status']=='project_unbound'
    device.add_roots(workspace,project,[str(root)])
    # The existing local route stores an opaque task request. Exercise its
    # actual worker using only an in-memory job lifecycle and synthetic media.
    rid=runtime._store_scan_request(device,workspace_id=workspace,project_id=project,roots=[str(root)],replace=False)
    task={'task_id':'scan-1','type':'media_inventory_scan','targets':{'request_id':rid}}
    manager=SimpleNamespace(_threads={},workspace_id=workspace,project_loader=lambda _:config,
        _load=lambda _: {},_task=lambda *args:task,_update=lambda *args,**kwargs:task.update(kwargs),
        _resource=lambda *args:nullcontext(),_cancel_requested=lambda *args:False)
    if not runtime._INSTALLED:
        monkeypatch.setattr(tasks.TaskManager,'_run',tasks.TaskManager._run)
        monkeypatch.setattr(DeviceMediaStore,'scan',DeviceMediaStore.scan)
        monkeypatch.setattr(DeviceMediaStore,'probe_roots',DeviceMediaStore.probe_roots)
        monkeypatch.setattr(DeviceMediaStore,'remove_project',DeviceMediaStore.remove_project)
        from script_organizer import web_server
        monkeypatch.setattr(web_server,'make_handler',web_server.make_handler)
        monkeypatch.setattr(runtime,'_INSTALLED',False)
        runtime.install_media_inventory_task_runtime()
    if interrupt:
        def stop_projection(path,*,cancelled):
            manager._cancel_requested=lambda *args:True
            monkeypatch.setattr(runtime,'monotonic',lambda:10**10)
            cancelled()
        monkeypatch.setattr(runtime,'_probe_dimensions',stop_projection)
    tasks.TaskManager._run(manager,project,task['task_id'])
    if interrupt:
        assert (task['status'],task['stage'])==('cancelled','inventory_projection_cancelled'),task
        assert task['result']=={'device_local':True,'paths_exposed':False,'bindings_committed':True,
            'inventory_published':False,'project_coverage_complete':False,
            'selected_scan_entries':6,'preview_rows_built':0}
        assert not runtime._snapshot_path(device,workspace,project).exists()
    else:
        assert task['status']=='completed', task
    matches=candidates()
    assert matches['status']=='ambiguous_candidates' and len(matches['candidates'])==5
    assert matches['indexed_registered_media_count']==5 and matches['same_card_collision'] is False
    assert matches['camera_conflict'] is False and matches['confirmed'] is False
    assert candidates(1)['status']=='no_matching_code'
    assert index_path.read_bytes()==prior_index and paper.path.read_bytes()==prior_paper
    assert originals=={p.name:hashlib.sha256(p.read_bytes()).digest() for p in root.iterdir()}
    assert not (output/'scene_intervals.json').exists()


def test_colliding_occurrences_and_index_camera_conflict(tmp_path):
    from script_organizer.paper_filename_context import discover
    p=tmp_path/'A001C218_261110UA.MP4';p.write_bytes(b'read only')
    mid=media_id_for_path(p)
    index={'clips':[{'clip_id':'one','media_id':mid,'camera':'A'},
                    {'clip_id':'two','media_id':mid,'camera':'B'}]}
    device=SimpleNamespace(load=lambda:{'workspaces':{'w':{'projects':{'p':{'bindings':{mid:str(p)}}}}}})
    found=discover(index,'218',_digest(index),device_store=device,workspace='w',project='p')
    assert found['status']=='ambiguous_candidates' and found['same_card_collision'] and found['camera_conflict']
