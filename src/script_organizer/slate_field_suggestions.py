"""Private read-only publication of separately verified local paper suggestions."""
import json
from pathlib import Path
import re
import stat

from .slate_candidate_rules import literal_fields
from .slate_field_projection import CONTRACT, FIELDS, digest, project
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


def _publish_algorithmic_result(result, rows, pdf):
    ids = {
        (row['raw_row']['pdf_page'], row['raw_row']['row_index']): (row['paper_row_id'], row['row_digest'])
        for row in rows
    }
    published = {}
    for group_id, item in result['groups'].items():
        source = item.get('source')
        if not source:
            continue
        row_id, row_digest = ids[source['pdf_page'], source['row_index']]
        published[group_id] = {
            **item,
            'source': {
                **source,
                'pdf_sha256': pdf,
                'paper_row_id': row_id,
                'row_digest': row_digest,
            },
        }
    return published


def _inherit_same_page_context(published, rows):
    by_locator = {
        (item['source']['pdf_page'], item['source']['row_index']): group_id
        for group_id, item in published.items()
    }
    current_scene, current_shot, previous_take = '', '', 0
    previous_page, previous_row = None, 0
    for record in sorted(rows, key=lambda item: (item['raw_row']['pdf_page'], item['raw_row']['row_index'])):
        row = record['raw_row']
        page, row_number = row['pdf_page'], row['row_index']
        if page != previous_page or row_number != previous_row + 1:
            current_scene, current_shot, previous_take = '', '', 0
        previous_page, previous_row = page, row_number

        written = literal_fields(row)
        raw_scene = str(row.get('scene_raw') or '').strip()
        raw_shot = str(row.get('shot_raw') or '').strip()
        raw_take = str(row.get('take_raw') or '').strip()
        if raw_scene:
            scene = written.get('scene', '')
            if scene != current_scene and not raw_scene.startswith('↓'):
                current_shot, previous_take = '', 0
            current_scene = scene

        take = int(written.get('take', '0'))
        inherited_shot, inherited_take = '', ''
        if raw_shot:
            current_shot, previous_take = written.get('shot', ''), take
        elif raw_take:
            if current_shot and previous_take and take == previous_take + 1:
                inherited_shot = current_shot
            else:
                current_shot = ''
            previous_take = take
        else:
            # The source locator refers to the explicitly written end of a
            # connected row. Never expand a range to the files in between.
            camera_codes = [str(camera.get('clip_raw') or '').strip()
                            for camera in (row.get('cameras') or {}).values()
                            if isinstance(camera, dict)]
            endpoints = sum(bool(re.fullmatch(r'↓\s*[cC]?[0-9]{1,4}', code)) for code in camera_codes)
            continuation = not raw_scene or raw_scene.startswith('↓')
            if continuation and endpoints >= 2 and current_shot and previous_take:
                inherited_shot, inherited_take = current_shot, str(previous_take)
            elif not raw_scene and not any(code.startswith('↓') for code in camera_codes):
                current_scene, current_shot, previous_take = '', '', 0

        group_id = by_locator.get((page, row_number))
        if group_id:
            item = published[group_id]
            fields = dict(item['fields'])
            if not raw_scene and current_scene:
                fields.setdefault('scene', {'state': 'suggested', 'value': current_scene})
            if inherited_shot:
                fields.setdefault('shot', {'state': 'suggested', 'value': inherited_shot})
            if inherited_take:
                fields.setdefault('take', {'state': 'suggested', 'value': inherited_take})
            if fields:
                published[group_id] = {**item, 'state': 'paper_suggestion', 'fields': fields}
    return published


def read_algorithmic_suggestions(output, project_id, paper, index, report, groups):
    """Publish verified row/group checks without requiring a native PDF receipt.

    Imported paper transcription remains unverified evidence. The result is a
    read-only proposal for Desktop drafts and never writes script_supervisor.
    """
    path = Path(output) / 'paper_field_suggestions.v1.json'
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 1_000_000:
            return None
        with path.open('rb') as stream:
            bundle = json.loads(stream.read(1_000_001))
        if bundle.get('contract') != CONTRACT or not isinstance(bundle.get('entries'), list) or len(bundle['entries']) > 1200:
            return None
        pdf = bundle.get('header', {}).get('pdf_sha256')
        if not isinstance(pdf, str) or not re.fullmatch(r'[a-f0-9]{64}', pdf):
            return None
        snapshot = paper.read_model()
        docs = [doc for doc in snapshot['documents'] if doc.get('source_document_digest_claim') == pdf]
        if len(docs) != 1:
            return None
        rows = [row for row in snapshot['rows'] if row['document_id'] == docs[0]['document_id']]
        page_count = max((int(row['raw_row'].get('pdf_page', 0) or 0) for row in rows), default=0)
        current_header = {
            'scope': project_id,
            'pdf_sha256': pdf,
            'pages': page_count,
            'paper_rows_sha256': digest([row['raw_row'] for row in rows]),
            'index_sha256': digest(index),
            'sync_sha256': digest(report),
        }
        stored_header = bundle.get('header', {})
        if any(stored_header.get(key) != current_header.get(key) for key in ('scope', 'pdf_sha256', 'pages', 'paper_rows_sha256')):
            return None
        # ASR changes analysis metadata and sync can update report metadata.
        # The exact paper row and source member checks in project() still
        # determine whether each proposal applies to the current Take.
        verified_bundle = {**bundle, 'header': current_header}
        result = project(
            verified_bundle,
            scope=project_id,
            pdf_sha=pdf,
            page_count=page_count,
            paper_rows=[row['raw_row'] for row in rows],
            index=index,
            sync_report=report,
            visible_ids={group['group_id'] for group in groups},
            manual={},
        )
        if result['state'] != 'current':
            return None
        return {
            'contract': CONTRACT,
            'editorial_authority': False,
            'paper_revision': snapshot['revision'],
            'groups': _inherit_same_page_context(_publish_algorithmic_result(result, rows, pdf), rows),
        }
    except (OSError, ValueError, TypeError, AttributeError, KeyError, IndexError):
        return None
