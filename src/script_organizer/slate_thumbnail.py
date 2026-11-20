"""Bounded registered-source stills, never playback, scan, or export authority."""
import base64
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
try:
    import fcntl
except ImportError:
    fcntl=None

from .paper_filename_context import _bindings
from .source_descriptor_receipt import _digest,_sampled_id,_stat
from .scene_interval_store import IntervalConflict

ACTION_FIELDS={'expected_scope','expected_index_sha256','group_id','clip_id','media_id','camera','request_id'}
POLICY='first-visible-frame-in-initial-second.v1'
LIMIT=150_000
MAX_COUNT=96
MAX_CACHE_BYTES=9_000_000

@contextmanager
def _lock(path,blocking=False):
    if fcntl is None:raise ValueError('thumbnail_platform_unavailable')
    with path.open('a+b') as fd:
        try:fcntl.flock(fd.fileno(),fcntl.LOCK_EX|(0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            yield False;return
        try:yield True
        finally:fcntl.flock(fd.fileno(),fcntl.LOCK_UN)

@contextmanager
def _slot(root):
    for i in range(2):
        with _lock(root/f'slot-{i}.lock') as available:
            if available:
                yield
                return
    raise ValueError('thumbnail_busy')

def _selected(index, request):
    groups=[g for g in index.get('groups',[]) if g.get('group_id')==request['group_id'] and g.get('kind')=='multicam']
    clips=[c for c in index.get('clips',[]) if c.get('clip_id')==request['clip_id']]
    if len(groups)!=1 or len(clips)!=1:raise IntervalConflict('thumbnail_occurrence_changed')
    clip=clips[0]
    same=lambda item:all(item.get(k)==request[k] for k in ('camera','clip_id','media_id'))
    if not same(clip) or sum(same(m) for m in groups[0].get('members',[]))!=1:
        raise IntervalConflict('thumbnail_occurrence_changed')

def _ffmpeg(path):
    ffmpeg=os.environ.get('MIRRORORDER_SLATE_THUMBNAIL_FFMPEG')
    if not ffmpeg or not Path(ffmpeg).is_absolute() or not Path(ffmpeg).is_file():
        raise ValueError('packaged_thumbnail_encoder_missing')
    # MOV demuxer covers registered MP4/MOV. Network, playlist, audio,
    # and attachment/secondary streams never enter the chosen pipeline.
    cmd=[ffmpeg,'-nostdin','-hide_banner','-v','error','-filter_threads','1','-threads','1',
         '-protocol_whitelist','file','-f','mov','-t','1.0','-i',str(path),
         '-map','0:v:0','-an','-sn','-dn','-vf',
         "blackframe=amount=0:threshold=26,metadata=mode=select:key=lavfi.blackframe.pblack:value=97:function=less,scale=192:108:force_original_aspect_ratio=decrease:force_divisible_by=2",
         '-frames:v','1','-c:v','mjpeg','-threads','1','-q:v','5','-f','image2pipe','pipe:1']
    # Capture no stderr. stdout is exactly one scaled JPEG. Timeout reaps
    # even expensive media. The native parent also owns the process group.
    p=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=4,check=True)
    return p.stdout

def _jpeg(data):
    return 25<len(data)<=LIMIT and data[:2]==b'\xff\xd8' and data[-2:]==b'\xff\xd9'

def _load(path):
    try:
        if not stat.S_ISREG(path.lstat().st_mode):return None
        with path.open('rb') as f:data=f.read(LIMIT+1)
        if _jpeg(data):
            os.utime(path,None,follow_symlinks=False)
            return data
    except OSError:pass
    return None

def _publish(root,key,data):
    with _lock(root/'cache.lock',blocking=True):
        fd,temporary=tempfile.mkstemp(dir=root,prefix='.candidate-')
        try:
            with os.fdopen(fd,'wb') as f:f.write(data)
            os.replace(temporary,root/f'{key}.jpg')
        finally:
            if os.path.exists(temporary):os.unlink(temporary)
        files=[]
        for p in root.glob('*.jpg'):
            try:
                s=p.lstat()
                if stat.S_ISREG(s.st_mode):files.append((s.st_mtime_ns,s.st_size,p))
            except FileNotFoundError:continue
        used=0
        for i,(_,size,p) in enumerate(sorted(files,reverse=True)):
            used+=size
            if i>=MAX_COUNT or used>MAX_CACHE_BYTES:
                p.unlink(missing_ok=True)

def prepare(index,request,store,workspace,project,device_dir,*,encode=_ffmpeg):
    if (request['camera'] not in ('A','B','C') or
        not all(isinstance(request[k],str) and 1<=len(request[k])<=256 for k in ('group_id','clip_id','media_id','request_id')) or
        not re.fullmatch(r'M_[0-9a-f]{24}',request['media_id']) or not re.fullmatch(r'[0-9a-f]{32}',request['request_id'])):
        raise ValueError('invalid_thumbnail_target')
    _selected(index,request)
    mid=request['media_id'];lookup=lambda:_bindings(store,workspace,project).get(mid)
    bound=lookup()
    if not isinstance(bound,str) or not Path(bound).is_absolute():
        raise ValueError('registered_media_required')
    root=Path(device_dir)/'slate-thumbnails.v1'
    root.mkdir(mode=0o700,parents=True,exist_ok=True)
    with _slot(root):
        path=Path(bound).resolve(strict=True)
        if not path.is_file() or path.suffix.lower() not in {'.mov','.mp4','.m4v'}:
            raise ValueError('thumbnail_source_not_supported')
        before=_stat(path)
        key=_digest([workspace,project,mid,str(path),before,POLICY,192,108])
        data=_load(root/f'{key}.jpg')
        from_cache=data is not None
        if not data:
            if _sampled_id(path)!=mid:raise IntervalConflict('thumbnail_media_identity_changed')
            data=encode(path)
            if not _jpeg(data):raise ValueError('no_near_start_non_black_frame')
        if lookup()!=bound or Path(bound).resolve(strict=True)!=path or _stat(path)!=before:
            raise IntervalConflict('thumbnail_source_changed')
        if not from_cache:_publish(root,key,data)
        return {'contract':'mirrororder.slate_thumbnail.v1','workspace_scope':request['expected_scope'],
                'request_id':request['request_id'],'target':{k:request[k] for k in ('group_id','clip_id','media_id','camera')},
                'policy':POLICY,'cache_hit':from_cache,'mime':'image/jpeg','jpeg':base64.b64encode(data).decode('ascii')}
