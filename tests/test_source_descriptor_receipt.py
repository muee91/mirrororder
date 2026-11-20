from copy import deepcopy
import json
from pathlib import Path
import pytest
from script_organizer.source_descriptor_receipt import produce_receipt,validate_packet_descriptor,_sampled_id

class Store:
    def __init__(self,mid,path):self.data={'workspaces':{'w':{'projects':{'p':{'bindings':{mid:str(path)}}}}}}
    def load(self):return deepcopy(self.data)

def payload(count=3):
    return {'streams':[{'codec_name':'h264','nb_frames':str(count),'r_frame_rate':'50/1','avg_frame_rate':'50/1','time_base':'1/1000'}],
            'packets':[{'pts':i*20,'duration':20} for i in range(count)]}

def setup(tmp_path):
    file=tmp_path/'synthetic.mov';file.write_bytes(b'fake container bytes');mid=_sampled_id(file)
    return file,mid,Store(mid,file)

def test_registered_identity_bounded_descriptor_and_no_path_leak(tmp_path):
    file,mid,store=setup(tmp_path)
    result=produce_receipt(store,'w','p',mid,probe=lambda _:payload())
    public=result['public']
    assert public['status']=='verified' and public['frame_count']==3
    assert not public['whole_file_sha256_verified']
    assert str(tmp_path) not in json.dumps(result)
    assert public['allowed_adapters']==['resolve-21.2-source-marker-zero-based-v1']

def test_cache_avoids_probe_and_changed_source_cannot_reuse(tmp_path):
    file,mid,store=setup(tmp_path);result=produce_receipt(store,'w','p',mid,probe=lambda _:payload())
    def forbidden(_):pytest.fail('cache should not probe')
    assert produce_receipt(store,'w','p',mid,probe=forbidden,cached=result)['cache_hit']
    file.write_bytes(b'replacement bytes')
    assert produce_receipt(store,'w','p',mid,probe=forbidden,cached=result)['public']['status']=='unknown'

def test_no_original_path_or_other_project_fallback(tmp_path):
    file,mid,store=setup(tmp_path)
    assert produce_receipt(store,'other','p',mid,probe=lambda _:payload())['public']['status']=='unknown'
    assert produce_receipt(store,'w','unknown',mid,probe=lambda _:payload())['public']['status']=='unknown'

def test_mutation_during_probe_rejected(tmp_path):
    file,mid,store=setup(tmp_path)
    def changing(_):file.write_bytes(b'changed');return payload()
    assert produce_receipt(store,'w','p',mid,probe=changing)['public']['reason']=='source_changed_during_probe'

@pytest.mark.parametrize('change', ['count','vfr','timestamps','budget','missing','rate'])
def test_incomplete_vfr_or_overbudget_never_assumed_exact(change):
    p=payload()
    if change=='count':p['packets'].pop()
    elif change=='vfr':p['packets'][1]['duration']=21
    elif change=='timestamps':p['packets'][1]['pts']=22
    elif change=='budget':p['streams'][0]['nb_frames']='30001'
    elif change=='missing':del p['streams'][0]['nb_frames']
    elif change=='rate':p['streams'][0]['avg_frame_rate']='49/1'
    with pytest.raises((ValueError,KeyError)):validate_packet_descriptor(p)

def test_b_frame_decode_order_can_be_reordered_to_exact_presentation_grid():
    p=payload();p['packets']=list(reversed(p['packets']))
    assert validate_packet_descriptor(p)['frame_count']==3


def test_nonzero_pts_origin_not_guessed_as_resolve_frame_zero():
    p=payload()
    for packet in p['packets']:packet['pts']+=100
    with pytest.raises(ValueError,match='origin'):validate_packet_descriptor(p)
