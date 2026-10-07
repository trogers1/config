"""Existing-ticket behavior through the public CLI; httpx only, no Jira/config."""
import copy
from contextlib import redirect_stdout, redirect_stderr
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx
from jira_ticket import cli
from jira_ticket.core import text_adf
from test_create_ticket import Jira


class ExistingJira(Jira):
    def __init__(self):
        super().__init__()
        self.key = 'RI-999'
        self.actual = {'project': {'id': '42', 'key': 'RI', 'name': 'Research'},
                       'issuetype': {'id': '3', 'name': 'Task', 'hierarchyLevel': 0},
                       'status': {'id': '10', 'name': 'Open'}, 'summary': 'Current complete summary',
                       'description': text_adf('Current\n\nfull description'),
                       'assignee': {'accountId': 'existing-assignee', 'displayName': 'Original Assignee'},
                       'reporter': {'accountId': 'existing-reporter', 'displayName': 'Original Reporter'},
                       'customfield_10004': 1.0, 'issuelinks': []}
        self.edit = {f['fieldId']: copy.deepcopy(f) for f in self.fields + [self.estimate]}
        self.estimate_value = 1.0
        self.puts = []
        self.link_posts = []
        self.failure = None
        self.readback_mismatch = None
        self.omitted_drift = False
        self.assignable = True
        self.active = True
        self.edit_shape = None
        self.required_transition = False
        self.targets = {
            '12': {'id': '12', 'key': 'OTHER-12', 'fields': {'summary': 'Cross-project target', 'project': {'id': '88'}}},
            '13': {'id': '13', 'key': 'RI-13', 'fields': {'summary': 'Second target', 'project': {'id': '42'}}},
            '444': {'id': '444', 'key': 'RI-444', 'fields': {'summary': 'Parent', 'project': {'id': '42'}, 'issuetype': {'id': '1', 'hierarchyLevel': 1}}}}
        self.link_catalog = {'issueLinkTypes': [{'id': '100', 'name': 'Blocks', 'inward': 'is blocked by', 'outward': 'blocks'}]}

    def handle(self, request):
        path = request.url.path.removeprefix('/rest/api/3/')
        if request.url.path.startswith('/rest/agile/1.0/'):
            path = 'agile/' + request.url.path.removeprefix('/rest/agile/1.0/')
        method = request.method
        # Record here only the endpoints this service implements; super records others.
        if path in ('project/42', 'project/RI', 'project/88', 'project/OTHER'):
            self.requests.append((method, path))
            other = path in ('project/88', 'project/OTHER')
            return httpx.Response(200, json={'id': '88' if other else '42', 'key': 'OTHER' if other else 'RI', 'issueTypes': self.types})
        if path == 'project/88/statuses':
            self.requests.append((method, path))
            return httpx.Response(200, json=[{'id': t['id'], 'statuses': self.statuses} for t in self.types])
        if path == 'issue/999/editmeta':
            self.requests.append((method, path))
            assert method == 'GET' and not request.url.params  # Actual API: no pages!
            return httpx.Response(200, json={'fields': self.edit if self.edit_shape is None else self.edit_shape})
        if path in ('issue/999', 'issue/RI-999', 'issue/OLD-999', 'issue/OTHER-999'):
            self.requests.append((method, path))
            if method == 'PUT':
                assert path == 'issue/999'
                body = json.loads(request.content)
                self.puts.append(body)
                if self.failure == 'put_http':
                    return httpx.Response(400, json={'SECRET': 'server exception'})
                for name, value in body['fields'].items():
                    self.actual[name] = copy.deepcopy(value)
                    if name == 'project':
                        self.actual[name] |= {'key': 'OTHER' if value['id'] == '88' else 'RI'}
                        self.key = self.actual[name]['key'] + '-999'
                if self.failure == 'put_timeout':
                    raise httpx.ReadTimeout('SECRET request', request=request)
                return httpx.Response(204)
            assert method == 'GET'
            if self.failure == 'get_http':
                return httpx.Response(403, json={'SECRET': 'server exception'})
            if self.failure == 'get_timeout':
                raise httpx.ReadTimeout('SECRET', request=request)
            actual = copy.deepcopy(self.actual)
            if self.puts and self.readback_mismatch:
                actual[self.readback_mismatch] = 'Wrong readback'
            if self.puts and self.omitted_drift:
                actual['reporter'] = {'accountId': 'automation-reporter'}
                actual['description'] = text_adf('Automation content')
            return httpx.Response(200, json={'id': '999', 'key': self.key, 'fields': actual, 'SECRET': 'not projected'})
        if path == 'issue/999/transitions':
            self.requests.append((method, path))
            if method == 'GET':
                return httpx.Response(200, json={'transitions': self.transitions})
            assert method == 'POST'
            if self.failure == 'transition_http':
                return httpx.Response(400, json={'SECRET': 'server'})
            self.actual['status'] = {'id': '20', 'name': 'Done'}
            if self.failure == 'transition_timeout':
                raise httpx.ReadTimeout('SECRET', request=request)
            return httpx.Response(204)
        if path == 'agile/issue/999/estimation':
            self.requests.append((method, path))
            assert request.url.params['boardId'] == '5940'
            if method == 'PUT':
                assert isinstance(json.loads(request.content)['value'], str)
                if self.failure == 'estimate_http':
                    return httpx.Response(400, json={'SECRET': 'server'})
                self.estimate_value = float(json.loads(request.content)['value'])
                self.actual['customfield_10004'] = self.estimate_value
                if self.failure == 'estimate_timeout':
                    raise httpx.ReadTimeout('SECRET', request=request)
            if self.failure == 'estimate_get':
                return httpx.Response(404)
            return httpx.Response(200, json={'fieldId': 'wrong' if self.failure == 'estimate_field' else self.board_field,
                                           'value': self.estimate_value})
        if path == 'issueLinkType':
            self.requests.append((method, path))
            assert method == 'GET' and not request.url.params
            return httpx.Response(200, json=self.link_catalog)
        if path.startswith('issue/'):
            ref = path[6:]
            target = self.targets.get(ref) or next((v for v in self.targets.values() if v['key'] == ref), None)
            if target:
                self.requests.append((method, path))
                assert method == 'GET'
                return httpx.Response(200, json=target)
        if path == 'issueLink':
            self.requests.append((method, path))
            assert method == 'POST'
            body = json.loads(request.content)
            self.link_posts.append(body)
            if self.failure == 'link_http':
                return httpx.Response(400, json={'SECRET': 'server'})
            outward = body['inwardIssue']['id'] == '999'
            target_id = body['outwardIssue' if outward else 'inwardIssue']['id']
            target = self.targets[target_id]
            self.actual['issuelinks'].append({'type': body['type'], ('outward' if outward else 'inward') + 'Issue': {'id': target_id, 'key': target['key']}})
            if self.failure == 'link_timeout':
                raise httpx.ReadTimeout('SECRET uncertain link', request=request)
            return httpx.Response(201)
        if path == 'user/assignable/search':
            self.requests.append((method, path))
            return httpx.Response(200, json=[{'accountId': request.url.params['accountId'], 'active': True}] if self.assignable else [])
        if path == 'user':
            self.requests.append((method, path))
            return httpx.Response(200, json={'accountId': request.url.params['accountId'], 'active': self.active})
        if path == 'issuetype/4':
            self.requests.append((method, path))
            return httpx.Response(200, json={'id': '4', 'hierarchyLevel': -1})
        assert not (method == 'POST' and path == 'issue'), 'Updates must NEVER create an issue'
        return super().handle(request)


