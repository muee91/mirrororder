from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import pytest
from script_organizer.scene_interval_store import SceneIntervalStore,IntervalConflict
from script_organizer.scene_interval_plan import evidence_digest
from test_scene_interval_plan import fixture


def setup(tmp_path):
    asset,row=fixture();receipt={**asset,'status':'verified','descriptor_revision':'descriptor1'}
    store=SceneIntervalStore(tmp_path,'p');payload=store.put_candidate(row,expected_revision=0)
    return store,payload['intervals']['record1'],receipt

def confirm(store,row,receipt,**override):
    args=dict(expected_revision=1,expected_evidence_version=row['version'],expected_evidence_sha256=evidence_digest(row),expected_descriptor_revision='descriptor1',actor='human',descriptor_reader=lambda _:deepcopy(receipt));args.update(override)
    return store.confirm('record1',**args)

def test_explicit_confirmation_persists_and_does_not_touch_legacy(tmp_path):
    legacy=tmp_path/'script_supervisor.json';legacy.write_text('legacy exact')
    store,row,receipt=setup(tmp_path)
    assert row['review_state']=='proposal' and 'review' not in row
    result=confirm(store,row,receipt)
    assert result['revision']==2 and result['intervals']['record1']['review_state']=='human_verified'
    assert SceneIntervalStore(tmp_path,'p').snapshot()==result
    assert legacy.read_text()=='legacy exact'

def test_missing_descriptor_and_stale_asset_do_not_save(tmp_path):
    store,row,receipt=setup(tmp_path);before=store.path.read_bytes()
    with pytest.raises(IntervalConflict):confirm(store,row,receipt,descriptor_reader=lambda _:None)
    receipt['asset_revision']='replaced'
    with pytest.raises(ValueError):confirm(store,row,receipt)
    assert store.path.read_bytes()==before

def test_stale_digest_or_revision_cannot_confirm(tmp_path):
    store,row,receipt=setup(tmp_path)
    with pytest.raises(IntervalConflict):confirm(store,row,receipt,expected_evidence_sha256='0'*64)
    with pytest.raises(IntervalConflict):confirm(store,row,receipt,expected_revision=0)
    assert store.snapshot()['revision']==1

def test_edit_demotes_and_paper_provenance_is_immutable(tmp_path):
    store,row,receipt=setup(tmp_path);confirm(store,row,receipt)
    row['scene']='new-scene'
    updated=store.put_candidate(row,expected_revision=2)['intervals']['record1']
    assert updated['version']==2 and updated['review_state']=='proposal' and 'review' not in updated
    updated['raw_cells']['scene']='rewritten paper'
    with pytest.raises(IntervalConflict):store.put_candidate(updated,expected_revision=3)

def test_descriptor_changes_while_confirming_fail_closed(tmp_path):
    store,row,receipt=setup(tmp_path);calls=iter([receipt,{**receipt,'descriptor_revision':'new'}])
    with pytest.raises(IntervalConflict):confirm(store,row,receipt,descriptor_reader=lambda _:next(calls))
    assert store.snapshot()['revision']==1

def test_competing_editors_only_one_transaction_wins(tmp_path):
    store,row,receipt=setup(tmp_path)
    def attempt(_):
        try:confirm(store,row,receipt);return 'saved'
        except IntervalConflict:return 'conflict'
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(attempt,range(2)))==['conflict','saved']
    assert store.snapshot()['revision']==2

def test_corrupt_store_never_resets_and_cross_project_read_rejected(tmp_path):
    store,row,receipt=setup(tmp_path)
    with pytest.raises(ValueError):SceneIntervalStore(tmp_path,'other').snapshot()
    store.path.write_text('broken')
    with pytest.raises(ValueError):store.put_candidate(row,expected_revision=0)
    assert store.path.read_text()=='broken'


def test_read_projection_separates_candidates_and_confirmation_without_false_export_ready(tmp_path):
    store,row,receipt=setup(tmp_path)
    assert len(store.read_model()['candidates'])==1
    confirm(store,row,receipt)
    view=store.read_model()
    assert not view['candidates'] and len(view['confirmed_intervals'])==1
    assert not view['export_ready'] and view['current_media_validation']=='not_checked'
