"""Explicit selected-media, bounded packet descriptor. Never a GET hook.

M_ is the project's sampled identity, not a whole-file cryptographic guarantee.
Only known project registered bindings are accepted; no filename/path fallback.
"""
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import subprocess

MAX_PACKETS=30000
SAMPLE_BYTES=1024*1024


def _digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def _stat(path):
    s=path.stat()
    return [s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns]


def _sampled_id(path):
    size=path.stat().st_size;h=hashlib.sha1();h.update(str(size).encode('ascii'))
    with path.open('rb') as f:
        h.update(f.read(SAMPLE_BYTES))
        if size>SAMPLE_BYTES:f.seek(max(0,size-SAMPLE_BYTES));h.update(f.read(SAMPLE_BYTES))
    return 'M_'+h.hexdigest()[:24]


def _probe(path):
    command=['ffprobe','-v','error','-select_streams','v:0','-read_intervals',f'%+#{MAX_PACKETS+1}',
             '-show_packets','-show_streams','-show_entries','stream=codec_name,nb_frames,time_base,r_frame_rate,avg_frame_rate:packet=pts,duration',
             '-of','json',str(path)]
    completed=subprocess.run(command,capture_output=True,timeout=20,check=True)
    if len(completed.stdout)>8*1024*1024:raise ValueError('probe_output_budget_exceeded')
    return json.loads(completed.stdout)


def validate_packet_descriptor(payload):
    """Reject unsupported/missing/partial/VFR; never derive Frames from seconds."""
    streams=payload.get('streams',[]);packets=payload.get('packets',[])
    if len(streams)!=1:raise ValueError('one_video_stream_required')
    stream=streams[0]
    if stream.get('codec_name') not in ('h264','hevc'):raise ValueError('unsupported_packet_frame_mapping')
    count=int(stream['nb_frames']);rate=Fraction(stream['r_frame_rate']);avg=Fraction(stream['avg_frame_rate']);tb=Fraction(stream['time_base'])
    if count<1 or count>MAX_PACKETS:raise ValueError('frame_budget_exceeded')
    if rate<=0 or rate!=avg or tb<=0:raise ValueError('unknown_or_variable_rate')
    if len(packets)!=count:raise ValueError('incomplete_packet_frame_count')
    step=1/rate
    stamps=sorted(Fraction(int(p['pts']))*tb for p in packets)
    if stamps[0]!=0:raise ValueError('nonzero_presentation_origin_requires_adapter_proof')
    if any(Fraction(int(p['duration']))*tb!=step for p in packets):raise ValueError('variable_packet_duration')
    if any(b-a!=step for a,b in zip(stamps,stamps[1:])):raise ValueError('nonuniform_presentation_timestamps')
    return {'fps':{'numerator':rate.numerator,'denominator':rate.denominator},'frame_count':count,
            'timing_evidence':'complete_h264_hevc_packet_pts_and_duration','source_origin':'first_presentation_frame'}


def produce_receipt(store,workspace_id,project_id,media_id,*,probe=_probe,cached=None):
    """Internal explicit task entry; trusted store only. No state mutation.

    cached is a previous device-local return, never client-submitted. Store the
    private cache separately from project evidence; publish public only.
    """
    result={'status':'unknown','media_id':media_id}
    try:
        root=store.load();project=root.get('workspaces',{}).get(workspace_id,{}).get('projects',{}).get(project_id,{})
        bound=project.get('bindings',{}).get(media_id)
        if not isinstance(media_id,str) or not media_id.startswith('M_') or not isinstance(bound,str) or not bound:raise ValueError('registered_project_binding_required')
        path=Path(bound).resolve(strict=True)
        if not path.is_file():raise ValueError('registered_regular_file_required')
        before=_stat(path)
        token=_digest({'workspace':workspace_id,'project':project_id,'media_id':media_id,'canonical_path':str(path),'stat':before})
        if cached and cached.get('private_token')==token and cached.get('public',{}).get('status')=='verified':
            latest=store.load().get('workspaces',{}).get(workspace_id,{}).get('projects',{}).get(project_id,{}).get('bindings',{}).get(media_id)
            if latest!=bound or Path(bound).resolve(strict=True)!=path or _stat(path)!=before:raise ValueError('binding_or_source_changed_during_cache_read')
            return {'public':dict(cached['public']),'private_token':token,'cache_hit':True}
        if _sampled_id(path)!=media_id:raise ValueError('project_sample_identity_mismatch')
        descriptor=validate_packet_descriptor(probe(path))
        if _stat(path)!=before:raise ValueError('source_changed_during_probe')
        latest=store.load().get('workspaces',{}).get(workspace_id,{}).get('projects',{}).get(project_id,{}).get('bindings',{}).get(media_id)
        if latest!=bound or Path(bound).resolve(strict=True)!=path:raise ValueError('binding_changed_during_probe')
        revision=_digest({'media_id':media_id,'size':before[2],**descriptor})
        result={'status':'verified','media_id':media_id,**descriptor,'asset_revision':revision,
                'descriptor_revision':_digest({'binding_stat_token':token,'asset_revision':revision}),
                'identity_assurance':'project_sampled_sha1_plus_stable_device_stat_not_full_file_hash',
                'allowed_adapters':['resolve-21.2-source-marker-zero-based-v1'] if descriptor['fps']=={'numerator':50,'denominator':1} else [],
                'whole_file_sha256_verified':False}
        return {'public':result,'private_token':token,'cache_hit':False}
    except Exception as error:
        # No local pathname or probe stderr leaks into public state.
        result['reason']=str(error) if isinstance(error,ValueError) and len(str(error))<100 and '/' not in str(error) else type(error).__name__
        return {'public':result,'private_token':None,'cache_hit':False}
