from copy import deepcopy
from types import SimpleNamespace

import pytest

from script_organizer.media_identity import DeviceMediaStore
from script_organizer.paper_intake_store import PaperIntakeStore
from script_organizer.paper_scene_token import PAUSE_REASON, is_paper_scene_shorthand
from script_organizer.paper_source_context import delivery_source_epoch
from script_organizer.scene_interval_plan import evidence_digest
from script_organizer.scene_interval_prepare import prepare_selected
from test_paper_intake import body, row
from test_scene_interval_ipc import call, request_for
from test_scene_interval_plan import review
from test_scene_interval_prepare import setup


@pytest.mark.parametrize('token', ['->','< -','-->','<=>','=>','－＞','↑','⇒','↓→','〃','—','...','//','??'])
def test_paper_only_exact_structure(token):
    assert is_paper_scene_shorthand(token)


@pytest.mark.parametrize('scene', ['19-1','E02-S003','003','临时外景 A','A/B','R->B','-03','A','Scene Alpha'])
def test_custom_scene_ids_not_rewritten(scene):
    assert not is_paper_scene_shorthand(scene)


@pytest.mark.parametrize('token',['->','<=>','↘'])
def test_preserve_existing_raw_store_and_block_actual_prepare(tmp_path,monkeypatch,token):
    _, t, interval, _, _ = setup(tmp_path,monkeypatch)
    config=SimpleNamespace(output_dir=interval.path.parent)
    paper=PaperIntakeStore(config.output_dir,'p')
    imported=paper.ingest(body([row(scene_raw=token)]))['rows'][0]
    persisted=paper.path.read_bytes()
    old=paper.snapshot()['rows'][imported['paper_row_id']]
    assert old['raw_row']['scene_raw']==token
    # The old ASCII persisted lexical projection was ready; do not rewrite it.
    if token in ('->','<=>'):assert old['candidate_ready'] is True
    assert imported['normalized_fields']['scene']==token and not imported['candidate_ready']
    assert PAUSE_REASON in imported['review_reasons']
    targets={k:v for k,v in t.items() if k not in ('record_id','expected_board_revision')}
    targets.update(paper_row_id=old['paper_row_id'],expected_paper_revision=1)
    with pytest.raises(ValueError,match=PAUSE_REASON):
        prepare_selected(config,'w','p',targets,DeviceMediaStore(),tmp_path/'device',
                         probe=lambda _:pytest.fail('blocked before probing'))
    assert interval.snapshot()['revision']==0 and paper.path.read_bytes()==persisted
    assert PaperIntakeStore(config.output_dir,'p').read_model()['rows'][0]==imported


def test_v2_existing_proposal_cannot_confirm_via_real_private_stdin(tmp_path,monkeypatch):
    from test_scene_interval_ipc import setup_local
    # Use the actual receipt and source from the separate private-stdin fixture.
    p=tmp_path/'older';p.mkdir()
    workspace,store,_=setup_local(p,monkeypatch)
    row=deepcopy(store.snapshot()['intervals']['record1'])
    row.update(evidence_id='legacy-paper',paper_row_id='old',scene='->',
               provenance={'origin':'imported_paper_transcription','record_id':'old'},
               raw_cells={'raw_row':{'scene_raw':'->'}})
    store.put_candidate(row,expected_revision=1)
    data=call(workspace,{'action':'read','project_id':'p'})['data']
    old=next(r for r in data['candidates'] if r['evidence_id']=='legacy-paper')
    assert old['review_context']['descriptor_state']=='prepared'
    assert old['review_context']['blocked_reason']==PAUSE_REASON
    before=store.path.read_bytes()
    assert call(workspace,request_for({'candidates':[old]}))['error']['code']==PAUSE_REASON
    assert store.path.read_bytes()==before and not store.read_model()['confirmed_intervals']
