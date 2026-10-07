"""Behavioral tests: in-memory Jira HTTP service, no network or real config."""
import copy
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout

import httpx
from jira_ticket.core import Creator, Failure, client_for, text_adf
from jira_ticket import cli


class Jira:
    def __init__(self):
        self.requests = []
        self.types = [{'id': '3', 'name': 'Task', 'subtask': False}]
        self.statuses = [{'id': '10', 'name': 'Open'}, {'id': '20', 'name': 'Done'}]
        schemas = {'project': 'project', 'issuetype': 'issuetype', 'summary': 'string',
                   'description': 'string', 'assignee': 'user', 'reporter': 'user', 'parent': 'issuelink'}
        self.fields = [{'fieldId': k, 'schema': {'type': v}, 'required': k != 'parent', 'operations': ['set']} for k, v in schemas.items()]
        # Estimates deliberately only appear on the second metadata page.
        self.estimate = {'fieldId': 'customfield_10004', 'schema': {'type': 'number'}, 'operations': ['set']}
        self.catalog = [{'id': 'customfield_10004', 'name': 'Story Points Estimates', 'schema': {'type': 'number'}},
                        {'id': 'customfield_14308', 'name': 'Story point estimate', 'schema': {'type': 'number'}}]
        self.transitions = [{'id': '7', 'to': {'id': '20'}}]
        self.transition_error = False
        self.create_timeout = False
        self.users = []
        self.actual = None
        self.parent_project = '42'
        self.parent_level = 1
        self.boards = [{'id': 5940, 'name': 'RI board', 'type': 'scrum'}]
        self.board_field = 'customfield_10004'
        self.board_name = 'Story Points Estimates'
        self.estimate_error = None
        self.estimate_value = None

    def handle(self, request):
        path = request.url.path.removeprefix('/rest/api/3/')
        if request.url.path.startswith('/rest/agile/1.0/'):
            path = 'agile/' + request.url.path.removeprefix('/rest/agile/1.0/')
        self.requests.append((request.method, path))
        data = None
        if path == 'agile/board':
            assert request.url.params['projectKeyOrId'] == 'RI'
            start = int(request.url.params['startAt'])
            page = self.boards[start:start + 1]
            data = {'values': page, 'isLast': start + len(page) >= len(self.boards)}
        elif path.startswith('agile/board/') and path.endswith('/configuration'):
            data = {'estimation': {'type': 'field', 'field': {'fieldId': self.board_field, 'displayName': self.board_name}}}
        elif path == 'agile/issue/RI-999/estimation':
            assert request.url.params['boardId'] in [str(b['id']) for b in self.boards]
            if request.method == 'PUT':
                if self.estimate_error == 'put':
                    return httpx.Response(400, json={'secret': 'private server response'})
                if self.estimate_error == 'timeout':
                    raise httpx.ReadTimeout('secret token', request=request)
                body = json.loads(request.content)
                assert isinstance(body['value'], str)
                self.estimate_value = float(body['value'])
                self.actual['customfield_10004'] = self.estimate_value
            elif self.estimate_error == 'get':
                return httpx.Response(404)
            value = self.estimate_value
            if value is not None and self.estimate_error == 'readback':
                value += 1
            data = {'fieldId': 'wrong' if self.estimate_error == 'field' else self.board_field, 'value': value}
        elif path == 'project/RI':
            data = {'id': '42', 'key': 'RI'}
        elif path == 'issue/createmeta/42/issuetypes':
            data = {'issueTypes': self.types, 'total': len(self.types)}
        elif path == 'project/42/statuses':
            data = [{'id': t['id'], 'statuses': self.statuses} for t in self.types]
        elif path.startswith('issue/createmeta/42/issuetypes/'):
            second = int(request.url.params['startAt']) > 0
            data = {'fields': [self.estimate] if second and self.estimate else [] if second else self.fields,
                    'isLast': second}
        elif path == 'field':
            data = self.catalog
        elif path == 'myself':
            data = {'accountId': 'me', 'active': True}
        elif path == 'user/assignable/search':
            data = [{'accountId': request.url.params['accountId']}]
        elif path == 'user/search':
            data = self.users
        elif path == 'user':
            data = {'accountId': request.url.params['accountId'], 'active': True}
        elif path == 'issuetype/3':
            data = {'hierarchyLevel': 0}
        elif path == 'issue/RI-444':
            data = {'id': '444', 'fields': {'project': {'id': self.parent_project}, 'issuetype': {'hierarchyLevel': self.parent_level}}}
        elif path == 'issue' and request.method == 'POST':
            if self.create_timeout:
                raise httpx.ReadTimeout('secret token should never be printed', request=request)
            self.actual = json.loads(request.content)['fields']
            self.actual['status'] = {'id': '10'}
            data = {'key': 'RI-999', 'id': '999'}
        elif path == 'issue/RI-999':
            data = {'fields': self.actual}
        elif path == 'issue/RI-999/transitions':
            if request.method == 'GET':
                data = {'transitions': self.transitions}
            elif self.transition_error:
                return httpx.Response(400, json={'secret': 'credential-bearing server error'})
            else:
                self.actual['status'] = {'id': '20'}
                return httpx.Response(204)
        else:
            raise AssertionError((request.method, path))
        return httpx.Response(200, json=data)


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.jira = Jira()
        self.client = httpx.Client(base_url='https://jira.example/', transport=httpx.MockTransport(self.jira.handle))
        self.addCleanup(self.client.close)
        self.creator = Creator(self.client, 'https://browser.example')
        self.inputs = dict(project='RI', summary='Approved title', description=text_adf('# Heading\n\n- literal **text**\n'),
                           issue_type='Task', status='Done', points='3.5')

    def prepare(self, **changes):
        return self.creator.prepare(**(self.inputs | changes))

    def assert_no_writes(self):
        self.assertTrue(all(method == 'GET' for method, _ in self.jira.requests))

    def test_payload_preserves_identity_type_points_and_description_second_page(self):
        prepared = self.prepare()
        fields = prepared['payload']['fields']
        self.assertEqual(fields['assignee'], {'accountId': 'me'})
        self.assertEqual(fields['reporter'], {'accountId': 'me'})
        self.assertEqual(fields['issuetype'], {'id': '3'})
        self.assertEqual(fields['project'], {'id': '42'})
        self.assertEqual(fields['customfield_10004'], 3.5)
        self.assertNotIn('customfield_14308', fields)
        self.assertEqual(fields['description'], self.inputs['description'])
        self.assertEqual(prepared['requested_status']['id'], '20')
        self.assertNotIn('post_create_estimate', prepared)
        self.assertFalse(any(path.startswith('agile/') for _, path in self.jira.requests))
        self.assert_no_writes()

    def test_issuetype_selector_with_no_set_operation_is_valid(self):
        self.jira.fields[1]['operations'] = []
        prepared = self.prepare(points='unset')
        self.assertEqual(prepared['payload']['fields']['issuetype'], {'id': '3'})
        self.assert_no_writes()
        # No set operation on estimates uses the separately verified Agile plan,
        # never an unwritable estimate in the create payload.
        self.jira.estimate['operations'] = []
        prepared = self.prepare()
        self.assertNotIn('customfield_10004', prepared['payload']['fields'])
        self.assertEqual(prepared['post_create_estimate']['board_id'], '5940')
        self.assert_no_writes()

    def test_missing_ssl_uses_verified_public_defaults(self):
        config = SimpleNamespace(cloud=True, use_bearer_authentication=False,
                                 use_cert_authentication=False, ssl=None,
                                 jira_api_base_url='https://jira.example',
                                 jira_api_username='fake-user',
                                 jira_api_token=SimpleNamespace(get_secret_value=lambda: 'fake-token'))
        with patch('jira_ticket.core.httpx.Client') as constructor:
            self.assertIs(client_for(config), constructor.return_value)
        self.assertIs(constructor.call_args.kwargs['verify'], True)
        self.assertIs(constructor.call_args.kwargs['follow_redirects'], False)
        self.assert_no_writes()

    def test_success_transitions_and_verifies_without_duplicate(self):
        result = self.creator.create(self.prepare(parent='RI-444'))
        self.assertEqual(result, {'outcome': 'created', 'key': 'RI-999', 'link': 'https://browser.example/browse/RI-999'})
        self.assertEqual(self.jira.actual['parent'], {'id': '444'})
        self.assertEqual(self.jira.requests.count(('POST', 'issue')), 1)
        self.assertEqual(self.jira.requests.count(('POST', 'issue/RI-999/transitions')), 1)
        self.assertEqual(self.jira.requests.count(('GET', 'issue/RI-999')), 2)
        self.assertFalse(any(path.startswith('agile/') for _, path in self.jira.requests))

    def test_already_in_status_needs_no_transition(self):
        result = self.creator.create(self.prepare(status='Open'))
        self.assertEqual(result['outcome'], 'created')
        self.assertNotIn(('POST', 'issue/RI-999/transitions'), self.jira.requests)

    def test_preflight_unknown_and_ambiguous_values(self):
        for changes in ({'issue_type': 'Invented'}, {'status': 'Imaginary'}, {'points': 'NaN'},
                        {'points': '-1'}, {'summary': ''}, {'project': None}):
            with self.subTest(changes=changes), self.assertRaises(Failure):
                self.prepare(**changes)
        self.jira.types.append({'id': '4', 'name': 'Task'})
        with self.assertRaises(Failure):
            self.prepare()
        self.jira.types.pop()
        self.jira.statuses.append({'id': '21', 'name': 'Done'})
        with self.assertRaises(Failure):
            self.prepare()
        self.assert_no_writes()

    def test_missing_estimate_plans_verified_agile_fallback(self):
        self.jira.estimate = None
        prepared = self.prepare(points='2')
        self.assertNotIn('customfield_10004', prepared['payload']['fields'])
        self.assertEqual(prepared['post_create_estimate'], {'board_id': '5940', 'field_id': 'customfield_10004', 'value': '2', 'expected_value': 2.0})
        self.assert_no_writes()
        prepared = self.prepare(points='unset')
        self.assertNotIn('customfield_10004', prepared['payload']['fields'])
        self.assertNotIn('post_create_estimate', prepared)

    def test_agile_request_order_update_before_transition_and_verify(self):
        self.jira.estimate = None
        prepared = self.prepare(points='2')
        self.jira.requests.clear()
        result = self.creator.create(prepared)
        self.assertEqual(result['outcome'], 'created')
        self.assertEqual(self.jira.requests, [
            ('POST', 'issue'), ('GET', 'agile/issue/RI-999/estimation'),
            ('PUT', 'agile/issue/RI-999/estimation'), ('GET', 'agile/issue/RI-999/estimation'),
            ('GET', 'issue/RI-999'), ('GET', 'issue/RI-999/transitions'),
            ('POST', 'issue/RI-999/transitions'), ('GET', 'issue/RI-999')])
        self.assertEqual(self.jira.actual['customfield_10004'], 2.0)
        self.assertNotIn('customfield_10004', prepared['payload']['fields'])

    def test_board_ambiguity_paginated_and_explicit_verified_override(self):
        self.jira.estimate = None
        self.jira.boards.append({'id': 5941, 'name': 'Other', 'type': 'scrum'})
        with self.assertRaisesRegex(Failure, 'exactly one eligible'):
            self.prepare()
        self.assertEqual(self.jira.requests.count(('GET', 'agile/board')), 2)
        self.assert_no_writes()
        prepared = self.prepare(board='5941')
        self.assertEqual(prepared['post_create_estimate']['board_id'], '5941')
        for board in ('unknown', '9999'):
            with self.subTest(board=board), self.assertRaises(Failure):
                self.prepare(board=board)
        self.assert_no_writes()

    def test_board_wrong_estimator_or_no_board_fails_preflight(self):
        self.jira.estimate = None
        for attribute, value in [('board_field', 'customfield_14308'), ('board_name', 'Story point estimate')]:
            original = getattr(self.jira, attribute)
            setattr(self.jira, attribute, value)
            with self.assertRaises(Failure):
                self.prepare()
            setattr(self.jira, attribute, original)
        self.jira.boards = []
        with self.assertRaises(Failure):
            self.prepare()
        self.assert_no_writes()

    def test_agile_failures_keep_key_no_retry_or_status_transition(self):
        self.jira.estimate = None
        prepared = self.prepare()
        for error in ('get', 'field', 'put', 'timeout', 'readback'):
            with self.subTest(error=error):
                self.jira.requests.clear()
                self.jira.estimate_value = None
                self.jira.estimate_error = error
                result = self.creator.create(prepared)
                self.assertEqual(result['outcome'], 'partial_failure')
                self.assertEqual(result['key'], 'RI-999')
                self.assertEqual(result['link'], 'https://browser.example/browse/RI-999')
                self.assertIn(result['failed_step'], ('estimate_precheck', 'estimate_update', 'estimate_verification'))
                self.assertIn('Story Points Estimates=3.5', result['remaining_action'])
                self.assertIn('Manually repair', result['remaining_action'])
                self.assertEqual(self.jira.requests.count(('POST', 'issue')), 1)
                self.assertLessEqual(self.jira.requests.count(('PUT', 'agile/issue/RI-999/estimation')), 1)
                self.assertNotIn(('POST', 'issue/RI-999/transitions'), self.jira.requests)
                self.assertNotIn('secret token', json.dumps(result))
                self.assertNotIn('private server', json.dumps(result))

    def test_agile_update_also_requires_issue_field_readback(self):
        self.jira.estimate = None
        prepared = self.prepare(status='Open')
        original = self.creator.request
        def request(method, path, **kwargs):
            result = original(method, path, **kwargs)
            if path == 'issue/RI-999':
                result['fields']['customfield_10004'] = 99
            return result
        with patch.object(self.creator, 'request', side_effect=request):
            result = self.creator.create(prepared)
        self.assertEqual(result['outcome'], 'partial_failure')
        self.assertEqual(result['key'], 'RI-999')
        self.assertEqual(result['link'], 'https://browser.example/browse/RI-999')
        self.assertIn('customfield_10004', result['message'])
        self.assertEqual(self.jira.requests.count(('POST', 'issue')), 1)
        self.assertEqual(self.jira.requests.count(('PUT', 'agile/issue/RI-999/estimation')), 1)

    def test_ambiguous_or_wrong_field_or_schema_fail(self):
        self.jira.catalog.append(copy.deepcopy(self.jira.catalog[0]))
        with self.assertRaises(Failure):
            self.prepare()
        self.jira.catalog.pop()
        self.jira.catalog[0]['id'] = 'customfield_14308'
        with self.assertRaises(Failure):
            self.prepare()
        self.jira.catalog[0]['id'] = 'customfield_10004'
        self.jira.estimate['schema']['type'] = 'string'
        with self.assertRaises(Failure):
            self.prepare()
        self.assert_no_writes()

    def test_required_field_and_allowed_values_fail(self):
        self.jira.fields.append({'fieldId': 'unknown', 'required': True})
        with self.assertRaisesRegex(Failure, 'Required field'):
            self.prepare()
        self.jira.fields.pop()
        self.jira.fields[1]['allowedValues'] = [{'id': '5'}]
        with self.assertRaisesRegex(Failure, 'allowed value'):
            self.prepare()
        self.assert_no_writes()

    def test_identity_overrides_and_ambiguity(self):
        self.jira.users = [{'accountId': 'other', 'displayName': 'A Person', 'active': True}]
        fields = self.prepare(assignee='A Person', reporter='id:reporter')['payload']['fields']
        self.assertEqual(fields['assignee']['accountId'], 'other')
        self.assertEqual(fields['reporter']['accountId'], 'reporter')
        self.jira.users.append({'accountId': 'another', 'displayName': 'A Person', 'active': True})
        with self.assertRaisesRegex(Failure, 'exactly one'):
            self.prepare(assignee='A Person')
        self.assert_no_writes()

    def test_parent_project_and_type_and_missing_subtask_parent(self):
        self.jira.parent_project = '99'
        with self.assertRaises(Failure):
            self.prepare(parent='RI-444')
        self.jira.parent_project = '42'
        self.jira.parent_level = 0
        with self.assertRaises(Failure):
            self.prepare(parent='RI-444')
        self.jira.types[0]['subtask'] = True
        with self.assertRaises(Failure):
            self.prepare()
        self.assert_no_writes()

    def test_transition_failure_or_ambiguity_is_partial_no_duplicate(self):
        for mode in ('error', 'missing', 'ambiguous'):
            with self.subTest(mode=mode):
                self.jira.requests.clear()
                self.jira.transition_error = mode == 'error'
                self.jira.transitions = [] if mode == 'missing' else [{'id': '7', 'to': {'id': '20'}}]
                if mode == 'ambiguous':
                    self.jira.transitions.append({'id': '8', 'to': {'id': '20'}})
                result = self.creator.create(self.prepare())
                self.assertEqual(result['outcome'], 'partial_failure')
                self.assertEqual(result['key'], 'RI-999')
                self.assertEqual(result['link'], 'https://browser.example/browse/RI-999')
                self.assertIn(result['failed_step'], ('transition_discovery', 'status_transition'))
                self.assertIn('status=Done', result['remaining_action'])
                self.assertEqual(self.jira.requests.count(('POST', 'issue')), 1)
                self.assertNotIn('credential-bearing', json.dumps(result))

    def test_ambiguous_create_timeout_never_retried_or_leaks_exception(self):
        self.jira.create_timeout = True
        result = self.creator.create(self.prepare())
        self.assertEqual(result['outcome'], 'unknown')
        self.assertNotIn('key', result)
        self.assertNotIn('link', result)
        self.assertIn('No key is available', result['message'])
        self.assertIn('reconciliation', result['message'])
        self.assertEqual(self.jira.requests.count(('POST', 'issue')), 1)
        self.assertNotIn('secret token', json.dumps(result))

    def test_readback_mismatch_partial(self):
        prepared = self.prepare(status='Open')
        original = self.creator.request
        def request(method, path, **kwargs):
            result = original(method, path, **kwargs)
            if path == 'issue/RI-999':
                result['fields']['summary'] = 'wrong'
            return result
        with patch.object(self.creator, 'request', side_effect=request):
            result = self.creator.create(prepared)
        self.assertEqual(result['outcome'], 'partial_failure')
        self.assertEqual(result['key'], 'RI-999')
        self.assertEqual(result['link'], 'https://browser.example/browse/RI-999')
        self.assertEqual(result['failed_step'], 'issue_verification')
        self.assertIn('Manually repair', result['remaining_action'])
        self.assertIn('summary', result['message'])

    def test_cli_default_dry_run_reads_only_effective_project(self):
        self.jira.estimate = None
        with TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / 'draft.json'
            path.write_text(json.dumps({'summary': 'Approved', 'description': 'Description\n- markdown retained',
                                        'type': 'Task', 'status': 'Open', 'story_points': 2}), encoding='utf-8')
            config = SimpleNamespace(default_project_key_or_id='RI', jira_base_url='https://browser.example', jira_api_base_url='https://jira.example')
            output = io.StringIO()
            with patch.object(cli, 'configuration', return_value=config), patch.object(cli, 'client_for', return_value=self.client), redirect_stdout(output):
                code = cli.main(['preflight', '--draft', str(path)])
            self.assertEqual(code, 0)
            result = json.loads(output.getvalue())
            self.assertEqual(result['outcome'], 'dry_run')
            self.assertEqual(result['post_create_estimate']['value'], '2')
            self.assert_no_writes()

    def test_transition_required_fields_never_guessed(self):
        self.jira.transitions[0]['fields'] = {'resolution': {'required': True, 'hasDefaultValue': False}}
        result = self.creator.create(self.prepare())
        self.assertEqual(result['outcome'], 'partial_failure')
        self.assertEqual(result['key'], 'RI-999')
        self.assertNotIn(('POST', 'issue/RI-999/transitions'), self.jira.requests)
        self.assertEqual(self.jira.requests.count(('POST', 'issue')), 1)

    def test_cli_explicit_create_and_config_error_redaction(self):
        with TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / 'draft.json'
            path.write_text(json.dumps({'summary': 'Approved', 'description': 'Approved description',
                                        'type': 'Task', 'status': 'Open', 'story_points': 'unset'}), encoding='utf-8')
            args = ['create', '--draft', str(path)]
            config = SimpleNamespace(default_project_key_or_id='RI', jira_base_url='https://browser.example', jira_api_base_url='https://jira.example')
            output = io.StringIO()
            with patch.object(cli, 'configuration', return_value=config), patch.object(cli, 'client_for', return_value=self.client), redirect_stdout(output):
                code = cli.main(args)
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(output.getvalue())['outcome'], 'created')
            self.assertEqual(self.jira.requests.count(('POST', 'issue')), 1)
            self.jira.requests.clear()
            output = io.StringIO()
            with patch.object(cli, 'configuration', side_effect=ValueError('SECRET CONFIG TOKEN')), redirect_stdout(output):
                code = cli.main(args)
            self.assertEqual(code, 1)
            self.assertNotIn('SECRET CONFIG TOKEN', output.getvalue())
            self.assertEqual(json.loads(output.getvalue())['outcome'], 'preflight_failed')
            self.assert_no_writes()

    def test_invalid_adf_rejected_without_loss_or_write(self):
        bad = {'type': 'doc', 'version': 1, 'content': [{'type': 'unsupported', 'content': []}]}
        with self.assertRaises(Failure):
            self.prepare(description=bad)
        self.assert_no_writes()


if __name__ == '__main__':
    unittest.main()
