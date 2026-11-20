"""Index-only camera/card triage. No folder scan, stat, identity reads or writes.

An imported index name is evidence of an *indexed candidate*, never that
a registered original currently exists or that a slate refers to it.
"""
from collections import Counter, defaultdict
import re
from pathlib import PurePosixPath, PureWindowsPath

from .paper_filename_context import PATTERN
from .paper_nested_camera import CAMERAS, camera_cells
from .paper_source_suggestions import inventory
from .scene_interval_store import IntervalConflict
from .scene_interval_plan import _digest

REAL_ID = re.compile(r'M_[0-9a-f]{24}')
SHA256 = re.compile(r'[0-9a-f]{64}')
MAX_ROWS = 4000


def _indexed_names(index):
    names = defaultdict(set)
    for item in [*index.get('clips', []), *(item for group in index.get('groups', []) for item in group.get('members', []))]:
        if not isinstance(item, dict) or not isinstance(item.get("clip_id"), str) or not isinstance(item.get("media_id"), str):
            continue

        key = item.get('clip_id'), item.get('media_id')
        for field in ('name', 'media_path'):
            value = item.get(field)
            if not isinstance(value, str) or not value or len(value) > 4096:
                continue
            # Pure path projection only; never follow an index path.
            name = PurePosixPath(value.replace('\\', '/')).name
            match = PATTERN.fullmatch(name) or (PATTERN.fullmatch(name + '.MP4') if '.' not in name else None)
            if match:
                names[key].add((match[1], match[1] + match[2], int(match[3])))
    return names


def source_triage(paper_snapshot, index, bindings, *, scope, expected_paper_revision, expected_index_sha256):
    if type(expected_paper_revision) is not int or expected_paper_revision < 0 or not isinstance(expected_index_sha256, str) or not SHA256.fullmatch(expected_index_sha256):
        raise ValueError('invalid_source_triage_fence')
    if paper_snapshot['revision'] != expected_paper_revision or _digest(index) != expected_index_sha256:
        raise IntervalConflict('source_triage_snapshot_changed')
    if len(paper_snapshot['rows']) > MAX_ROWS:
        raise ValueError('source_triage_row_limit')
    names = _indexed_names(index)
    buckets = defaultdict(Counter)
    # Inventory deduplicates repeated clip/member references; distinct index
    # occurrences remain distinct even when the two share a media identity.
    for item in inventory(index):
        key = item['clip_id'], item['media_id']
        labels = names.get(key, set())
        # Conflicting index labels are not trusted to narrow a card. Keep
        # every same-camera candidate; never give inconsistent labels the
        # strength of a saved registration.
        for camera, card, code in labels:
            if camera != item['camera']:
                continue
            bucket = buckets[camera, code]
            bucket[card, 'occurrence_count'] += 1
            saved = bindings.get(item['media_id'])
            if (len(labels) == 1 and REAL_ID.fullmatch(item['media_id']) and isinstance(saved, str)
                    and (PurePosixPath(saved).is_absolute() or PureWindowsPath(saved).is_absolute())):
                # Registration is merely an identity+filename mapping; even
                # an offline mapped path is intentionally not checked here.
                registered_name = PATTERN.fullmatch(PurePosixPath(saved.replace('\\', '/')).name)
                if registered_name and (registered_name[1], registered_name[1]+registered_name[2], int(registered_name[3])) == (camera, card, code):
                    bucket[card, 'registered_count'] += 1
    rows = []
    for row in paper_snapshot['rows'].values():
        readable = {c['camera']: c for c in camera_cells(row)}
        cells = []
        for camera in CAMERAS:
            cell = readable.get(camera)
            cards = []
            if not cell:
                tier = 'empty'
            elif cell['status'] != 'literal':
                tier = 'uncertain'
            else:
                bucket = buckets.get((camera, int(cell['raw_code'].strip().lstrip('Cc'))), {})
                cards = [{'card':card, 'occurrence_count':bucket[card,'occurrence_count'], 'registered_count':bucket.get((card,'registered_count'),0)}
                         for card in sorted({c for c, k in bucket if k == 'occurrence_count'})]
                tier = ('not_indexed' if not cards else 'multi_card' if len(cards) > 1 else
                        'same_card_collision' if cards[0]['occurrence_count'] > 1 else 'single_indexed')
            cells.append({'camera':camera, 'tier':tier, 'cards':cards})
        rows.append({'paper_row_id':row['paper_row_id'], 'row_digest':row['row_digest'], 'cells':cells})
    return {'contract':'mirrororder.source_triage.v1','workspace_scope':scope, 'paper_revision':expected_paper_revision,
            'index_sha256':expected_index_sha256,'rows':rows}
