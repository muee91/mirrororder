import json
from pathlib import Path
import subprocess
import sys
import os
import pytest
from script_organizer.electronic_source_triage import source_triage
from script_organizer.scene_interval_ipc import validate_request
from script_organizer.scene_interval_store import IntervalConflict
from script_organizer.scene_interval_plan import _digest

def clip(id, label, camera='A'):
    return {'clip_id':str(id),'media_id':'M_'+('%024x'%id),'name':label,'camera':camera}

def row(i, a='c006', b='bad', c=''):
    return {'paper_row_id':'paper-row-'+('%064x'%i),'row_digest':'%064x'%i,
            'raw_row':{'cameras':{k:{'clip_raw':v} for k,v in zip('ABC',[a,b,c])}}}

def fixture():
    one=clip(1,'A001C006_261110AM')
    two=clip(2,'A002C006_261110AM')
    c=clip(3,'C001C006_261110AM','C')
    index={"说明":"非 ASCII 索引要与场记板摘要一致", "clips":[one,two,c], 'groups':[{'members':[one]}]}
    rows=[row(i) for i in range(558)]
    return index,{'revision':2,'rows':{r['paper_row_id']:r for r in rows}}

def resolve(index,paper,bindings={},**options):
    return source_triage(paper,index,bindings,**({'scope':'s','expected_paper_revision':paper['revision'],'expected_index_sha256':_digest(index)}|options))

def test_558_rows_keep_collision_with_one_saved_identity(monkeypatch):
    index,paper=fixture()
    def forbidden(*a,**kw):raise AssertionError('triage may not stat or read media')
    monkeypatch.setattr(Path,'is_file',forbidden)
    monkeypatch.setattr(Path,'stat',forbidden)
    data=resolve(index,paper,{index['clips'][0]['media_id']:'/Volumes/NotRead/A001C006_261110AM.MP4'})
    assert len(data['rows'])==558
    assert len(json.dumps(data))<1_048_576
    assert data['rows'][0]['cells']==[
        {'camera':'A','tier':'multi_card','cards':[
            {'card':'A001','occurrence_count':1,'registered_count':1},
            {'card':'A002','occurrence_count':1,'registered_count':0}]},
        {'camera':'B','tier':'uncertain','cards':[]},
        {'camera':'C','tier':'empty','cards':[]}]
    assert data['rows'][87]['row_digest']==paper['rows'][data['rows'][87]['paper_row_id']]['row_digest']
    assert '/Volumes/' not in json.dumps(data) and 'confirmed' not in json.dumps(data)
    assert data==resolve(index,paper,{index['clips'][0]['media_id']:'/Volumes/StillNotRead/A001C006_261110AM.MP4'})

def test_exact_one_not_indexed_wrong_camera_and_same_card_collision():
    index,paper=fixture()
    item=next(iter(paper['rows'].values()))
    item['raw_row']['cameras']['C']['clip_raw']='c006'
    item['raw_row']['cameras']['B']['clip_raw']='c006'
    index['clips']=[index['clips'][0],index['clips'][2],clip(9,'A001C006_261110BB'),clip(10,'B001C006_261110BB','A')]
    result=resolve(index,paper)
    assert [(c['tier'], len(c['cards'])) for c in result['rows'][0]['cells']]==[('same_card_collision',1),('not_indexed',0),('single_indexed',1)]
    assert result['rows'][0]['cells'][2]['cards'][0]['registered_count']==0
    alt=clip(12,'A002C006_261110AM'); alt['media_path']='X:/A003C006_261110AM.MP4'
    result=resolve({'clips':[alt]},paper,{alt['media_id']:'/privacy/A002C006_261110AM.MP4'})
    assert result['rows'][0]['cells'][0]['tier']=='multi_card'
    assert all(c['registered_count']==0 for c in result['rows'][0]['cells'][0]['cards'])

def test_fences_and_exact_request():
    index,paper=fixture()
    for field,value in [('expected_paper_revision',1),('expected_index_sha256','0'*64)]:
        with pytest.raises(IntervalConflict):resolve(index,paper,**{field:value})
    with pytest.raises(ValueError):resolve(index,paper,expected_paper_revision=True)
    base={'action':'board_source_triage','project_id':'p','expected_scope':'f'*64,'expected_paper_revision':2,'expected_index_sha256':_digest(index)}
    validate_request(base)
    for field in ('path','automatic_bind','rows','clip_id','draft_id'):
        with pytest.raises(ValueError):validate_request(dict(base,**{field:'never'}))
