"""Read-only structured OCR intake. No OCR, file I/O, store mutation or NLE calls.

Ready means structurally ready for review, NOT approved for authority/export.
Local asset paths are matching inputs only and never enter returned proposals.
"""
from __future__ import annotations

import csv
import io
import json
from collections import Counter
from copy import deepcopy

FIELDS = ('scene', 'shot', 'take', 'episode', 'date', 'card', 'camera',
          'filename', 'start_tc', 'end_tc', 'notes')
SELECTORS = ('media_id', 'clip_id', 'local_path', 'filename')
DITTO = {'〃', '同上', 'ditto', '"'}


def read_rows(text: str, format: str) -> list[dict]:
    """JSON array or CSV; lexical numbers must remain strings (including 003)."""
    if format == 'json':
        rows = json.loads(text)
    elif format == 'csv':
        reader = csv.DictReader(io.StringIO(text.lstrip('\ufeff')))
        headers = reader.fieldnames or []
        if not headers or len(headers) != len(set(headers)):
            raise ValueError('missing_or_duplicate_csv_headers')
        rows = list(reader)
        if any(None in r or any(v is None for v in r.values()) for r in rows):
            raise ValueError('malformed_csv_row')
    else:
        raise ValueError('format_must_be_json_or_csv')
    if not isinstance(rows, list) or any(not isinstance(r, dict) for r in rows):
        raise ValueError('rows_must_be_object_array')
    return rows


def prepare(rows: list[dict], assets: list[dict], *, confirmed_groups: dict | None = None) -> dict:
    """Return evidence proposals with stable media_id/clip_id attachments.

    assets: project inventory, one row per clip_id, with media_id and optional
    filename/date/card/camera/start_tc/end_tc/local_path and confirmed metadata.
    confirmed_groups: explicitly human-confirmed group_id -> list of clip_ids.
    No implicit group propagation; scene/shot/take alone never identifies media.
    """
    groups = confirmed_groups or {}
    proposals = []
    prior = None
    clip_counts = Counter(a.get('clip_id') for a in assets)
    for index, raw in enumerate(rows):
        if not isinstance(raw, dict):
            raise ValueError('row_must_be_object')
        reasons = []
        values = {}
        inherited = {}
        page = raw.get('page', '')
        for field in FIELDS:
            value = raw.get(field, '')
            if value is None:
                value = ''
            if not isinstance(value, str):
                reasons.append('non_string:' + field)
                value = ''
            value = value.strip()
            if value in DITTO:
                if prior and page and page == prior['provenance']['page'] and prior['fields'].get(field) and not prior['reasons']:
                    value = prior['fields'][field]
                    inherited[field] = prior['row_index']
                else:
                    value = ''
                    reasons.append('unresolved_ditto:' + field)
            values[field] = value
        for field in ('scene', 'shot', 'take'):
            if not values[field]:
                reasons.append('missing:' + field)
        if raw.get('ambiguities'):
            reasons.append('source_ambiguous')
        # Page/row are source labels, never inferred page numbers.
        if not page or not raw.get('row') or not raw.get('text'):
            reasons.append('missing_provenance')
        selectors = {}
        for key in SELECTORS:
            val = values['filename'] if key == 'filename' else raw.get(key, '')
            if val:
                if not isinstance(val, str):
                    reasons.append('non_string:' + key)
                else:
                    selectors[key] = val.strip()
        gid = raw.get('confirmed_group_id', '')
        candidates = []
        if gid:
            ids = groups.get(gid, [])
            if not ids:
                reasons.append('group_not_confirmed')
            else:
                candidates = [a for a in assets if a.get('clip_id') in ids]
                if set(ids) != {a.get('clip_id') for a in candidates}:
                    reasons.append('group_member_missing')
        elif not selectors:
            reasons.append('missing_asset_identity')
        else:
            candidates = list(assets)
        # All provided selectors/discriminators must agree, even with a stable ID.
        for key, value in {**selectors, **{k: values[k] for k in ('date', 'card', 'camera', 'start_tc', 'end_tc') if values[k]}}.items():
            candidates = [a for a in candidates if a.get(key) == value]
        if selectors or gid:
            if not candidates:
                reasons.append('asset_not_found_or_contradictory')
            elif len(candidates) > 1 and not gid:
                reasons.append('ambiguous_asset_identity')
        if gid and groups.get(gid) and set(groups[gid]) != {a.get('clip_id') for a in candidates}:
            reasons.append('group_selector_contradiction')
        attachments = []
        for asset in candidates:
            cid, mid = asset.get('clip_id'), asset.get('media_id')
            if not cid or not mid or clip_counts[cid] != 1:
                reasons.append('invalid_inventory_identity')
                continue
            attachments.append({'clip_id': cid, 'media_id': mid, 'camera': asset.get('camera', '')})
            for field, value in values.items():
                current = asset.get('confirmed', {}).get(field)
                if value and current not in (None, '') and str(current) != value:
                    reasons.append('confirmed_conflict:' + field)
        proposal = {'row_index': index, 'fields': values, 'attachments': attachments,
                    'provenance': {'page': page, 'row': raw.get('row', ''), 'text': raw.get('text', '')},
                    'raw_fields': {k: deepcopy(raw.get(k)) for k in FIELDS if k in raw},
                    'inherited_from': inherited, 'reasons': reasons,
                    'confirmed': raw.get('confirmed') is True}
        proposals.append(proposal)
        prior = proposal
    # Conflicts block ALL rows for a physical original, not just the last writer.
    for field in FIELDS:
        by_media = {}
        for p in proposals:
            value = p['fields'][field]
            if value:
                for a in p['attachments']:
                    by_media.setdefault(a['media_id'], set()).add(value)
        for p in proposals:
            if any(len(by_media.get(a['media_id'], set())) > 1 for a in p['attachments']):
                p['reasons'].append('row_conflict:' + field)
    for p in proposals:
        if any(proposals[i]['reasons'] for i in p['inherited_from'].values()):
            p['reasons'].append('inherited_source_unresolved')
        p['reasons'] = sorted(set(p['reasons']))
    return {'contract': 'slate_log_proposal.v1', 'ready': [p for p in proposals if not p['reasons']],
            'unresolved': [p for p in proposals if p['reasons']],
            'writes_authority': False}


