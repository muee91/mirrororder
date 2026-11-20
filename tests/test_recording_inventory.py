import json
import shutil
import subprocess
import wave
from pathlib import Path

import pytest
from script_organizer.recording_inventory import discover_recordings, recording_diagnostics
from script_organizer.media_identity import media_id_for_path
from script_organizer.config import ProjectConfig
from script_organizer.multicam_sync_engine import run_multicam_sync


def wav(path, value=1):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(48000)
        f.writeframes(bytes([value,0])*4800)


def test_multiple_roots_idempotent_and_exclusions(tmp_path):
    a,b=tmp_path/'a',tmp_path/'b'
    wav(a/'original.wav'); wav(b/'other.wav',2)
    wav(b/'Corrected Audio'/'render.wav',3)
    wav(a/'交付'/'export.wav',4)
    def scan():return discover_recordings((a,b,a),output=tmp_path/'out',roles={},check_cancelled=lambda:None)
    first=scan()
    assert first==scan()
    assert len(first['candidates'])==2 and first['derived_candidates_excluded']==1
    assert all(r['source_kind']=='unverified' for r in first['candidates'])
    assert str(tmp_path) not in json.dumps(first)
    excluded=discover_recordings((a,),output=tmp_path/'out',roles={media_id_for_path(a/'original.wav'):{'sync_policy':'exclude'}},check_cancelled=lambda:None)
    assert excluded['candidates']==[] and excluded['explicitly_excluded']==1


def test_unknown_not_no_recordings_and_missing_root(tmp_path):
    empty=discover_recordings((tmp_path,),output=tmp_path/'out',roles={},check_cancelled=lambda:None)
    assert recording_diagnostics(empty)[0]['code']=='recording_roster_unknown'
    missing=discover_recordings((tmp_path/'missing',),output=tmp_path/'out',roles={},check_cancelled=lambda:None)
    assert missing['unreadable_entries']==1


def test_actual_sync_pipeline_preserves_old_revision_and_discovers_wav(tmp_path, monkeypatch):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('real media tools required')
    monkeypatch.setenv('MIRRORORDER_DEVICE_STATE_DIR',str(tmp_path/'device'))
    root=tmp_path/'media'
    for camera in 'AB':
        folder=root/'day1'/camera;folder.mkdir(parents=True)
        subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i',f'color=c={"red" if camera == "A" else "blue"}:size=64x64:rate=25',
            '-f','lavfi','-i','anoisesrc=seed=12:sample_rate=48000','-t','35','-c:v','libx264',
            '-preset','ultrafast','-c:a','aac',str(folder/f'{camera}001.mp4')],check=True)
    wav(root/'recording'/'original.wav')
    config=ProjectConfig(config_path=tmp_path/'project.toml',name='synthetic',fcpxml=None,
        script=tmp_path/'does-not-exist.txt',output_dir=tmp_path/'out',transcript_dir=tmp_path/'transcripts',
        input_kind='media-directory',media_root=root)
    report_path=config.output_dir/'sync'/'sync_report.json';report_path.parent.mkdir(parents=True)
    old={'status':'confirmed','sync_task_id':'previous-revision','placements':[{'media_id':'M_prior','source':11}]}
    report_path.write_text(json.dumps({'recording_alignment':old}))
    first=run_multicam_sync(config)
    assert first['recording_alignment']==old
    assert len(first['recording_inventory']['candidates'])==1
    assert first['diagnostics'][0]['code']=='existing_recording_authority_preserved'
    second=run_multicam_sync(config)
    assert second['recording_inventory']==first['recording_inventory']
    assert second['recording_alignment']==old
    assert json.loads(report_path.read_text())['recording_alignment']==old
    assert not config.script.exists()
    # Prove the automatic route on matched original PCM, without hand-authored evidence.
    report_path.write_text('{}')
    recording=root/'recording'/'original.wav'
    subprocess.run(['ffmpeg','-y','-v','error','-f','lavfi','-i',
        'anoisesrc=seed=12:sample_rate=48000','-ss','4','-t','20','-c:a','pcm_s16le',str(recording)],check=True)
    aligned=run_multicam_sync(config,sync_context=('ws','project','revision-1'))
    assert aligned['diagnostics'][0]['code']=='waveform_alignment_completed', aligned['diagnostics']
    placement=aligned['recording_alignment']['placements'][0]
    assert placement['at']==100 and placement['source']==0 and placement['frames']==500
    assert placement['source_kind']=='original'
    repeated=run_multicam_sync(config,sync_context=('ws','project','revision-2'))
    assert repeated['recording_alignment']['placements']==aligned['recording_alignment']['placements']
    assert repeated['recording_alignment']['sync_task_id']=='revision-2'
    # Standard Host TaskManager entrypoint (existing project with a real script).
    config.script.write_text('第一集\n1-1 日 外 公园\n人物：甲\n甲：测试对白。\n')
    from script_organizer.tasks import TaskManager
    from script_organizer.nle_delivery.resolve_plan import build_resolve_plan
    from script_organizer.media_identity import DeviceMediaStore
    from types import SimpleNamespace
    import time
    manager=TaskManager(lambda _:config,workspace_id='ws')
    task=manager.submit('project','multicam_sync',idempotency_key='automatic-original-wav')
    deadline=time.monotonic()+90
    while time.monotonic()<deadline:
        state=next(item for item in manager.list('project') if item['task_id']==task['task_id'])
        if state['status'] not in ('queued','running'):break
        time.sleep(.1)
    assert state['status']=='completed',state.get('error')
    stored=json.loads(report_path.read_text())['recording_alignment']
    assert stored['sync_task_id']==task['task_id']
    assert stored['placements']==repeated['recording_alignment']['placements']
    project=SimpleNamespace(config=config,workspace_id='ws',project_id='project')
    plan=build_resolve_plan(project,manager.list('project'),DeviceMediaStore(),lambda:False)
    assert plan['recordings'] and plan['recordings'][0]['source_kind']=='original'
    assert Path(plan['recordings'][0]['path'])==recording




