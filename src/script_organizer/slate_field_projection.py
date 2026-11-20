"""Read-only paper suggestions. Caller supplies trusted current local data."""
from collections import Counter
from hashlib import sha256
import json
import re
from .slate_candidate_rules import literal_fields

CONTRACT='mirrororder.paper_field_suggestions.v1'
FIELDS=('scene','shot','take')
SHA=re.compile(r'[a-f0-9]{64}')

def digest(value):
    return sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()

def group_anchor(group):
    return digest(group['members'])

def project(bundle, *, scope, pdf_sha, page_count, paper_rows, index, sync_report, visible_ids, manual):
    """manual[group_id][field] = value; explicit clear is a present None.
    Never accepts any authoritative changes; markers/Resolve have no caller.
    """
    out={'contract':CONTRACT,'state':'stale','groups':{},'editorial_authority':False}
    header={ 'scope':scope, 'pdf_sha256':pdf_sha, 'pages':page_count,
             'paper_rows_sha256':digest(paper_rows), 'index_sha256':digest(index),
             'sync_sha256':digest(sync_report) }
    if bundle.get('contract')!=CONTRACT or not scope or not SHA.fullmatch(pdf_sha or '') or header!=bundle.get('header'):
        return out
    source={(row['pdf_page'],row['row_index']):row for row in paper_rows}
    groups={g['group_id']:g for g in index['groups']}
    if len(source)!=len(paper_rows) or len(groups)!=len(index['groups']):
        return out
    entries=bundle['entries']
    counts=Counter(e['group_id'] for e in entries)
    loc_counts=Counter(tuple(e['locator']) for e in entries)
    out['state']='current'
    for e in entries:
        gid=e['group_id']; loc=tuple(e['locator']); row=source.get(loc)
        if gid not in visible_ids or gid not in groups or not row or not 1<=loc[0]<=page_count or loc[1]<1:
            continue
        if counts[gid]!=1 or loc_counts[loc]!=1:
            out['groups'][gid]={'state':'conflict','fields':{}}
            continue
        if e['source_anchor']!=group_anchor(groups[gid]) or e['row_sha256']!=digest(row):
            continue
        states={}
        literals=literal_fields(row)
        for field in FIELDS:
            value=e['fields'].get(field)
            if value is None or value!=literals.get(field):
                continue
            fixed=manual.get(gid,{})
            if field in fixed:
                if fixed[field] is not None and fixed[field]!=value:
                    states[field]={'state':'conflict','paper_value':value}
                continue
            states[field]={'state':'suggested','value':value}
        if states or not literals:
            out['groups'][gid]={'state':'paper_suggestion' if states else 'source_only','fields':states,
                'source':{'pdf_sha256':pdf_sha,'pdf_page':loc[0],'row_index':loc[1]},
                'source_interval_verified':False,'human_confirmed':False}
    return out
