"""Paper-field annotations only: no interval approval, Resolve, or source rewrites."""
from pathlib import Path
import re
import json

from .scene_interval_store import SceneIntervalStore, IntervalConflict
from .slate_field_projection import digest, FIELDS, group_anchor

CONTRACT='mirrororder.paper_field_annotations.v1'
WRITE={'expected_scope','expected_index_sha256','group_id','field','expected_token','expected_revision','mode','value'}
PATTERN={'scene':r'[1-9][0-9]{0,5}-[1-9][0-9]{0,5}','shot':r'[0-9]{1,9}','take':r'[0-9]{1,9}'}

class PaperFieldStore(SceneIntervalStore):
    def __init__(self,out,project):
        super().__init__(out,project)
        self.path=Path(out)/'paper_field_annotations.json'

def contexts(scope,index,report,suggestions):
    if not suggestions:return {}
    index_sha=digest(index); sync_sha=digest(report)
    seen={}
    for group in index.get('groups',[]):
        gid=group.get('group_id')
        seen[gid]=None if gid in seen else group
    result={}
    for gid,item in suggestions['groups'].items():
        group=seen.get(gid)
        if not group or not item.get('source'):continue
        for field,reading in item.get('fields',{}).items():
            if field not in FIELDS or reading.get('state')!='suggested':continue
            # Includes the scoped raw-row digest, physical locator, exact
            # ordered member extents/source IDs, and both producer artifacts.
            token=digest([scope,gid,group_anchor(group),index_sha,sync_sha,item['source'],field,reading['value']])
            result[(gid,field)]={'token':token,'source':item['source'],'suggestion':reading['value']}
    return result

def project_fields(saved,eligible):
    answer={}
    for key in set(saved)|set(eligible):
        gid,field=key
        record=saved.get(key)
        current=eligible.get(key)
        if record and (not current or record.get('token')!=current['token']):
            read={'state':'needs_review'}
        elif record:
            read={'state':record['mode'],'value':record['value'],'revision':record['revision'],**current}
        else:
            read={'state':'suggested','revision':0,**current}
        answer.setdefault(gid,{})[field]=read
    return answer

def read_saved(store):
    data=store.snapshot()
    if not isinstance(data.get('events'),list):raise ValueError('invalid_field_audit')
    return {(r['group_id'],r['field']):r for r in data['intervals'].values()}

def write(store,request,current):
    gid,field,token,revision,mode,value=(request[k] for k in ('group_id','field','expected_token','expected_revision','mode','value'))
    if not isinstance(gid,str) or not 1<=len(gid)<=256 or field not in FIELDS or not isinstance(token,str) or not re.fullmatch('[a-f0-9]{64}',token) or type(revision) is not int or revision<0:
        raise ValueError('invalid_field_target')
    if mode not in ('adopt','manual','clear') or (mode=='manual' and (not isinstance(value,str) or not re.fullmatch(PATTERN[field],value))) or (mode!='manual' and value is not None):
        raise ValueError('invalid_field_value')
    key=(gid,field); sid=digest([gid,field])
    for _ in range(4):
        base=store.snapshot()
        try:
            with store._transaction(base['revision']) as data:
                latest=data['intervals'].get(sid)
                if (latest['revision'] if latest else 0)!=revision:raise IntervalConflict('paper_field_revision_changed')
                eligible=current().get(key)
                if not eligible or eligible['token']!=token or (latest and latest['token']!=token):
                    raise IntervalConflict('paper_field_needs_review')
                if mode=='adopt' and latest:raise IntervalConflict('paper_field_not_adoptable')
                if len(data['events'])>=6000:raise ValueError('paper_field_audit_limit')
                row={'group_id':gid,'field':field,'mode':mode,'value':eligible['suggestion'] if mode=='adopt' else value,
                     'revision':revision+1,'token':token,'source':eligible['source']}
                data['intervals'][sid]=row
                data['events'].append(row)
                store._commit(data)
            break
        except IntervalConflict as exc:
            if str(exc)!='store_revision_changed':raise
    else:raise IntervalConflict('paper_field_busy')
    # fresh-read fence: no certainty follows merely from an append succeeding.
    try:return project_fields(read_saved(store),current()).get(gid,{}).get(field,{'state':'needs_review'})
    except (ValueError,OSError,TypeError,KeyError):return {'state':'needs_review'}
