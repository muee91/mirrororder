"""Project-scoped, exact-occurrence human shot type/notes. No group/scene or NLE writes."""
from copy import deepcopy
import math
import json
from pathlib import Path
import re
from script_organizer.scene_interval_store import SceneIntervalStore, IntervalConflict
from script_organizer.source_descriptor_receipt import _digest, _sampled_id, _stat
from script_organizer.scene_interval_plan import _digest as index_digest
from script_organizer.script_supervisor_store import SHOT_TYPES, _now

CONTRACT="mirrororder.sync_angle_annotations.v1"
_IDENTITY=("group_id","clip_id","media_id","camera")
_FIELDS={"shot_type","note"}
_EXTENTS=("source_start","source_end","timeline_start","timeline_end")
_MEDIA=re.compile(r"M_[a-f0-9]{24}")

def _extent(row):
    values=tuple(row.get(k) for k in _EXTENTS)
    if (any(type(x) not in (int,float) or not math.isfinite(x) or x<0 for x in values)
        or values[1]<=values[0] or values[3]<=values[2]):
        raise ValueError("exact_sync_extent_required")
    return dict(zip(_EXTENTS,map(float,values)))

def _lookup(index):
    group_by={};members={};clips={}
    for g in index.get('groups',[]):
        gid=g.get('group_id')
        group_by.setdefault(gid,[]).append(g)
        for row in g.get('members',[]):
            members.setdefault((gid,row.get('clip_id')),[]).append(row)
    for row in index.get('clips',[]):
        clips.setdefault(row.get('clip_id'),[]).append(row)
    return group_by,members,clips

def _occurrence(index,identity,lookup=None):
    gs,ms,cs=_lookup(index) if lookup is None else lookup
    groups=gs.get(identity["group_id"],[])
    if len(groups)!=1:raise IntervalConflict("sync_group_missing_or_ambiguous")
    gid,clip_id,mid,camera=[identity[k] for k in _IDENTITY]
    angles=ms.get((gid,clip_id),[])
    if len(angles)!=1 or (angles[0].get("media_id"),angles[0].get("camera"))!=(mid,camera):
        raise IntervalConflict("sync_angle_missing_changed_or_ambiguous")
    roots=cs.get(clip_id,[])
    if not roots or {(c.get("media_id"),c.get("camera")) for c in roots}!={(mid,camera)}:
        raise IntervalConflict("sync_inventory_identity_changed")
    group_extent=_extent(angles[0]);sources={tuple(_extent(c).values()) for c in roots}
    if len(sources)!=1:raise IntervalConflict("sync_indexed_occurrence_ambiguous")
    root_extent=dict(zip(_EXTENTS,next(iter(sources))))
    return {**identity,"angle_extent":group_extent,"index_clip_extent":root_extent}

def register_verifier(device,workspace_id,project_id):
    """Bounded head/tail proof and stat, no ffprobe or network or raw path payload."""
    def verify(mid):
        def persisted():
            return device.load().get("workspaces",{}).get(workspace_id,{}).get("projects",{}).get(project_id,{}).get("bindings",{}).get(mid)
        value=persisted()
        if not isinstance(value,str):raise IntervalConflict("current_registered_source_required")
        try:
            path=Path(value).resolve(strict=True)
            if not path.is_file():raise ValueError()
            before=_stat(path)
            if _sampled_id(path)!=mid or _stat(path)!=before or persisted()!=value or Path(value).resolve(strict=True)!=path:
                raise ValueError()
        except (OSError,ValueError):
            raise IntervalConflict("registered_source_identity_or_binding_changed") from None
        return _digest({"workspace":workspace_id,"project":project_id,"media":mid,"device_path":str(path),"stat":before})
    return verify