def test_invalid_wav_and_cancellation(tmp_path):
    (tmp_path/'invalid.wav').write_bytes(b'not audio')
    result=discover_recordings((tmp_path,),output=tmp_path/'out',roles={},check_cancelled=lambda:None)
    assert result['candidates'][0]['status']=='unsupported_or_unreadable_audio'
    def cancel():raise RuntimeError('cancelled')
    with pytest.raises(RuntimeError,match='cancelled'):
        discover_recordings((tmp_path,),output=tmp_path/'out',roles={},check_cancelled=cancel)


def test_actual_long_original_across_staggered_camera_clips(tmp_path, monkeypatch):
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('real media tools required')
    monkeypatch.setenv('MIRRORORDER_DEVICE_STATE_DIR',str(tmp_path/'device'))
    root=tmp_path/'media'
    for camera in 'AB':
        folder=root/'day1'/camera;folder.mkdir(parents=True)
        for number,start in enumerate((0,30,70,100,130),1):
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i',
                f'color=c={"red" if camera=="A" else "blue"}:size=64x64:rate=25',
                '-f','lavfi','-i','anoisesrc=seed=23:sample_rate=48000','-ss',str(start),'-t','30',
                '-c:v','libx264','-preset','ultrafast','-c:a','aac','-timecode',f'00:{start//60:02d}:{start%60:02d}:00',
                str(folder/f'{camera}001C{number:03d}.mp4')],check=True)
    recording=root/'recording'/'original.wav';recording.parent.mkdir()
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','anoisesrc=seed=23:sample_rate=48000',
        '-ss','4','-t','140','-c:a','pcm_s16le',str(recording)],check=True)
    config=ProjectConfig(config_path=tmp_path/'project.toml',name='long-synthetic',fcpxml=None,
        script=tmp_path/'no-script',output_dir=tmp_path/'out',transcript_dir=tmp_path/'transcripts',
        input_kind='media-directory',media_root=root)
    result=run_multicam_sync(config,compress_gaps=False,sync_context=('ws','p','long-r1'))
    assert result['diagnostics'][0]['code']=='waveform_alignment_completed',result['diagnostics']
    placement=result['recording_alignment']['placements'][0]
    assert placement['at']==100 and placement['source']==0 and placement['frames']==3500
    assert result['recording_alignment']['evidence'][0]['waveform']['anchor_count']==5
    # Real common-gap compression changes projection, not physical evidence.
    compressed=run_multicam_sync(config,compress_gaps=True,sync_context=('ws','p','long-r2'))
    assert compressed['diagnostics'][0]['code']=='crosses_deleted_common_gap'
    assert compressed['recording_alignment']==result['recording_alignment']
    from script_organizer.media_identity import DeviceMediaStore
    assert DeviceMediaStore().resolve('ws','p',{'media_id':placement['media_id']})==str(recording)