def render_metadata_csv(prepared: dict, template_csv: str, *, bindings: dict,
                        field_columns: dict, identity_columns: list[str],
                        template_source: str = '') -> dict:
    """Template-driven transport, NOT a verified Resolve adapter.

    bindings: media_id -> zero-based original row in a real Resolve CSV export.
    field_columns: explicitly verified internal field -> exact template header.
    identity_columns: actual matching headers; all must be nonempty and unique.
    Keeps original match values; refuses all nonempty existing-value conflicts.
    Emits at most one row per physical original; no match-by-scene/take.
    """
    if not template_source:
        return {'status': 'unverified_template', 'csv': '', 'unresolved': []}
    reader = csv.DictReader(io.StringIO(template_csv.lstrip('\ufeff')))
    headers = reader.fieldnames or []
    originals = list(reader)
    if not headers or len(set(headers)) != len(headers) or not identity_columns:
        raise ValueError('invalid_template_headers')
    if any(c not in headers for c in identity_columns + list(field_columns.values())):
        raise ValueError('unsupported_template_column')
    if set(identity_columns) & set(field_columns.values()) or len(set(field_columns.values())) != len(field_columns):
        raise ValueError('overlapping_column_mapping')
    if any(k not in FIELDS for k in field_columns):
        raise ValueError('unsupported_field')
    if any(None in r or any(v is None for v in r.values()) for r in originals):
        raise ValueError('malformed_template_row')
    keys = [tuple(r[c] for c in identity_columns) for r in originals]
    counts = Counter(keys)
    by_media = {}
    issues = []
    for p in prepared['ready']:
        if p.get('confirmed') is not True:
            issues.append({'row_index': p['row_index'], 'reason': 'human_confirmation_required'})
            continue
        for attachment in p['attachments']:
            mid = attachment['media_id']
            by_media.setdefault(mid, []).append(p)
    bound_counts = Counter(bindings.get(mid) for mid in by_media)
    output = []
    used = set(identity_columns)
    for mid, proposals in by_media.items():
        idx = bindings.get(mid)
        if type(idx) is not int or idx < 0 or idx >= len(originals) or bound_counts[idx] != 1:
            issues.append({'media_id': mid, 'reason': 'missing_or_duplicate_template_binding'})
            continue
        if counts[keys[idx]] != 1 or not all(keys[idx]):
            issues.append({'media_id': mid, 'reason': 'ambiguous_or_empty_template_identity'})
            continue
        row = {c: originals[idx][c] for c in identity_columns}
        conflict = False
        for field, column in field_columns.items():
            vals = {p['fields'][field] for p in proposals if p['fields'][field]}
            if len(vals) > 1:
                conflict = True
            if vals:
                value = next(iter(vals))
                existing = originals[idx][column]
                if existing and existing != value:
                    conflict = True
                row[column] = value
        if conflict:
            issues.append({'media_id': mid, 'reason': 'template_metadata_conflict'})
            continue
        if len(row) > len(identity_columns):
            output.append(row)
            used.update(row)
    out = io.StringIO(newline='')
    columns = [h for h in headers if h in used]
    if output:
        writer = csv.DictWriter(out, fieldnames=columns, lineterminator='\r\n')
        writer.writeheader()
        writer.writerows(output)
    return {'status': 'template_transport_only_not_nle_verified', 'csv': out.getvalue(),
            'unresolved': deepcopy(prepared['unresolved']) + issues,
            'original_count': len(output), 'template_source': template_source,
            'required_merge_policy': 'only_nonempty', 'writes_authority': False}


