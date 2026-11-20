"""Private read-only publication of separately verified local paper suggestions."""
import json
from pathlib import Path
import re
import stat

from .slate_field_projection import CONTRACT, FIELDS, project
from .slate_sheet_first import pdf_browse_sources
from .script_supervisor_store import ScriptSupervisorStore


def read_suggestions(output, project_id, scope, paper, index, report, groups, device_dir, workspace_id):
    path = Path(output) / 'paper_field_suggestions.v1.json'
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 1_000_000:
            return None
        with path.open('rb') as stream:
            bundle = json.loads(stream.read(1_000_001))
        if bundle.get('workspace_scope') != scope or bundle.get('contract') != CONTRACT or len(bundle['entries']) > 1200:
            return None
        pdf = bundle['header']['pdf_sha256']
        if not isinstance(pdf, str) or not re.fullmatch(r'[a-f0-9]{64}', pdf):
            return None
        pages = pdf_browse_sources(device_dir, workspace_id, project_id).get(pdf)
        if not pages:
            return None
        snapshot = paper.read_model()
        docs = [d for d in snapshot['documents'] if d.get('source_document_digest_claim') == pdf]
        if len(docs) != 1:
            return None
        rows = [r for r in snapshot['rows'] if r['document_id'] == docs[0]['document_id']]
        # A current explicit value is never replaced or rendered as the draft.
        path2 = Path(output) / 'script_supervisor.json'
        if path2.exists():
            with path2.open('rb') as stream:
                if not isinstance(json.loads(stream.read(20_000_001)), dict):
                    return None
        manual = {}
        for row in ScriptSupervisorStore(output).load()['records'].values():
            gid = row.get('source_group_id')
            if not gid:
                continue
            for name, key in zip(FIELDS, ('scene','shot','take_number')):
                value = row.get(key)
                if value not in (None, ''):
                    manual.setdefault(gid, {})[name] = str(value)
            if row.get('script_scene_id'):
                manual.setdefault(gid, {}).setdefault('scene', '已有人工作业')
        result = project(bundle, scope=project_id, pdf_sha=pdf, page_count=pages,
                         paper_rows=[r['raw_row'] for r in rows], index=index,
                         sync_report=report, visible_ids={g['group_id'] for g in groups}, manual=manual)
        if result['state'] != 'current':
            return None
        ids = {(r['raw_row']['pdf_page'], r['raw_row']['row_index']): (r['paper_row_id'],r['row_digest']) for r in rows}
        published = {}
        for gid, item in result['groups'].items():
            src = item.get('source')
            if not src:
                continue
            rid, digest = ids[src['pdf_page'], src['row_index']]
            published[gid] = {**item, 'source': {**src, 'paper_row_id': rid, 'row_digest': digest}}
        return {'contract':CONTRACT, 'editorial_authority':False, 'paper_revision':snapshot['revision'], 'groups':published}
    except (OSError, ValueError, TypeError, AttributeError, KeyError, IndexError):
        return None
