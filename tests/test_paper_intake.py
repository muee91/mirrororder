import json,time,threading,urllib.request,urllib.error
from types import SimpleNamespace
from http.server import ThreadingHTTPServer
import pytest
from script_organizer.paper_intake_store import PaperIntakeStore
from script_organizer.scene_interval_store import IntervalConflict
from test_scene_interval_prepare import setup
from script_organizer.scene_interval_prepare import prepare_selected
from script_organizer.media_identity import DeviceMediaStore


def body(rows,revision=0):
    return {'mode':'structured_slate_log.v1','operation':'ingest','format':'json','content':json.dumps(rows,ensure_ascii=False),'expected_revision':revision}


def row(**extras):return {'pdf_page':1,'printed_page':'01','row_index':1,'scene_raw':'003','shot_raw':'02A','take_raw':'003','date_raw':'不详','notes_raw':'原文 中文','cameras':{'A':{'clip_raw':'0003','ok_raw':'○'}},**extras}


def test_raw_immutable_lexical_cells_idempotent(tmp_path):
    store=PaperIntakeStore(tmp_path,'p');raw=row()
    first=store.ingest(body([raw]));saved=first['rows'][0]
    assert saved['raw_row']==raw and saved['normalized_fields']['scene']=='003' and saved['normalized_fields']['shot']=='02A'
    assert saved['normalized_fields']['take']=='003'
    assert saved['candidate_ready'] and not saved['confirmed'] and saved['state']=='review_required'
    assert any(c['cell']=='/cameras/A/clip_raw' and c['raw']=='0003' for c in saved['raw_cells'])
    assert store.ingest(body([raw],1))['import_status']=='already_imported' and store.snapshot()['revision']==1
    with pytest.raises(IntervalConflict):store.ingest(body([raw],0))
    other=store.ingest(body([row(notes_raw='修订')],1))
    assert len(other['documents'])==2 and other['rows'][0]['raw_row']==raw


def test_blank_arrows_strikeout_ditto_never_auto_inherit(tmp_path):
    raws=[row(),row(pdf_page=2,row_index=1,scene_raw=''),row(row_index=2,scene_raw='↓'),row(row_index=3,notes_raw='划除 003'),row(row_index=4,scene_raw='同上')]
    rows=PaperIntakeStore(tmp_path,'p').ingest(body(raws))['rows']
    assert rows[0]['candidate_ready']
    assert all(not r['candidate_ready'] for r in rows[1:])
    assert rows[1]['normalized_fields']['scene']=='' and rows[2]['raw_row']['scene_raw']=='↓'


