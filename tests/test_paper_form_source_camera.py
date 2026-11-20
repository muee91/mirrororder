from copy import deepcopy
from script_organizer.electronic_source_context import BASIS
from script_organizer.scene_context_board import paper_source_camera

def example():
 d='a'*64; row='id'; clip='c1'; media='m1'
 source={'paper_row_id':row,'row_digest':d}
 return ({'paper_row_id':row,'clip_id':clip,'media_id':media,'provenance':{'row_digest':d},
   'source_context':{'kind':BASIS,'electronic_source_cell':{**source,'camera':'A','raw_cell':'/cameras/A/clip_raw'},
    'selection':{**source,'clip_id':clip,'media_id':media,'nested_camera':'A'}}},source)

def test_requires_all_exact_anchors_not_index_camera():
 interval,original=example()
 interval['camera']='B'
 assert paper_source_camera(interval,original)=='A'
 for keys,value in [
  (('source_context','kind'),'existing_legacy'),
  (('source_context','electronic_source_cell','raw_cell'),'/cameras/B/clip_raw'),
  (('source_context','electronic_source_cell','row_digest'),'x'),
  (('source_context','selection','nested_camera'),'B'),
  (('source_context','selection','media_id'),'different'),
  (('provenance','row_digest'),'x'),
  (('paper_row_id',),'different')]:
  copy=deepcopy(interval); field=copy
  for k in keys[:-1]:field=field[k]
  field[keys[-1]]=value
  assert paper_source_camera(copy,original) is None
 assert paper_source_camera(interval,{**original,'row_digest':'else'}) is None
