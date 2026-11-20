"""Project-local interval review transactions, not a route or export authority.

Candidate producer and descriptor reader are trusted Host seams, NOT UI payloads.
No semantic tasks, SDK calls, hashing media, or legacy Slate writes occur here.
"""
from contextlib import contextmanager
from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
from threading import RLock
try:
    import fcntl
except ImportError:
    fcntl=None
from .scene_interval_plan import build_marker_plan,evidence_digest


class IntervalConflict(ValueError):
    pass


class SceneIntervalStore:
    _lock=RLock()

    def __init__(self,output_dir,project_id):
        if not isinstance(project_id,str) or not project_id:raise ValueError('project_id_required')
        self.path=Path(output_dir)/'scene_intervals.json'
        self.project_id=project_id

    def snapshot(self):
        if not self.path.exists():
            return {'contract':'mirrororder.scene_interval_review.v1','project_id':self.project_id,'revision':0,'intervals':{},'events':[]}
        payload=json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(payload,dict) or payload.get('contract')!='mirrororder.scene_interval_review.v1' or payload.get('project_id')!=self.project_id or type(payload.get('revision')) is not int or not isinstance(payload.get('intervals'),dict):
            raise ValueError('invalid_interval_store')
        return payload

    def read_model(self):
        """Cheap read only; historical confirmation is not current export readiness."""
        payload=self.snapshot()
        rows=list(payload['intervals'].values())
        return {'contract':payload['contract'],'project_id':self.project_id,'revision':payload['revision'],
                'candidates':[r for r in rows if r.get('review_state')=='proposal'],
                'confirmed_intervals':[r for r in rows if r.get('review_state')=='human_verified'],
                'current_media_validation':'not_checked','export_ready':False}

    @contextmanager
    def _transaction(self,expected_revision):
        if type(expected_revision) is not int or expected_revision<0:raise ValueError('expected_revision_required')
        if fcntl is None:raise RuntimeError('process_lock_unavailable')
        self.path.parent.mkdir(parents=True,exist_ok=True)
        with self._lock,self.path.with_suffix('.json.lock').open('a+',encoding='utf-8') as lock:
            fcntl.flock(lock.fileno(),fcntl.LOCK_EX)
            try:
                payload=self.snapshot()
                if payload['revision']!=expected_revision:raise IntervalConflict('store_revision_changed')
                yield payload
            finally:fcntl.flock(lock.fileno(),fcntl.LOCK_UN)

    def _commit(self,payload,*,bump_revision=True):
        if bump_revision:payload['revision']+=1
        fd,tmp=tempfile.mkstemp(prefix='scene_intervals.',suffix='.tmp',dir=self.path.parent)
        try:
            with os.fdopen(fd,'w',encoding='utf-8') as stream:
                json.dump(payload,stream,ensure_ascii=False,sort_keys=True,allow_nan=False);stream.flush();os.fsync(stream.fileno())
            os.replace(tmp,self.path)
        finally:
            if os.path.exists(tmp):os.unlink(tmp)
        return deepcopy(payload)

    def put_candidate(self,candidate,*,expected_revision):
        """Host producer only. Editing always demotes review; raw paper is immutable."""
        eid=candidate.get('evidence_id')
        if not isinstance(eid,str) or not eid:raise ValueError('evidence_id_required')
        with self._transaction(expected_revision) as payload:
            prior=payload['intervals'].get(eid)
            row=deepcopy(candidate);row.pop('review',None)
            row['version']=prior['version']+1 if prior else 1
            row['review_state']='proposal'
            if prior and any(row.get(k)!=prior.get(k) for k in ('raw_cells','provenance')):
                raise IntervalConflict('paper_provenance_is_immutable_new_evidence_required')
            if not isinstance(row.get('raw_cells'),dict) or not isinstance(row.get('provenance'),dict):raise ValueError('raw_paper_provenance_required')
            payload['intervals'][eid]=row
            payload['events'].append({'action':'proposal','evidence_id':eid,'version':row['version'],'evidence_sha256':evidence_digest(row)})
            return self._commit(payload)

    def confirm(self,evidence_id,*,expected_revision,expected_evidence_version,
                expected_evidence_sha256,expected_descriptor_revision,actor,descriptor_reader,source_guard=None):
        """Explicit human review only. Host supplies actor and trusted receipt reader.

        Reader returns immutable bounded local receipt status=verified, media_id,
        asset_revision, fps,frame_count and descriptor_revision. No receipt means
        fail closed. This function never accepts these values from a review body.
        """
        if not isinstance(actor,str) or not actor.strip():raise ValueError('review_actor_required')
        if type(expected_evidence_version) is not int or expected_evidence_version<1 or not isinstance(expected_evidence_sha256,str) or len(expected_evidence_sha256)!=64:
            raise ValueError('expected_evidence_identity_required')
        with self._transaction(expected_revision) as payload:
            row=deepcopy(payload['intervals'].get(evidence_id))
            if not row or row['version']!=expected_evidence_version or evidence_digest(row)!=expected_evidence_sha256:
                raise IntervalConflict('evidence_changed')
            if row.get('classification_pending') is True:raise ValueError('paper_classification_pending')
            receipt=descriptor_reader(row.get('media_id'))
            if not isinstance(receipt,dict) or receipt.get('status')!='verified' or not expected_descriptor_revision or receipt.get('descriptor_revision')!=expected_descriptor_revision or receipt.get('media_id')!=row.get('media_id'):
                raise IntervalConflict('verified_descriptor_missing_or_changed')
            row['review_state']='human_verified'
            row['review']={'actor':actor.strip(),'evidence_version':row['version'],'evidence_sha256':evidence_digest(row),'descriptor_revision':expected_descriptor_revision}
            check=build_marker_plan(self.project_id,[row],[receipt],[])['rows'][0]
            if check['action']!='propose_add_marker':raise ValueError('interval_not_confirmable:'+','.join(check['reasons']))
            if descriptor_reader(row['media_id'])!=receipt:raise IntervalConflict('descriptor_changed_during_review')
            if source_guard is not None:source_guard(row)
            payload['intervals'][evidence_id]=row
            payload['events'].append({'action':'confirm','evidence_id':evidence_id,'version':row['version'],'actor':actor.strip(),'evidence_sha256':evidence_digest(row),'descriptor_revision':expected_descriptor_revision})
            return self._commit(payload)
