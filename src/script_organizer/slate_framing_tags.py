"""Editor framing annotations in a project-local sidecar, not media truth."""
from pathlib import Path
import re
import unicodedata

from .paper_nested_camera import require_cell
from .scene_interval_store import SceneIntervalStore, IntervalConflict
from .source_descriptor_receipt import _digest

PRESETS=('远景','全景','中景','近景','特写')
READ={'expected_scope','expected_paper_revision'}
WRITE=READ|{'expected_tag_revision','paper_row_id','row_digest','camera','tag','add_custom'}
SHA=re.compile(r'[0-9a-f]{64}')
LABEL=re.compile(r'[\w\u3400-\u9fff][\w\u3400-\u9fff +·–-]{0,23}', re.UNICODE)


class FramingStore(SceneIntervalStore):
    def __init__(self,out,project):
        super().__init__(out,project)
        self.path=Path(out)/'electronic_framing_tags.json'


def _model(snapshot, state, scope):
    rows=snapshot['rows']
    tags=[]
    for item in state['intervals'].values():
        original=rows.get(item['paper_row_id'])
        if original and original['row_digest']==item['row_digest']:
            tags.append({key:item[key] for key in ('paper_row_id','row_digest','camera','tag')})
    return {'contract':'mirrororder.framing_tags.v1','workspace_scope':scope,'paper_revision':snapshot['revision'],
            'revision':state['revision'],'catalog':list(PRESETS)+state.get('custom_tags',[]),'tags':tags}


def framing(paper, store, request, scope, *, write=False):
    revision=request['expected_paper_revision']
    if type(revision) is not int or revision<0:raise ValueError('invalid_framing_paper_revision')
    if not write:
        snapshot=paper.snapshot()
        if snapshot['revision']!=revision:raise IntervalConflict('framing_paper_changed')
        return _model(snapshot,store.snapshot(),scope)
    rid=request['paper_row_id']; digest=request['row_digest']; camera=request['camera']; tag=request['tag']
    if not isinstance(rid,str) or not re.fullmatch(r'paper-row-[0-9a-f]{64}',rid) or not isinstance(digest,str) or not SHA.fullmatch(digest):
        raise ValueError('invalid_framing_row')
    if camera not in ('A','B','C') or not isinstance(tag,str) or tag!=tag.strip() or not LABEL.fullmatch(tag) or type(request['add_custom']) is not bool:
        raise ValueError('invalid_framing_tag')
    with paper._transaction(revision) as snapshot, store._transaction(request['expected_tag_revision']) as state:
        source=snapshot['rows'].get(rid)
        if not source:raise IntervalConflict('framing_row_changed')
        # A framing label is scoped to the exact electronic row/camera cell:
        # this proves a literal source cell; it says nothing about which real
        # camera-card clip was filmed or whether the label is historical truth.
        cell=require_cell(source,camera,digest)
        slot=_digest([cell['original_document_digest'],rid,digest,cell['raw_cell']])
        custom=state.setdefault('custom_tags',[])
        if tag not in PRESETS and tag not in custom:
            normalized=lambda value:unicodedata.normalize('NFKC',value).casefold()
            if not request['add_custom'] or len(custom)>=48 or normalized(tag) in {normalized(t) for t in [*PRESETS,*custom]}:
                raise ValueError('custom_framing_not_in_catalog')
            custom.append(tag)
        record={'paper_row_id':rid,'row_digest':digest,'camera':camera,'tag':tag}
        previous=state['intervals'].get(slot)
        if previous!=record:
            state['intervals'][slot]=record
            state['events'].append({'version':state['revision']+1,'new':record,'previous':previous})
            store._commit(state)
        return _model(snapshot,state,scope)