class SyncAngleAnnotationStore(SceneIntervalStore):
    """Strict narrow companion to legacy human notes; filename never used for linkage."""
    def __init__(self,output_dir,workspace_id,project_id):
        if not isinstance(workspace_id,str) or not workspace_id:raise ValueError("verified_workspace_scope_required")
        super().__init__(output_dir,project_id)
        self.workspace_id=workspace_id
        self.path=Path(output_dir)/"sync_angle_annotations.json"

    def snapshot(self):
        if not self.path.is_file():
            return {"contract":CONTRACT,"workspace_id":self.workspace_id,"project_id":self.project_id,
                    "revision":0,"rows":{},"events":[]}
        data=json.loads(self.path.read_text(encoding="utf-8"))
        if (not isinstance(data,dict) or data.get("contract")!=CONTRACT or
            data.get("workspace_id")!=self.workspace_id or data.get("project_id")!=self.project_id or
            type(data.get("revision")) is not int or not isinstance(data.get("rows"),dict) or not isinstance(data.get("events"),list)):
            raise IntervalConflict("sync_annotation_store_scope_or_state_invalid")
        return data

    def annotate(self,request,*,index_reader,registered_verifier,actor):
        if not isinstance(request,dict) or set(request)!=set(_IDENTITY)|{"expected_revision","expected_index_sha256","fields"}:
            raise ValueError("invalid_sync_annotation_fields")
        fields=request["fields"];identity={k:request[k] for k in _IDENTITY}
        if (any(not isinstance(v,str) or not v.strip() or len(v)>160 for v in identity.values()) or
            not _MEDIA.fullmatch(identity["media_id"]) or not isinstance(actor,str) or not actor.strip()):
            raise ValueError("verified_sync_angle_and_actor_required")
        if (not isinstance(fields,dict) or not fields or not set(fields)<=_FIELDS or
            'shot_type' in fields and (not isinstance(fields['shot_type'],str) or fields['shot_type'] not in SHOT_TYPES) or
            'note' in fields and (not isinstance(fields['note'],str) or len(fields['note'])>500)):
            raise ValueError("invalid_shot_or_note")
        def current():
            data=index_reader()
            if index_digest(data)!=request["expected_index_sha256"]:raise IntervalConflict("sync_index_changed")
            return _occurrence(data,identity)
        with self._transaction(request["expected_revision"]) as payload:
            now=current();proof=registered_verifier(identity["media_id"])
            if not proof:raise IntervalConflict("registered_source_identity_or_binding_changed")
            key="sync-angle-"+_digest({"workspace":self.workspace_id,"project":self.project_id,"occurrence":now})
            row={"annotation_id":key,**identity,"occurrence":now,"shot_type":"unknown","note":"",
                 **payload["rows"].get(key,{}),**fields,"actor":actor.strip()[:80],"updated_at":_now()}
            row["annotation_state"]="saved" if row["shot_type"]!="unknown" or row["note"] else "cleared"
            if current()!=now or registered_verifier(identity["media_id"])!=proof:
                raise IntervalConflict("sync_occurrence_or_registered_source_changed")
            payload["rows"][key]=row
            payload["events"].append({"action":"annotate_angle","annotation_id":key,
                                       "annotation_version":payload["revision"]+1,"actor":row["actor"],
                                       "annotation_sha256":_digest(row)})
            updated=self._commit(payload)
            return {"revision":updated["revision"],"annotation":deepcopy(row),
                    "editorial_authority":False,"writes_scene":False}

    def read(self,index):
        state=self.snapshot();current=[];unresolved=[]; lookup=_lookup(index)
        for row in state["rows"].values():
            try:now=_occurrence(index,{k:row[k] for k in _IDENTITY},lookup)
            except (ValueError,KeyError,TypeError):now=None
            (current if now==row.get("occurrence") else unresolved).append(deepcopy(row))
        return {"contract":CONTRACT,"revision":state["revision"],"index_sha256":index_digest(index),
                "current":current,"unresolved":unresolved,"checks_current_original_bytes":False,
                "editorial_authority":False}
