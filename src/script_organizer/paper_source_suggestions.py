"""Host inventory projection only; never authoritative card metadata."""

def inventory(index):
    rows=list(index.get('clips',[]))
    for group in index.get('groups',[]):rows.extend(group.get('members',[]))
    pairs={}
    for raw in rows:
        if not isinstance(raw,dict):continue
        cid,mid=raw.get('clip_id'),raw.get('media_id')
        if not isinstance(cid,str) or not cid or not isinstance(mid,str) or not mid:continue
        item={'clip_id':cid,'media_id':mid,'camera':raw.get('camera') if isinstance(raw.get('camera'),str) else None}
        key=(cid,mid)
        if key in pairs and pairs[key]!=item:raise ValueError('conflicting_inventory_occurrence')
        pairs[key]=item
    return list(pairs.values())
