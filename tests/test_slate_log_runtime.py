import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from script_organizer.slate_log_intake import prepare_project_request


def rows():
    return [{'scene':'02A','shot':'02','take':'003','filename':'A001.mov','page':'p1','row':'1','text':'02A 02 003'}]


def body(values=None):
    return {'mode':'structured_slate_log.v1','format':'json','content':json.dumps(rows() if values is None else values)}


def index():
    return {'clips':[{'clip_id':'c1','media_id':'M_1','name':'card-A/A001.mov','camera':'A'},
                     {'clip_id':'c2','media_id':'M_2','name':'card-A/A003.mov','camera':'A'}]}


class ProjectBoundaryTests(unittest.TestCase):
    def test_no_sequence_matching_aborted_take_or_same_count_wrong_order(self):
        a=rows()[0]; b={**a,'filename':'A003.mov','take':'004','row':'2'}
        for values in [[a,b],[b,a]]:
            r=prepare_project_request(body(values),index(),{})
            self.assertEqual({p['fields']['take']:p['attachments'][0]['media_id'] for p in r['ready']},{'003':'M_1','004':'M_2'})
        b['filename']='A002.mov'
        self.assertEqual(len(prepare_project_request(body([a,b]),index(),{})['unresolved']),1)

    def test_duplicate_across_cards_requires_known_discriminator(self):
        inv=index(); inv['clips'][1].update(name='card-B/A001.mov',camera='B')
        self.assertFalse(prepare_project_request(body(),inv,{})['ready'])
        a=rows()[0]; a['camera']='B'
        self.assertEqual(prepare_project_request(body([a]),inv,{})['ready'][0]['attachments'][0]['media_id'],'M_2')

    def test_duplicate_clip_id_different_media_is_not_deduplicated(self):
        inv=index(); inv['clips'][1]['clip_id']='c1'
        self.assertFalse(prepare_project_request(body(),inv,{})['ready'])

    def test_duplicate_primary_occurrence_not_silently_collapsed(self):
        inv=index();inv['clips'].append(dict(inv['clips'][0]))
        self.assertFalse(prepare_project_request(body(),inv,{})['ready'])

    def test_identical_index_projection_deduplicated(self):
        inv=index(); inv['groups']=[{'members':[inv['clips'][0]]}]
        self.assertEqual(len(prepare_project_request(body(),inv,{})['ready']),1)

    def test_request_cannot_assert_confirmation_or_inventory(self):
        a=rows()[0]; a['confirmed']=True
        req=body([a]);req['assets']=[{'fake':'ignored'}]
        r=prepare_project_request(req,index(),{})
        self.assertFalse(r['ready'][0]['confirmed'])
        self.assertEqual(r['ready'][0]['fields']['scene'],'02A')

    def test_existing_confirmed_metadata_is_gated_not_overwritten(self):
        board={'revision':4,'records':{'r':{'scene':'03','take_number':3,'attachments':[{'media_id':'M_1'}]}}}
        before=json.dumps(board)
        r=prepare_project_request(body(),index(),board)
        self.assertFalse(r['ready']);self.assertIn('confirmed_conflict:scene',r['unresolved'][0]['reasons'])
        self.assertEqual(json.dumps(board),before)

    def test_empty_fields_do_not_take_prior_authority(self):
        a=rows()[0];a['scene']=''
        r=prepare_project_request(body([a]),index(),{'records':{'r':{'scene':'03','attachments':[{'media_id':'M_1'}]}}})
        self.assertEqual(r['unresolved'][0]['fields']['scene'],'')

    def test_algorithmic_group_not_human_confirmation(self):
        a=rows()[0];a.pop('filename');a['confirmed_group_id']='G1'
        inv=index();inv['groups']=[{'group_id':'G1','members':inv['clips']}]
        self.assertFalse(prepare_project_request(body([a]),inv,{})['ready'])

    def test_http_handler_actual_dispatch_backward_compatibility(self):
        from script_organizer import script_supervisor_runtime as runtime, web_server, review_read_model, agent_tools
        project=SimpleNamespace(index=index(),config=SimpleNamespace(output_dir='/no-write'))
        service=SimpleNamespace(project=lambda _:project)
        class Base:
            def _local_only(self): self.local_checked=True
            def _send_json(self,payload): self.sent=payload
        saved=runtime._INSTALLED
        try:
            runtime._INSTALLED=False
            with patch.object(agent_tools.AgentToolRegistry,'inspect_project'), patch.object(agent_tools.AgentToolRegistry,'inspect_take'), patch.object(web_server,'make_handler',return_value=Base), patch.object(web_server,'_body',return_value=body()) as read_body, patch.object(runtime,'ScriptSupervisorStore') as store, patch.object(runtime,'parse_supervisor_text',return_value={'scene':'02A'}) as parse, patch.object(review_read_model,'build_review_read_model'), patch.object(web_server.ProjectService,'state'), patch.object(web_server.WorkspaceService,'capabilities'):
                store.return_value.load.return_value={'revision':0,'records':{}}
                runtime.install_script_supervisor_runtime()
                Handler=web_server.make_handler(service,Path('.'))
                h=Handler();h._app_post(SimpleNamespace(path='/api/v1/projects/demo/script-supervisor-parse'))
                self.assertTrue(h.local_checked);self.assertEqual(h.sent['contract'],'slate_log_proposal.v1')
                self.assertFalse(h.sent['ready'][0]['confirmed']);parse.assert_not_called()
                read_body.return_value={'text':'02A场','allow_model':False}
                h._app_post(SimpleNamespace(path='/api/v1/projects/demo/script-supervisor-parse'))
                self.assertEqual(h.sent['contract'],'script_supervisor_parse.v1');parse.assert_called_once()
                store.return_value.apply_record.assert_not_called()
        finally:
            runtime._INSTALLED=saved


if __name__=='__main__':unittest.main()
