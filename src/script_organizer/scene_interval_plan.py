"""Pure source-interval evidence validation and Resolve marker dry-run planning.

No I/O, provider, SDK, metadata writer, implicit rounding or authority promotion.
The caller owns ingestion/review and verified local media binding.
"""
from copy import deepcopy
from fractions import Fraction
import hashlib
import json
import re
from .paper_scene_token import PAUSE_REASON, blocked_paper_interval_scene

CONTRACT = 'mirrororder.scene_intervals.v1'
NAMESPACE = 'mirrororder.scene-interval.v1:'


def _digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode()).hexdigest()


def evidence_digest(row):
    """Digest binds review to exact evidence content, not merely a reused version."""
    return _digest({k:v for k,v in row.items() if k != "review"})


def _positive_int(value):
    return type(value) is int and value > 0


def build_marker_plan(project_id: str, evidence: list[dict], inventory: list[dict], existing: list[dict]) -> dict:
    """Existing is a read-only local SDK snapshot normalized by a future adapter.

    Inventory: media_id, asset_revision, fps{numerator,denominator}, frame_count.
    Existing: media_id, source_frame, custom_data (raw SDK string).
    No filename fallback. Returned source frames are zero-based source intent;
    native coordinate conversion and SDK identity still require acceptance.
    """
    if not isinstance(project_id,str) or not project_id.strip():
        raise ValueError('project_id_required')
    assets={};duplicate=set()
    for asset in inventory:
        key=asset.get('media_id')
        if key in assets:duplicate.add(key)
        assets[key]=asset
    owned=[]
    for marker in existing:
        try:
            value=json.loads(marker.get('custom_data',''))
        except (ValueError,TypeError):
            continue
        if isinstance(value,dict) and value.get('namespace')==NAMESPACE:
            owned.append({**marker,'marker_id':value.get('marker_id'),'payload_sha256':value.get('payload_sha256')})
    rows=[];duplicate_ids={r.get('evidence_id') for r in evidence if sum(x.get('evidence_id')==r.get('evidence_id') for x in evidence)>1}
    for raw in evidence:
        row=deepcopy(raw);reasons=[]
        eid=row.get('evidence_id');mid=row.get('media_id');version=row.get('version')
        if not isinstance(eid,str) or not eid or eid in duplicate_ids:reasons.append('invalid_or_duplicate_evidence_id')
        if not isinstance(mid,str) or not re.fullmatch(r'M_[A-Za-z0-9_-]+',mid):reasons.append('invalid_media_id')
        asset=assets.get(mid,{})
        if not asset or mid in duplicate:reasons.append('missing_or_ambiguous_asset_identity')
        if not _positive_int(version):reasons.append('invalid_evidence_version')
        state=row.get('review_state')
        if state not in ('proposal','human_verified','rejected'):reasons.append('invalid_review_state')
        provenance=row.get('provenance')
        if not isinstance(provenance,dict) or not provenance.get('origin') or not provenance.get('record_id'):reasons.append('missing_provenance')
        if not isinstance(row.get('raw_cells'),dict):reasons.append('missing_raw_cells')
        if row.get('classification_pending') is True:reasons.append('paper_classification_pending')
        if not isinstance(row.get('scene'),str) or not row['scene'].strip():reasons.append('missing_scene')
        if blocked_paper_interval_scene(row):reasons.append(PAUSE_REASON)
        if row.get('asset_revision') != asset.get('asset_revision') or not asset.get('asset_revision'):reasons.append('stale_asset_revision')
        fps=row.get('source_fps',{});afps=asset.get('fps',{})
        try:
            if not all(_positive_int(fps.get(k)) and _positive_int(afps.get(k)) for k in ('numerator','denominator')):raise ValueError()
            rate=Fraction(fps['numerator'],fps['denominator'])
            if rate!=Fraction(afps['numerator'],afps['denominator']):raise ValueError()
        except (TypeError,ValueError,ZeroDivisionError,AttributeError):reasons.append('unknown_or_mismatched_source_timebase')
        start,end=row.get('source_start_frame'),row.get('source_end_frame')
        if not (type(start) is int and type(end) is int and _positive_int(asset.get('frame_count')) and 0<=start<end<=asset['frame_count']):reasons.append('invalid_source_frame_range')
        if row.get('boundary_status')!='exact_source_frames':reasons.append('range_boundary_needs_review')
        if state=='human_verified':
            review=row.get('review',{})
            if not isinstance(review,dict) or not review.get('actor') or review.get('evidence_version')!=version or review.get('evidence_sha256')!=evidence_digest(row):reasons.append('missing_or_stale_human_review')
        classification=row.get('classification')
        name=str(row.get('scene',''))
        if isinstance(classification,dict):
            episode=classification.get('episode');scene_id=classification.get('scene_id')
            if not _positive_int(episode) or not isinstance(scene_id,str) or not scene_id or scene_id!=name or classification.get('mode') not in ('script_scene','local_correction') or not classification.get('draft_id'):
                reasons.append('invalid_verified_scene_context')
            else:name=f'E{episode} · {scene_id}'
        token=NAMESPACE+_digest({'project_id':project_id,'evidence_id':eid})
        intent={'marker_id':token,'media_id':mid,'asset_revision':row.get('asset_revision'),
                'source_start_frame':start,'source_end_frame':end,'source_fps':fps,
                'name':name,'note':str(row.get('note','')),
                'evidence_id':eid,'evidence_version':version,'review_state':state,
                'whole_clip_authorized':False,'exact_take_confirmed':False}
        digest=_digest(intent)
        action='blocked' if reasons else 'review_required'
        if state=='rejected' and not reasons:action='excluded'
        if state=='human_verified' and not reasons:
            same=[m for m in owned if m.get('marker_id')==token]
            occupied=[m for m in existing if m.get('media_id')==mid and m.get('source_frame')==start]
            if same:
                if len(same)==1 and same[0].get('media_id')==mid and same[0].get('source_frame')==start and same[0].get('payload_sha256')==digest and same[0].get('name')==intent['name'] and same[0].get('note')==intent['note'] and same[0].get('duration')==end-start:
                    action='noop'
                else:action='conflict';reasons.append('existing_owned_marker_changed_or_duplicated')
            elif occupied:action='conflict';reasons.append('existing_marker_at_source_frame')
            else:action='propose_add_marker'
        rows.append({'evidence':row,'intent':intent,'native_custom_data':json.dumps({'namespace':NAMESPACE,'marker_id':token,'payload_sha256':digest},sort_keys=True,separators=(',',':')),'payload_sha256':digest,'action':action,'reasons':reasons})
    # Two new markers at the same native key must not become last-writer-wins.
    for row in rows:
        if row['action']=='propose_add_marker' and sum(r['action']=='propose_add_marker' and r['intent']['media_id']==row['intent']['media_id'] and r['intent']['source_start_frame']==row['intent']['source_start_frame'] for r in rows)>1:
            row['reasons'].append('planned_marker_frame_collision')
    for row in rows:
        if 'planned_marker_frame_collision' in row['reasons']:row['action']='conflict'
    return {'contract':CONTRACT,'project_id':project_id,'mode':'dry_run','writes_project':False,
            'native_adapter_status':'not_validated','requires_verified_local_binding':True,
            'plan_sha256':_digest(rows),'rows':rows}