def prepare_project_request(body: dict, index: dict, board: dict) -> dict:
    """Existing local parse route's explicit structured mode, always unconfirmed.

    Inventory and prior facts come from Host snapshots, never request-supplied
    assets. No scan, hash, path binding, model invocation or persistence occurs.
    Current v2 cannot store lossless take labels/provenance: return proposals only.
    """
    if body.get('mode') != 'structured_slate_log.v1':
        raise ValueError('unsupported_structured_mode')
    content = body.get('content')
    if not isinstance(content, str) or len(content) > 2_000_000:
        raise ValueError('content_must_be_string_at_most_2m_characters')
    rows = read_rows(content, body.get('format'))
    if len(rows) > 500:
        raise ValueError('at_most_500_rows')
    rows = [{**r, 'confirmed': False} for r in rows]
    inventory = []
    seen = set()
    source_rows = list(index.get('clips', []))
    for group in index.get('groups', []):
        if isinstance(group, dict):
            source_rows.extend(group.get('members', []))
    primary_count = len(index.get('clips', []))
    for source_index, raw in enumerate(source_rows):
        if not isinstance(raw, dict):
            continue
        # Use only exact known fields, not guessed metadata aliases.
        asset = {k: raw[k] for k in ('clip_id', 'media_id', 'camera', 'date', 'card', 'start_tc', 'end_tc') if isinstance(raw.get(k), str)}
        name = raw.get('source_media_path') or raw.get('media_path') or raw.get('name') or ''
        if isinstance(name, str):
            asset['filename'] = name.replace('\\', '/').rsplit('/', 1)[-1]
        signature = json.dumps(asset, sort_keys=True)
        if source_index >= primary_count and signature in seen:
            continue  # Same occurrence projected into clips and group members.
        seen.add(signature)
        inventory.append(asset)
    result = prepare(rows, inventory)  # Algorithmic groups are NOT confirmation.
    all_proposals = sorted(result['ready'] + result['unresolved'], key=lambda p: p['row_index'])
    for p in all_proposals:
        for record in board.get('records', {}).values():
            if not isinstance(record, dict):
                continue
            prior_ids = [(a.get('clip_id'), a.get('media_id')) for a in record.get('attachments', []) if isinstance(a, dict)]
            if not any((cid and cid == a['clip_id']) or (mid and mid == a['media_id']) for cid, mid in prior_ids for a in p['attachments']):
                continue
            for field, stored in {'scene': 'scene', 'shot': 'shot', 'take': 'take_number', 'episode': 'episode', 'notes': 'note'}.items():
                old, proposed = record.get(stored), p['fields'][field]
                if proposed and old not in (None, '') and str(old) != proposed:
                    p['reasons'].append('confirmed_conflict:' + field)
        if any(all_proposals[i]['reasons'] for i in p['inherited_from'].values()):
            p['reasons'].append('inherited_source_unresolved')
        p['reasons'] = sorted(set(p['reasons']))
    result['ready'] = [p for p in all_proposals if not p['reasons']]
    result['unresolved'] = [p for p in all_proposals if p['reasons']]
    result['source_revision'] = board.get('revision', 0)
    result['review_required'] = True
    return result
