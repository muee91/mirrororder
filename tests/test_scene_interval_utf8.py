"""Regression under actual ASCII locale; no UTF-8 environment workaround."""
import json,os,subprocess,sys
from pathlib import Path


def test_ascii_worker_reads_writes_chinese_interval(tmp_path):
    source=Path(__file__).resolve().parents[1]
    program=r'''
import json,locale,os,sys
from pathlib import Path
from types import SimpleNamespace
from pytest import MonkeyPatch
from test_scene_interval_prepare import setup
from test_scene_interval_ipc import request_for
from script_organizer.scene_interval_prepare import prepare_selected,preparation_context
from script_organizer.scene_interval_store import SceneIntervalStore
from script_organizer.scene_interval_ipc import cached_descriptor_reader,prepared_read_model,dispatch,receipt_cache_path
from script_organizer.media_identity import DeviceMediaStore
assert sys.flags.utf8_mode==0
assert locale.getencoding().lower() in ('ansi_x3.4-1968','ascii','us-ascii')
base=Path(sys.argv[1]);mp=MonkeyPatch()
run,t,store,source,board=setup(base,mp)
row=board.load()['records']['r'];row.update(scene='\u7b2c\u4e00\u573a',note='\u5bfc\u6f14\u63d0\u793a\uff1a\u91cd\u6765\u4e00\u6b21')
board.apply_record({'record_id':'r','expected_revision':1,'actor':'qa','record':row})
t['expected_board_revision']=2
# Chinese paths survive in durable provenance without relying on locale encoding.
indexpath=base/'output'/'material_index.json'
index=json.loads(indexpath.read_text(encoding='utf-8'));index['source_label']='\u573a\u8bb0/\u539f\u7247.mov'
indexpath.write_text(json.dumps(index,ensure_ascii=False),encoding='utf-8')
from script_organizer.source_descriptor_receipt import _digest
t['expected_index_sha256']=_digest(index)
# Real non-ASCII filename. Under Linux ASCII filesystem codec use the OS's
# reversible surrogateescape path; macOS uses UTF-8 filesystem paths natively.
newpath=os.fsencode(source.parent)+b'/'+ '\u539f\u7247.mov'.encode('utf-8')
os.rename(os.fsencode(source),newpath);source=Path(os.fsdecode(newpath))
bindings=base/'device'/'media-bindings.json'
data=json.loads(bindings.read_text(encoding='utf-8'));data['workspaces']['w']['projects']['p']['bindings'][t['media_id']]=str(source)
bindings.write_text(json.dumps(data,ensure_ascii=True),encoding='utf-8')
from script_organizer.source_descriptor_receipt import produce_receipt
probe=lambda _: {'streams':[{'codec_name':'h264','nb_frames':'100','time_base':'1/50','r_frame_rate':'50/1','avg_frame_rate':'50/1'}],'packets':[{'pts':i,'duration':1} for i in range(100)]}
blob=produce_receipt(DeviceMediaStore(),'w','p',t['media_id'],probe=probe)
assert blob['public']['status']=='verified'
cache=receipt_cache_path(base/'device','w','p',t['media_id'])
blob['local_note']='\u539f\u7247/\u6d4b\u8bd5.mov'
cache.write_text(json.dumps(blob,ensure_ascii=False),encoding='utf-8')
assert preparation_context(SimpleNamespace(output_dir=base/'output'))['expected_index_sha256']==t['expected_index_sha256']
assert run()['status']=='proposal_prepared'
reader=cached_descriptor_reader(DeviceMediaStore(),'w','p',base/'device')
view=prepared_read_model(store,reader);dispatch(request_for(view),store,reader)
# A new subprocess must consume persisted Chinese JSON too.
env=dict(os.environ)
request=json.dumps({'action':'read','project_id':'p'})
import subprocess
response=subprocess.run([sys.executable,'-m','script_organizer.scene_interval_ipc','--workspace',str(base/'workspace.toml')],input=request,text=True,capture_output=True,env=env,timeout=8)
assert response.returncode==0,response.stderr
assert json.loads(response.stdout)['data']['confirmed_intervals'][0]['scene']==row['scene']
print(json.dumps({'status':'passed'},ensure_ascii=True))
'''
    env=dict(os.environ,LC_ALL='C',LANG='C',PYTHONUTF8='0',PYTHONCOERCECLOCALE='0',PYTHONIOENCODING='ascii',PYTHONPATH=os.pathsep.join([str(source/'src'),str(source/'tests')]),PYTHONDONTWRITEBYTECODE='1')
    result=subprocess.run([sys.executable,'-c',program,str(tmp_path)],env=env,capture_output=True,text=True,encoding='ascii',timeout=20)
    assert result.returncode==0,result.stderr
    assert json.loads(result.stdout)=={'status':'passed'}
