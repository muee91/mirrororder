from types import SimpleNamespace
import pytest
from test_paper_header_selection import context
from script_organizer.paper_draft_ipc import dispatch,validate
from script_organizer.source_descriptor_receipt import _digest

def test_real_dispatch_store_not_header_mock(context):
    store,paper,_,args,_=context
    config=SimpleNamespace(output_dir=paper.path.parent)
    common=dict(project_id='p')
    before=dispatch(dict(action='header_context',**common),store.drafts,project_config=config)
    assert before['selection_revision']==0 and before['paper_revision']==1
    saved=dispatch(dict(action='header_select',**common,**args),store.drafts,project_config=config)
    assert saved['header_digest']==_digest(saved['header']) and saved['interval_confirmed'] is False
    reloaded=dispatch(dict(action='header_read',**common,header_id=saved['header']['header_id'],expected_selection_revision=1,expected_paper_revision=1),store.drafts,project_config=config)
    assert reloaded==saved

def test_no_path_actor_or_client_authority(context):
    store,_,_,args,_=context
    good=dict(action='header_select',project_id='p',**args)
    for key in ('actor','path','current_source_verified','pdf_sha256','authority','workspace'):
        with pytest.raises(ValueError):validate({**good,key:True})
    with pytest.raises(ValueError):dispatch(good,store.drafts)
    with pytest.raises(ValueError):dispatch({**good,'project_id':'other'},store.drafts,project_config=object())

def test_bad_revisions(context):
    _,_,_,args,_=context
    for value in (True,-1,'1'):
        with pytest.raises(ValueError):validate(dict(action='header_select',project_id='p',**{**args,'expected_selection_revision':value}))