class ExistingCliTests(unittest.TestCase):
    def setUp(self):
        self.jira = ExistingJira()
        self.config = SimpleNamespace(default_project_key_or_id=None, jira_base_url='https://browser.example', jira_api_base_url='https://jira.example')
        self.directory = TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'partial draft.json'
        self.links = [{'type': 'Blocks', 'direction': 'outward', 'issue': 'OTHER-12'},
                      {'type': '100', 'direction': 'inward', 'issue': 'RI-13'}]

    def invoke(self, draft=None, *, command='update', issue='RI-999', dry=False, raw=None):
        args = [command, issue]
        if command == 'update':
            self.path.write_text(raw if raw is not None else json.dumps(draft), encoding='utf-8')
            args.extend(['--draft', str(self.path)])
            if dry:
                args.append('--dry-run')
        output = io.StringIO()
        client = httpx.Client(base_url='https://jira.example/', transport=httpx.MockTransport(self.jira.handle))
        with patch.object(cli, 'configuration', return_value=self.config), patch.object(cli, 'client_for', return_value=client), redirect_stdout(output):
            code = cli.main(args)
        result = json.loads(output.getvalue())
        self.assertNotIn('SECRET', output.getvalue())
        self.assertNotIn(('POST', 'issue'), self.jira.requests)
        return code, result

    def assert_read_only(self):
        self.assertTrue(all(m == 'GET' for m, _ in self.jira.requests))

    def test_get_key_id_and_alias_returns_canonical_complete_context(self):
        self.jira.actual['parent'] = {'id': '444', 'key': 'RI-444'}
        self.jira.actual['issuelinks'] = [{'type': self.jira.link_catalog['issueLinkTypes'][0], 'outwardIssue': self.jira.targets['12']}]
        for reference in ('RI-999', '999', 'OLD-999'):
            code, result = self.invoke(command='get', issue=reference)
            self.assertEqual((code, result['outcome']), (0, 'issue'))
            self.assertEqual(result['id'], '999')
            self.assertEqual(result['key'], 'RI-999')
            self.assertEqual(result['link'], 'https://browser.example/browse/RI-999')
            details = result['details']
            self.assertEqual(set(details), {'summary', 'description', 'project', 'type', 'status', 'assignee', 'reporter', 'parent', 'story_points', 'links'})
            self.assertEqual(details['description'], self.jira.actual['description'])
            self.assertEqual(details['story_points'], 1)
            self.assertEqual(details['links'][0]['direction'], 'outward')
            self.assertEqual(details['links'][0]['issue'], {'id': '12', 'key': 'OTHER-12'})
        self.assert_read_only()

    def test_offline_help_and_update_example(self):
        for args in ([], ['--help'], ['get', '--help'], ['update', '--help'], ['draft-example', '--help'], ['draft-example', '--update']):
            output = io.StringIO()
            with patch.object(cli, 'configuration') as config, patch.object(cli, 'client_for') as client, redirect_stdout(output), redirect_stderr(output):
                if '--help' in args:
                    with self.assertRaises(SystemExit) as raised:
                        cli.main(args)
                    self.assertEqual(raised.exception.code, 0)
                else:
                    self.assertEqual(cli.main(args), 0)
            config.assert_not_called()
            client.assert_not_called()
            if args == ['draft-example', '--update']:
                self.assertEqual(set(json.loads(output.getvalue())), {'summary'})
        self.assertEqual(self.jira.requests, [])

    def test_invalid_reference_rejected_before_config(self):
        for command in ('get', 'update'):
            for ref in ('https://SECRET', '../file', 'new', 'RI-1?SECRET', 'RI-1/SECRET', '-1'):
                self.path.write_text('{"summary":"Approved"}', encoding='utf-8')
                args = [command, ref] + (['--draft', str(self.path)] if command == 'update' else [])
                output = io.StringIO()
                with patch.object(cli, 'configuration') as config, redirect_stdout(output):
                    self.assertEqual(cli.main(args), 1)
                config.assert_not_called()
                self.assertNotIn('SECRET', output.getvalue())

    def test_malformed_partial_drafts_fail_before_config(self):
        drafts = [None, [], {}, {'SECRET': 'SECRET'}, {'payload': {}}, {'summary': None}, {'summary': ''},
                  {'summary': 'x' * 256}, {'description': None}, {'description': []}, {'description': '  '},
                  {'description': {'type': 'doc', 'version': 1, 'content': []}},
                  {'type': 3}, {'status': None}, {'project': 'RI/SECRET'}, {'parent': 'placeholder'},
                  {'assignee': None}, {'reporter': ''}, {'board': 5940}, {'board': '5940'},
                  {'story_points': 'unset', 'board': '5940'}, {'story_points': True}, {'story_points': None},
                  {'story_points': '2'}, {'story_points': -1}, {'links': None}, {'links': [{'issue': 'RI-1'}]},
                  {'links': [self.links[0] | {'issue': 'new'}]}, {'links': [self.links[0] | {'direction': 'blocks'}]}]
        for draft in drafts:
            self.path.write_text(json.dumps(draft), encoding='utf-8')
            output = io.StringIO()
            with patch.object(cli, 'configuration') as config, redirect_stdout(output):
                self.assertEqual(cli.main(['update', 'RI-999', '--draft', str(self.path)]), 1)
            config.assert_not_called()
            self.assertNotIn('SECRET', output.getvalue())
        for raw in ('{', '{"summary":"first","summary":"second"}', '{"story_points":NaN}', '{"story_points":1e999}'):
            self.path.write_text(raw, encoding='utf-8')
            with patch.object(cli, 'configuration') as config, redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(['update', '999', '--draft', str(self.path)]), 1)
            config.assert_not_called()
        self.assertEqual(self.jira.requests, [])

    def test_summary_partial_preserves_omitted_fields_no_defaults_or_status_reset(self):
        before = copy.deepcopy(self.jira.actual)
        code, result = self.invoke({'summary': 'Approved changed summary'})
        self.assertEqual((code, result['outcome']), (0, 'updated'))
        self.assertEqual(self.jira.actual, before | {'summary': 'Approved changed summary'})
        self.assertEqual(self.jira.puts, [{'fields': {'summary': 'Approved changed summary'}}])
        self.assertEqual(result['verified_fields'], ['summary'])
        self.assertFalse(any(path in ('myself', 'user', 'user/search', 'user/assignable/search') or path.endswith('/transitions') for _, path in self.jira.requests))
        self.assertIn(('GET', 'issue/999/editmeta'), self.jira.requests)

    def test_verification_compares_only_supplied_fields(self):
        self.jira.omitted_drift = True
        code, result = self.invoke({'summary': 'Approved change'})
        self.assertEqual((code, result['outcome']), (0, 'updated'))
        self.assertEqual(result['verified_fields'], ['summary'])

    def test_unset_empty_links_and_equal_values_are_noop(self):
        for draft in ({'story_points': 'unset'}, {'links': []}, {'story_points': 'unset', 'links': []},
                      {'summary': self.jira.actual['summary']}, {'status': 'Open'},
                      {'assignee': 'id:existing-assignee', 'reporter': 'id:existing-reporter'}):
            with self.subTest(draft=draft):
                code, result = self.invoke(draft)
                self.assertEqual((code, result['outcome']), (0, 'unchanged'))
                self.assertEqual(result['writes'], 0)
                self.assert_read_only()
        self.assertEqual(self.jira.actual['customfield_10004'], 1)
        self.assertNotIn(('GET', 'myself'), self.jira.requests)
        self.assertNotIn(('GET', 'user'), self.jira.requests)
        self.assertNotIn(('GET', 'user/assignable/search'), self.jira.requests)

    def test_literal_description_normalization_and_adf_preservation(self):
        for description in ('# Literal\r\n\r\n**text**\r', {'type': 'doc', 'version': 1, 'content': [{'type': 'heading', 'attrs': {'level': 2}, 'content': [{'type': 'text', 'text': 'Approved', 'marks': [{'type': 'strong'}]}]}]}):
            code, result = self.invoke({'description': description})
            self.assertEqual((code, result['outcome']), (0, 'updated'))
            expected = text_adf('# Literal\n\n**text**\n') if isinstance(description, str) else description
            self.assertEqual(self.jira.actual['description'], expected)
            self.assertEqual(self.jira.puts[-1], {'fields': {'description': expected}})

    def test_explicit_identities_and_exact_name_are_verified_no_myself(self):
        self.jira.users = [{'accountId': 'new-assignee', 'displayName': 'A Person', 'active': True}]
        code, result = self.invoke({'assignee': 'A Person', 'reporter': 'id:new-reporter'})
        self.assertEqual((code, result['outcome']), (0, 'updated'))
        self.assertEqual(self.jira.puts[0], {'fields': {'assignee': {'accountId': 'new-assignee'}, 'reporter': {'accountId': 'new-reporter'}}})
        self.assertNotIn(('GET', 'myself'), self.jira.requests)
        self.assertEqual(self.jira.requests.count(('GET', 'user/assignable/search')), 1)

    def test_identity_inactive_ambiguous_unassignable_and_allowed_values_fail(self):
        for failure in ('inactive', 'ambiguous', 'unassignable', 'allowed'):
            self.jira = ExistingJira()
            draft = {'assignee': 'id:new'}
            if failure == 'inactive':
                self.jira.active = False
            elif failure == 'ambiguous':
                self.jira.users = [{'accountId': '1', 'displayName': 'Same'}, {'accountId': '2', 'displayName': 'Same'}]
                draft = {'reporter': 'Same'}
            elif failure == 'unassignable':
                self.jira.assignable = False
            else:
                self.jira.edit['assignee']['allowedValues'] = [{'accountId': 'another'}]
            code, result = self.invoke(draft)
            self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
            self.assert_read_only()

    def test_inline_points_exact_catalog_zero_and_unwritable_wrong_schema(self):
        code, result = self.invoke({'story_points': 0})
        self.assertEqual((code, result['outcome']), (0, 'updated'))
        self.assertEqual(self.jira.puts[0], {'fields': {'customfield_10004': 0}})
        self.assertFalse(any(p.startswith('agile/') for _, p in self.jira.requests))
        for failure in ('catalog', 'schema', 'board_inline'):
            self.jira = ExistingJira()
            draft = {'story_points': 2}
            if failure == 'catalog':
                self.jira.catalog[0]['id'] = 'customfield_14308'
            elif failure == 'schema':
                self.jira.edit['customfield_10004']['schema']['type'] = 'string'
            else:
                draft['board'] = '5940'
            code, result = self.invoke(draft, dry=True)
            self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
            self.assert_read_only()

    def test_agile_fallback_verified_during_preflight_and_applied_before_status(self):
        del self.jira.edit['customfield_10004']
        code, plan = self.invoke({'story_points': 2.5, 'status': 'Done'}, dry=True)
        self.assertEqual((code, plan['outcome']), (0, 'dry_run'))
        self.assertEqual(plan['estimate']['board_id'], '5940')
        self.assertEqual(plan['payload'], {'fields': {}})
        self.assertEqual(plan['transition']['id'], '7')
        self.assertIn(('GET', 'agile/issue/999/estimation'), self.jira.requests)
        self.assertIn(('GET', 'issue/999/transitions'), self.jira.requests)
        self.assert_read_only()
        self.jira.requests.clear()
        code, result = self.invoke({'story_points': 2.5, 'status': 'Done'})
        self.assertEqual((code, result['outcome']), (0, 'updated'))
        self.assertEqual(self.jira.actual['customfield_10004'], 2.5)
        self.assertLess(self.jira.requests.index(('PUT', 'agile/issue/999/estimation')), self.jira.requests.index(('POST', 'issue/999/transitions')))

    def test_agile_board_membership_wrong_field_disagreement_or_ambiguity_prevents_all_writes(self):
        for failure in ('estimate_get', 'estimate_field', 'disagreement', 'board', 'ambiguous'):
            self.jira = ExistingJira()
            self.jira.edit['customfield_10004']['operations'] = []
            if failure in ('estimate_get', 'estimate_field'):
                self.jira.failure = failure
            elif failure == 'disagreement':
                self.jira.estimate_value = 99
            elif failure == 'board':
                self.jira.board_field = 'customfield_14308'
            else:
                self.jira.boards.append({'id': 5941})
            code, result = self.invoke({'summary': 'Approved change', 'story_points': 2, 'status': 'Done'})
            self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
            self.assert_read_only()

    def test_editmeta_is_unpaginated_dict_required_existing_values_respected(self):
        self.jira.actual['unsupported_required'] = 'Keep existing value'
        self.jira.edit['unsupported_required'] = {'required': True}
        code, result = self.invoke({'summary': 'Approved change'})
        self.assertEqual((code, result['outcome']), (0, 'updated'))
        self.assertNotIn('unsupported_required', self.jira.puts[0]['fields'])
        self.jira.actual['unsupported_required'] = None
        self.jira.requests.clear()
        code, result = self.invoke({'summary': 'Another change'})
        self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
        self.assert_read_only()
        self.jira.edit_shape = []
        code, result = self.invoke({'summary': 'Another change'})
        self.assertEqual(code, 1)
        self.assert_read_only()

    def test_schema_set_operations_allowed_values_fail_closed(self):
        for field in ({'schema': {'type': 'number'}, 'operations': ['set']},
                      {'schema': {'type': 'string'}, 'operations': []},
                      {'schema': {'type': 'string'}},
                      {'schema': {'type': 'string'}, 'operations': ['set'], 'allowedValues': []},
                      {'schema': {'type': 'string'}, 'operations': ['set'], 'allowedValues': ['different']}):
            self.jira.edit['summary'] = field
            code, result = self.invoke({'summary': 'Approved change'})
            self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
            self.assert_read_only()

    def test_parent_supported_and_rejects_wrong_project_hierarchy_self_or_screen(self):
        code, result = self.invoke({'parent': 'RI-444'})
        self.assertEqual((code, result['outcome']), (0, 'updated'))
        self.assertEqual(self.jira.puts[0], {'fields': {'parent': {'id': '444'}}})
        for failure in ('project', 'hierarchy', 'self', 'screen'):
            self.jira = ExistingJira()
            if failure == 'project':
                self.jira.targets['444']['fields']['project']['id'] = '88'
            elif failure == 'hierarchy':
                self.jira.targets['444']['fields']['issuetype']['hierarchyLevel'] = 0
            elif failure == 'self':
                self.jira.targets['444']['id'] = '999'
            else:
                self.jira.edit['parent']['operations'] = []
            code, result = self.invoke({'summary': 'Approved change', 'parent': '444'})
            self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
            self.assert_read_only()

    def test_project_and_type_supported_edit_only_and_canonical_id_after_key_change(self):
        self.jira.types.append({'id': '4', 'name': 'Sub-task', 'subtask': True})
        # A subtask's immediate parent is the current standard ticket type.
        self.jira.targets['444']['fields']['issuetype']['hierarchyLevel'] = 0
        self.jira.targets['444']['fields']['project']['id'] = '88'
        code, result = self.invoke({'project': 'OTHER', 'type': 'Sub-task', 'parent': '444', 'status': 'Done', 'links': self.links})
        self.assertEqual((code, result['outcome']), (0, 'updated'))
        self.assertEqual(result['key'], 'OTHER-999')
        self.assertEqual(result['link'], 'https://browser.example/browse/OTHER-999')
        self.assertEqual(self.jira.puts[0]['fields'], {'project': {'id': '88'}, 'issuetype': {'id': '4'}, 'parent': {'id': '444'}})
        self.assertIn(('POST', 'issue/999/transitions'), self.jira.requests)
        self.assertTrue(all('RI-999' not in p and 'OTHER-999' not in p for _, p in self.jira.requests[1:]))
        self.assertEqual(self.jira.link_posts[0]['inwardIssue'], {'id': '999'})
        self.assertEqual(result['links'][0]['relationship'], 'OTHER-999 blocks OTHER-12')

    def test_project_or_type_unsupported_moves_fail_preflight_not_ad_hoc_api(self):
        for field, draft in (('project', {'project': 'OTHER'}), ('issuetype', {'type': 'Task'})):
            self.jira = ExistingJira()
            self.jira.edit[field]['operations'] = []
            code, result = self.invoke(draft)
            self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
            self.assert_read_only()
        self.jira = ExistingJira()
        code, result = self.invoke({'type': 'Imaginary'})
        self.assertEqual(code, 1)
        self.assert_read_only()

    def test_current_parent_consistency_for_project_or_type_changes_and_omitted_status(self):
        for draft in ({'project': 'OTHER'}, {'type': 'Sub-task'}):
            self.jira = ExistingJira()
            self.jira.actual['parent'] = {'id': '444', 'key': 'RI-444'}
            self.jira.types.append({'id': '4', 'name': 'Sub-task', 'subtask': True})
            code, result = self.invoke(draft)
            self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
            self.assert_read_only()
        self.jira = ExistingJira()
        self.jira.statuses = [{'id': '20', 'name': 'Done'}]
        code, result = self.invoke({'project': 'OTHER'})
        self.assertEqual(code, 1)
        self.assertIn('omitted current status', result['message'])
        self.assert_read_only()

    def test_missing_parent_for_resulting_subtask_prevents_mutation(self):
        self.jira.types.append({'id': '4', 'name': 'Sub-task', 'subtask': True})
        code, result = self.invoke({'type': 'Sub-task'})
        self.assertEqual(code, 1)
        self.assert_read_only()

    def test_status_ambiguity_missing_required_fields_or_wrong_live_type_fail_before_edit(self):
        for failure in ('ambiguous', 'missing', 'required', 'status', 'status_ambiguous'):
            self.jira = ExistingJira()
            if failure == 'ambiguous':
                self.jira.transitions.append({'id': '8', 'to': {'id': '20'}})
            elif failure == 'missing':
                self.jira.transitions = []
            elif failure == 'required':
                self.jira.transitions[0]['fields'] = {'resolution': {'required': True}}
            elif failure == 'status':
                self.jira.statuses = [{'id': '10', 'name': 'Open'}]
            else:
                self.jira.statuses.append({'id': '21', 'name': 'Done'})
            code, result = self.invoke({'summary': 'Approved change', 'status': 'Done', 'links': self.links})
            self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
            self.assert_read_only()

    def test_all_dryruns_read_only_actionable_context_and_full_plan(self):
        drafts = [{'summary': 'Approved change', 'description': 'Complete description', 'assignee': 'id:new', 'reporter': 'id:newreporter', 'story_points': 3, 'parent': '444', 'status': 'Done', 'links': self.links},
                  {'project': 'OTHER'}, {'story_points': 'unset'}, {'links': []}]
        for draft in drafts:
            code, plan = self.invoke(draft, dry=True)
            self.assertEqual((code, plan['outcome']), (0, 'dry_run'))
            self.assertTrue(plan['read_only'])
            self.assertEqual(plan['current']['summary'], 'Current complete summary')
            self.assertEqual(plan['current']['assignee']['accountId'], 'existing-assignee')
            self.assertEqual(plan['id'], '999')
            self.assertIn('payload', plan)
            self.assertIn('requested_status', plan)
            self.assert_read_only()

    def test_links_add_only_orientation_dedup_and_readback(self):
        self.jira.actual['issuelinks'] = [{'type': {'id': '100'}, 'outwardIssue': {'id': '12', 'key': 'OTHER-12'}}]
        code, result = self.invoke({'links': self.links})
        self.assertEqual((code, result['outcome']), (0, 'updated'))
        self.assertEqual([v['status'] for v in result['links']], ['verified', 'verified'])
        self.assertEqual(self.jira.link_posts, [{'type': {'id': '100'}, 'inwardIssue': {'id': '13'}, 'outwardIssue': {'id': '999'}}])
        self.assertEqual(self.jira.puts, [])
        self.jira.requests.clear()
        code, result = self.invoke({'links': self.links})
        self.assertEqual((code, result['outcome']), (0, 'unchanged'))
        self.assert_read_only()

    def test_selflink_anywhere_and_canonical_duplicates_prevent_all_writes(self):
        for links in ([self.links[0], self.links[1] | {'issue': '999'}],
                      [self.links[0], self.links[0] | {'type': '100', 'issue': '12'}]):
            code, result = self.invoke({'summary': 'Approved change', 'links': links})
            self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
            self.assert_read_only()

    def test_mutation_failures_partial_known_identity_uncertain_and_stop(self):
        for failure, failed_step, draft, mutation in (
                ('put_timeout', 'field_update', {'summary': 'Approved', 'story_points': 2, 'status': 'Done', 'links': self.links}, ('PUT', 'issue/999')),
                ('put_http', 'field_update', {'summary': 'Approved', 'status': 'Done', 'links': self.links}, ('PUT', 'issue/999')),
                ('estimate_timeout', 'estimate_update', {'story_points': 2, 'status': 'Done', 'links': self.links}, ('PUT', 'agile/issue/999/estimation')),
                ('estimate_http', 'estimate_update', {'story_points': 2, 'status': 'Done', 'links': self.links}, ('PUT', 'agile/issue/999/estimation')),
                ('transition_timeout', 'status_transition', {'status': 'Done', 'links': self.links}, ('POST', 'issue/999/transitions')),
                ('transition_http', 'status_transition', {'status': 'Done', 'links': self.links}, ('POST', 'issue/999/transitions')),
                ('link_timeout', 'link_update', {'links': self.links}, ('POST', 'issueLink')),
                ('link_http', 'link_update', {'links': self.links}, ('POST', 'issueLink'))):
            with self.subTest(failure=failure):
                self.jira = ExistingJira()
                self.jira.failure = failure
                if failure.startswith('estimate'):
                    del self.jira.edit['customfield_10004']
                code, result = self.invoke(draft)
                self.assertEqual((code, result['outcome']), (1, 'partial_failure'))
                self.assertEqual(result['id'], '999')
                self.assertEqual(result['key'], 'RI-999')
                self.assertEqual(result['link'], 'https://browser.example/browse/RI-999')
                self.assertEqual(result['failed_step'], failed_step)
                self.assertEqual(result['uncertain_operation'], failed_step)
                self.assertIn(failed_step, result['remaining_action'])
                self.assertEqual(self.jira.requests.count(mutation), 1)
                self.assertEqual([r for r in self.jira.requests if r[0] != 'GET'], [mutation])
                self.assertEqual([v['status'] for v in result['links']], ['unverified', 'pending'] if failure.startswith('link') else ['pending', 'pending'])

    def test_put_timeout_project_move_refreshes_key_readonly_no_later_writes(self):
        self.jira.failure = 'put_timeout'
        code, result = self.invoke({'project': 'OTHER', 'status': 'Done', 'links': self.links})
        self.assertEqual((code, result['outcome']), (1, 'partial_failure'))
        self.assertEqual(result['key'], 'OTHER-999')
        self.assertEqual(result['link'], 'https://browser.example/browse/OTHER-999')
        self.assertEqual([r for r in self.jira.requests if r[0] != 'GET'], [('PUT', 'issue/999')])

    def test_field_verification_failure_stops_estimate_status_links(self):
        self.jira.readback_mismatch = 'summary'
        code, result = self.invoke({'summary': 'Approved', 'status': 'Done', 'links': self.links})
        self.assertEqual((code, result['outcome']), (1, 'partial_failure'))
        self.assertEqual(result['failed_step'], 'field_verification')
        self.assertEqual([v['status'] for v in result['links']], ['pending', 'pending'])
        self.assertEqual([r for r in self.jira.requests if r[0] != 'GET'], [('PUT', 'issue/999')])

    def test_transition_revalidation_after_edit_fail_closed_and_partial(self):
        original = self.jira.handle
        def changed(request):
            response = original(request)
            if request.method == 'PUT' and request.url.path == '/rest/api/3/issue/999':
                self.jira.transitions = [{'id': '8', 'to': {'id': '20'}}]
            return response
        with patch.object(self.jira, 'handle', side_effect=changed):
            code, result = self.invoke({'summary': 'Approved', 'status': 'Done', 'links': self.links})
        self.assertEqual((code, result['outcome']), (1, 'partial_failure'))
        self.assertEqual(result['failed_step'], 'transition_recheck')
        self.assertEqual([r for r in self.jira.requests if r[0] != 'GET'], [('PUT', 'issue/999')])

    def test_each_update_invocation_revalidates_not_cached_dryrun(self):
        code, result = self.invoke({'summary': 'Approved'}, dry=True)
        self.assertEqual(code, 0)
        self.jira.edit['summary']['operations'] = []
        code, result = self.invoke({'summary': 'Approved'})
        self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
        self.assert_read_only()

    def test_estimate_and_status_readback_mismatch_stop_before_links(self):
        for failure in ('estimate', 'status'):
            self.jira = ExistingJira()
            if failure == 'estimate':
                del self.jira.edit['customfield_10004']
            original = self.jira.handle
            def mismatch(request):
                response = original(request)
                if request.method == 'PUT' and '/estimation' in request.url.path:
                    self.jira.actual['customfield_10004'] = 99
                if request.method == 'POST' and '/transitions' in request.url.path:
                    self.jira.actual['status'] = {'id': '10', 'name': 'Open'}
                return response
            draft = {'story_points': 2, 'status': 'Done', 'links': self.links} if failure == 'estimate' else {'status': 'Done', 'links': self.links}
            with patch.object(self.jira, 'handle', side_effect=mismatch):
                code, result = self.invoke(draft)
            self.assertEqual((code, result['outcome']), (1, 'partial_failure'))
            self.assertEqual(result['failed_step'], 'estimate_verification' if failure == 'estimate' else 'status_verification')
            self.assertEqual([v['status'] for v in result['links']], ['pending', 'pending'])
            self.assertEqual(self.jira.link_posts, [])
            if failure == 'estimate':
                self.assertNotIn(('POST', 'issue/999/transitions'), self.jira.requests)

    def test_link_wrong_orientation_or_failed_readback_is_unverified(self):
        for failure in ('type', 'direction', 'target_id', 'target_key', 'missing', 'http'):
            self.jira = ExistingJira()
            original = self.jira.handle
            def mismatch(request):
                response = original(request)
                if request.method == 'POST' and request.url.path.endswith('/issueLink'):
                    entry = self.jira.actual['issuelinks'][-1]
                    if failure == 'type':
                        entry['type'] = {'id': '101'}
                    elif failure == 'direction':
                        entry['inwardIssue'] = entry.pop('outwardIssue')
                    elif failure == 'target_id':
                        entry['outwardIssue']['id'] = '777'
                    elif failure == 'target_key':
                        entry['outwardIssue']['key'] = 'WRONG-1'
                if self.jira.link_posts and request.url.params.get('fields') == 'issuelinks':
                    if failure == 'http':
                        return httpx.Response(500, json={'SECRET': 'server'})
                    if failure == 'missing':
                        return httpx.Response(200, json={'id': '999', 'key': self.jira.key, 'fields': {}})
                return response
            with patch.object(self.jira, 'handle', side_effect=mismatch):
                code, result = self.invoke({'links': self.links})
            self.assertEqual((code, result['outcome']), (1, 'partial_failure'))
            self.assertEqual(result['failed_step'], 'link_verification')
            self.assertEqual([v['status'] for v in result['links']], ['unverified', 'pending'])
            self.assertEqual(len(self.jira.link_posts), 1)
            self.assertIn('RI-999 blocks OTHER-12 [unverified]', result['remaining_action'])

    def test_second_link_failure_preserves_first_verified_and_third_pending(self):
        original = self.jira.handle
        def second_timeout(request):
            if request.method == 'POST' and request.url.path.endswith('/issueLink') and len(self.jira.link_posts) == 1:
                self.jira.failure = 'link_timeout'
            return original(request)
        links = self.links + [self.links[1] | {'direction': 'outward'}]
        with patch.object(self.jira, 'handle', side_effect=second_timeout):
            code, result = self.invoke({'links': links})
        self.assertEqual((code, result['outcome']), (1, 'partial_failure'))
        self.assertEqual([v['status'] for v in result['links']], ['verified', 'unverified', 'pending'])
        self.assertEqual(len(self.jira.link_posts), 2)
        self.assertIn('RI-999 is blocked by RI-13 [unverified]', result['remaining_action'])

    def test_missing_existing_links_prevents_all_mutations_during_preflight(self):
        self.jira.actual['issuelinks'] = None
        code, result = self.invoke({'summary': 'Approved', 'links': self.links})
        self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
        self.assert_read_only()

    def test_agile_verified_board_override_and_equal_estimate_are_noop(self):
        del self.jira.edit['customfield_10004']
        self.jira.boards.append({'id': 5941, 'name': 'Second board'})
        code, result = self.invoke({'story_points': 1, 'board': '5940'})
        self.assertEqual((code, result['outcome']), (0, 'unchanged'))
        self.assert_read_only()
        code, result = self.invoke({'story_points': 2, 'board': '9999'})
        self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
        self.assert_read_only()

    def test_noop_or_status_only_does_not_fill_required_edit_fields(self):
        self.jira.edit['unsupported_required'] = {'required': True}
        for draft in ({'story_points': 'unset'}, {'links': []}, {'status': 'Done'}):
            code, result = self.invoke(draft)
            self.assertEqual(code, 0)
            self.assertEqual(result['outcome'], 'updated' if 'status' in draft else 'unchanged')
            self.assertEqual(self.jira.puts, [])

    def test_get_errors_safely_redacted_and_readonly(self):
        for failure in ('get_http', 'get_timeout'):
            self.jira.failure = failure
            code, result = self.invoke(command='get')
            self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
            self.assert_read_only()
        with patch.object(cli, 'configuration', side_effect=ValueError('SECRET config')), redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cli.main(['get', '999']), 1)
        self.assertNotIn('SECRET', output.getvalue())


if __name__ == '__main__':
    unittest.main()