def test_558_synthetic_rows_supported_and_duplicate_locator_rejected(tmp_path):
    store=PaperIntakeStore(tmp_path,'p')
    rows=[row(pdf_page=i//21+1,row_index=i%21+1) for i in range(558)]
    assert len(store.ingest(body(rows))['rows'])==558
    with pytest.raises(ValueError,match='duplicate'):PaperIntakeStore(tmp_path/'other','p').ingest(body([row(),row()]))


def test_paper_source_intervals_separate_not_whole_clip(tmp_path,monkeypatch):
    _,t,interval,source,board=setup(tmp_path,monkeypatch);config=SimpleNamespace(output_dir=interval.path.parent)
    paper=PaperIntakeStore(config.output_dir,'p');imported=paper.ingest(body([row()]))
    target={k:v for k,v in t.items() if k not in ('record_id','expected_board_revision')}
    target.update(paper_row_id=imported['rows'][0]['paper_row_id'],expected_paper_revision=1)
    before=board.load()
    def execute(value):return prepare_selected(config,'w','p',value,DeviceMediaStore(),tmp_path/'device',probe=lambda _:pytest.fail('cached'))
    assert execute(target)['status']=='proposal_prepared'
    assert execute({**target,'source_start_frame':30,'source_end_frame':40,'expected_interval_revision':1})['status']=='proposal_prepared'
    rows=interval.read_model()['candidates'];assert len(rows)==2
    assert all(r['provenance']['origin']=='imported_paper_transcription' and r['raw_cells']['raw_row']['take_raw']=='003' for r in rows)
    assert not interval.read_model()['confirmed_intervals'] and board.load()==before
    with pytest.raises(IntervalConflict):execute({**target,'expected_paper_revision':0})


def test_real_http_import_read_and_durable_prepare(tmp_path,monkeypatch):
    from script_organizer import web_server
    from script_organizer.script_supervisor_runtime import install_script_supervisor_runtime
    install_script_supervisor_runtime()
    WorkspaceService=web_server.WorkspaceService;make_handler=web_server.make_handler
    from script_organizer.workspace import WorkspaceConfig
    _,t,interval,source,_=setup(tmp_path,monkeypatch)
    service=WorkspaceService(WorkspaceConfig.from_file(tmp_path/'workspace.toml'))
    server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(service,tmp_path));thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    def request(path,data=None):
        req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/api/v1/projects/p/'+path,data=json.dumps(data).encode() if data else None,headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=5) as response:return json.load(response)
    try:
        assert request('script-supervisor-paper')['revision']==0
        imported=request('script-supervisor-parse',body([row()]))
        assert request('script-supervisor-paper')['rows']==imported['rows']
        target={k:v for k,v in t.items() if k not in ('record_id','expected_board_revision')}
        target.update(paper_row_id=imported['rows'][0]['paper_row_id'],expected_paper_revision=1)
        task=request('tasks',{'type':'scene_interval_prepare','targets':target})
        for _ in range(100):
            current=service.tasks.list('p')[0]
            if current['status'] in ('completed','failed'):break
            time.sleep(.02)
        assert current['status']=='completed',current
        assert current['result']['status']=='proposal_prepared'
        assert interval.read_model()['candidates'][0]['scene']=='003'
    finally:server.shutdown();server.server_close();thread.join()


def test_canonical_retry_and_same_source_raw_cell_change_conflict(tmp_path):
    store=PaperIntakeStore(tmp_path,'p')
    document={'source_pdf':{'sha256':'a'*64},'page_context':{'1':{'header_raw':'003'}},'rows':[row()]}
    request=body(document);first=store.ingest(request)
    changed_format={**request,'content':json.dumps(document,indent=2),'expected_revision':1}
    assert store.ingest(changed_format)['import_status']=='already_imported'
    assert first['documents'][0]['source_document_digest_verification']=='supplied_unverified'
    document['rows'][0]['take_raw']='004'
    with pytest.raises(IntervalConflict):store.ingest(body(document,1))
    assert store.snapshot()['revision']==1
    assert store.read_model()['rows'][0]['raw_row']['take_raw']=='003'


def test_restart_empty_project_corruption_fail_closed(tmp_path):
    store=PaperIntakeStore(tmp_path,'p');assert store.read_model()['rows']==[]
    store.ingest(body([row()]))
    assert PaperIntakeStore(tmp_path,'p').read_model()==store.read_model()
    before=store.path.read_bytes();store.read_model();assert store.path.read_bytes()==before
    store.path.write_text('{bad',encoding='utf-8')
    with pytest.raises(ValueError):store.read_model()


def test_concurrent_same_revision_one_commit(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    store=PaperIntakeStore(tmp_path,'p')
    def run(_):
        try:return store.ingest(body([row()]))['import_status']
        except IntervalConflict:return 'conflict'
    with ThreadPoolExecutor(max_workers=2) as pool:assert sorted(pool.map(run,range(2)))==['conflict','imported']
    assert store.snapshot()['revision']==1


def test_unrelated_import_does_not_break_same_interval_retry(tmp_path,monkeypatch):
    _,t,interval,_,_=setup(tmp_path,monkeypatch);config=SimpleNamespace(output_dir=interval.path.parent)
    store=PaperIntakeStore(config.output_dir,'p');first=store.ingest(body([row()]))
    target={k:v for k,v in t.items() if k not in ('record_id','expected_board_revision')}
    target.update(paper_row_id=first['rows'][0]['paper_row_id'],expected_paper_revision=1)
    run=lambda targets:prepare_selected(config,'w','p',targets,DeviceMediaStore(),tmp_path/'device',probe=lambda _:pytest.fail('cached'))
    run(target);before=interval.snapshot()
    store.ingest(body([row(pdf_page=2)],1))
    assert run({**target,'expected_paper_revision':2,'expected_interval_revision':1})['status']=='already_prepared'
    assert interval.snapshot()==before

@pytest.mark.parametrize('change',['scene','ready','raw','digest'])
def test_valid_json_paper_corruption_fails_closed(tmp_path,change):
    store=PaperIntakeStore(tmp_path,'p');store.ingest(body([row()]))
    data=store.snapshot();record=next(iter(data['rows'].values()))
    if change=='scene':record['normalized_fields']['scene']='wrong'
    elif change=='ready':record['candidate_ready']=False
    elif change=='raw':record['raw_row']['take_raw']='004'
    else:record['row_digest']='0'*64
    store.path.write_text(json.dumps(data),encoding='utf-8')
    with pytest.raises(ValueError):store.read_model()

@pytest.mark.parametrize('content', ['[{"page":"1","page":"2","row":"1"}]', '[{"page":{},"row":"1"}]', '[{"page":true,"row":"1"}]'])
def test_malformed_json_source_cells_rejected_without_write(tmp_path,content):
    store=PaperIntakeStore(tmp_path,'p');request=body([]);request['content']=content
    with pytest.raises(ValueError):store.ingest(request)
    assert not store.path.exists()


def test_document_quota_leaves_previous_store_unchanged(tmp_path):
    store=PaperIntakeStore(tmp_path,'p')
    for i in range(100):store.ingest(body([row(pdf_page=i+1)],i))
    before=store.path.read_bytes()
    with pytest.raises(ValueError,match='quota'):store.ingest(body([row(pdf_page=101)],100))
    assert store.path.read_bytes()==before

@pytest.mark.parametrize('date',[None,123,'↑','同上','重叠日期',''])
def test_date_representation_never_gates_explicit_scene_candidate(tmp_path,date):
    result=PaperIntakeStore(tmp_path,'p').ingest(body([row(date_raw=date)]))
    assert result['rows'][0]['candidate_ready']
    assert result['rows'][0]['raw_row']['date_raw']==date
