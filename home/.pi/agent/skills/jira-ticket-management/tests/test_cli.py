"""Public CLI contracts, with no live config, credentials or requests."""
from contextlib import redirect_stdout, redirect_stderr
import io
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx
from jira_ticket import cli
from jira_ticket.core import Failure, configuration, text_adf
from test_create_ticket import Jira


class CliTests(unittest.TestCase):
    def setUp(self):
        self.jira = Jira()
        self.config = SimpleNamespace(default_project_key_or_id='RI', jira_base_url='https://browser.example',
                                      jira_api_base_url='https://jira.example')
        self.directory = TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'approved draft.json'
        self.draft = {'summary': 'Approved summary', 'description': '# Literal\r\n\r\n- content\r\n',
                      'type': 'Task', 'status': 'Done', 'story_points': 2.5}

    def invoke(self, command, draft=None, raw=None, extra=()):
        args = [command, *extra]
        if command in ('preflight', 'create'):
            self.path.write_text(raw if raw is not None else json.dumps(self.draft if draft is None else draft), encoding='utf-8')
            args += ['--draft', str(self.path)]
        client = httpx.Client(base_url='https://jira.example/', transport=httpx.MockTransport(self.jira.handle))
        output = io.StringIO()
        with patch.object(cli, 'configuration', return_value=self.config), patch.object(cli, 'client_for', return_value=client), redirect_stdout(output):
            code = cli.main(args)
        return code, json.loads(output.getvalue())

    def assert_no_writes(self):
        self.assertTrue(all(method == 'GET' for method, _ in self.jira.requests))

    def test_same_saved_draft_preflight_and_create_preserve_full_content(self):
        code, preview = self.invoke('preflight')
        self.assertEqual(code, 0)
        self.assertEqual(preview['payload']['fields']['description'], text_adf('# Literal\n\n- content\n'))
        self.assert_no_writes()
        code, result = self.invoke('create')
        self.assertEqual(code, 0)
        self.assertEqual(result['outcome'], 'created')
        for field, value in preview['payload']['fields'].items():
            self.assertEqual(self.jira.actual[field], value)
        self.assertEqual(self.jira.requests.count(('POST', 'issue')), 1)

    def test_adf_is_preserved_not_converted_or_dropped(self):
        adf = {'type': 'doc', 'version': 1, 'content': [{'type': 'heading', 'attrs': {'level': 2},
               'content': [{'type': 'text', 'text': 'Approved', 'marks': [{'type': 'strong'}]}]}]}
        code, result = self.invoke('preflight', self.draft | {'description': adf})
        self.assertEqual(code, 0)
        self.assertEqual(result['payload']['fields']['description'], adf)
        self.assert_no_writes()

    def test_invalid_drafts_fail_before_configuration_or_requests(self):
        cases = [[], None, {'payload': {'fields': {}}}, self.draft | {'token': 'secret'},
                 self.draft | {'prepared': {}}, self.draft | {'description_file': 'file'},
                 self.draft | {'type': 3}, self.draft | {'status': None}, self.draft | {'summary': False},
                 self.draft | {'project': 'RI/secret'}, self.draft | {'parent': 444},
                 self.draft | {'board': 5940}, self.draft | {'board': 'bad'},
                 self.draft | {'assignee': []}, self.draft | {'reporter': ''},
                 self.draft | {'description': None}, self.draft | {'description': '  '},
                 self.draft | {'description': {'type': 'doc', 'version': True, 'content': []}},
                 self.draft | {'story_points': True}, self.draft | {'story_points': None},
                 self.draft | {'story_points': '2'}, self.draft | {'story_points': -1},
                 self.draft | {'story_points': 'unset', 'board': '5940'},
                 {key: value for key, value in self.draft.items() if key != 'story_points'}]
        for draft in cases:
            with self.subTest(draft=draft):
                self.path.write_text(json.dumps(draft), encoding='utf-8')
                with patch.object(cli, 'configuration') as config, redirect_stdout(io.StringIO()):
                    self.assertEqual(cli.main(['create', '--draft', str(self.path)]), 1)
                config.assert_not_called()
        self.assertEqual(self.jira.requests, [])

    def test_invalid_json_and_duplicates_and_nonfinite_rejected(self):
        for raw in ('{', '{"summary":"one","summary":"two"}',
                    json.dumps(self.draft | {'story_points': float('nan')}),
                    json.dumps(self.draft | {'story_points': float('inf')}),
                    json.dumps(self.draft).replace('2.5', '1e999')):
            with self.subTest(raw=raw):
                code, result = self.invoke('create', raw=raw)
                self.assertEqual(code, 1)
                self.assertEqual(result['outcome'], 'preflight_failed')
        self.assertEqual(self.jira.requests, [])

    def test_explicit_unset_and_zero_are_distinct(self):
        code, result = self.invoke('preflight', self.draft | {'story_points': 'unset'})
        self.assertEqual(code, 0)
        self.assertNotIn('customfield_10004', result['payload']['fields'])
        code, result = self.invoke('preflight', self.draft | {'story_points': 0})
        self.assertEqual(result['payload']['fields']['customfield_10004'], 0)
        self.assert_no_writes()

    def test_discovery_is_read_only_and_rejects_unknown_type(self):
        code, result = self.invoke('types')
        self.assertEqual(code, 0)
        self.assertEqual(result, {'outcome': 'types', 'project': 'RI', 'types': [{'id': '3', 'name': 'Task'}]})
        code, result = self.invoke('statuses', extra=['--type', 'Task'])
        self.assertEqual(code, 0)
        self.assertEqual(result['statuses'], self.jira.statuses)
        code, result = self.invoke('statuses', extra=['--type', 'Invented'])
        self.assertEqual(code, 1)
        self.assertEqual(result['outcome'], 'preflight_failed')
        self.assert_no_writes()

    def test_type_discovery_reads_every_page(self):
        original = self.jira.handle
        def paginated(request):
            if request.url.path == '/rest/api/3/issue/createmeta/42/issuetypes':
                self.jira.requests.append((request.method, 'issue/createmeta/42/issuetypes'))
                start = int(request.url.params['startAt'])
                items = [{'id': '3', 'name': 'Task'}, {'id': '4', 'name': 'Research'}]
                return httpx.Response(200, json={'issueTypes': items[start:start + 1], 'total': 2})
            return original(request)
        with patch.object(self.jira, 'handle', side_effect=paginated):
            code, result = self.invoke('types')
        self.assertEqual(code, 0)
        self.assertEqual([item['name'] for item in result['types']], ['Task', 'Research'])
        self.assertEqual(self.jira.requests.count(('GET', 'issue/createmeta/42/issuetypes')), 2)
        self.assert_no_writes()

    def test_doctor_default_is_local_connectivity_is_explicit_get_only(self):
        code, result = self.invoke('doctor')
        self.assertEqual(code, 0)
        self.assertEqual(result['connectivity'], 'not_checked')
        self.assertEqual(self.jira.requests, [])
        code, result = self.invoke('doctor', extra=['--connectivity'])
        self.assertEqual(code, 0)
        self.assertEqual(result['connectivity'], 'verified')
        self.assertEqual(self.jira.requests, [('GET', 'myself')])
        self.assertNotIn('accountId', json.dumps(result))

    def test_doctor_redacts_all_configuration_and_request_errors(self):
        for source in ('configuration', 'client_for'):
            for exception in (ValueError('SECRET https://user:token@example/'), Failure('SECRET')):
                with self.subTest(source=source, exception=type(exception)):
                    output = io.StringIO()
                    with patch.object(cli, 'configuration', return_value=self.config), patch.object(cli, source, side_effect=exception), redirect_stdout(output):
                        self.assertEqual(cli.main(['doctor']), 1)
                    self.assertEqual(json.loads(output.getvalue())['outcome'], 'doctor_failed')
                    self.assertNotIn('SECRET', output.getvalue())
        def fail(request):
            raise httpx.ReadTimeout('SECRET', request=request)
        client = httpx.Client(base_url='https://jira.example/', transport=httpx.MockTransport(fail))
        output = io.StringIO()
        with patch.object(cli, 'configuration', return_value=self.config), patch.object(cli, 'client_for', return_value=client), redirect_stdout(output):
            self.assertEqual(cli.main(['doctor', '--connectivity']), 1)
        self.assertNotIn('SECRET', output.getvalue())

    def test_create_timeout_and_estimate_timeout_never_retried(self):
        self.jira.create_timeout = True
        code, result = self.invoke('create')
        self.assertEqual((code, result['outcome']), (1, 'unknown'))
        self.assertEqual(self.jira.requests.count(('POST', 'issue')), 1)
        self.assertNotIn('key', result)
        self.assertNotIn('secret', json.dumps(result))
        self.jira.create_timeout = False
        self.jira.estimate = None
        self.jira.estimate_error = 'timeout'
        self.jira.requests.clear()
        code, result = self.invoke('create')
        self.assertEqual((code, result['outcome']), (1, 'partial_failure'))
        self.assertEqual(result['link'], 'https://browser.example/browse/RI-999')
        self.assertEqual(self.jira.requests.count(('POST', 'issue')), 1)
        self.assertEqual(self.jira.requests.count(('PUT', 'agile/issue/RI-999/estimation')), 1)
        self.assertNotIn(('POST', 'issue/RI-999/transitions'), self.jira.requests)

    def test_help_version_and_no_arguments_are_offline(self):
        args_list = [['--help'], ['--version']] + [[command, '--help'] for command in
                     ('doctor', 'types', 'statuses', 'link-types', 'preflight', 'create', 'dry-run', 'draft-example')]
        for args in args_list:
            with self.subTest(args=args), patch.object(cli, 'configuration', side_effect=AssertionError('Config forbidden')) as config, patch.object(cli, 'client_for', side_effect=AssertionError('Client forbidden')) as client, redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                cli.main(args)
            self.assertEqual(raised.exception.code, 0)
            config.assert_not_called()
            client.assert_not_called()
        output = io.StringIO()
        with patch.object(cli, 'configuration') as config, patch.object(cli, 'client_for') as client, redirect_stdout(output):
            self.assertEqual(cli.main([]), 0)
        config.assert_not_called()
        client.assert_not_called()
        self.assertIn('preflight', output.getvalue())
        self.assertIn('draft-example', output.getvalue())

    def test_draft_example_is_offline(self):
        output = io.StringIO()
        with patch.object(cli, 'configuration') as config, patch.object(cli, 'client_for') as client, redirect_stdout(output):
            self.assertEqual(cli.main(['draft-example']), 0)
        config.assert_not_called()
        client.assert_not_called()
        example = json.loads(output.getvalue())
        self.assertEqual(set(example), cli.REQUIRED | {'links'})
        self.assertEqual(example['links'], [])
        self.assertEqual(example['story_points'], 'unset')

    def test_dry_run_aliases_never_write(self):
        for command, extra in (('dry-run', []), ('--dry-run', []), ('create', ['--dry-run'])):
            with self.subTest(command=command):
                self.path.write_text(json.dumps(self.draft), encoding='utf-8')
                output = io.StringIO()
                client = httpx.Client(base_url='https://jira.example/', transport=httpx.MockTransport(self.jira.handle))
                with patch.object(cli, 'configuration', return_value=self.config), patch.object(cli, 'client_for', return_value=client), redirect_stdout(output):
                    self.assertEqual(cli.main([command, '--draft', str(self.path), *extra]), 0)
                self.assertEqual(json.loads(output.getvalue())['outcome'], 'dry_run')
                self.assert_no_writes()

    def test_local_validation_messages_are_actionable_and_redact_content(self):
        for draft, code, fields in (({}, 'missing_keys', sorted(cli.REQUIRED)),
                                   (self.draft | {'SECRET_KEY': 'SECRET_VALUE'}, 'unsupported_keys', []),
                                   (self.draft | {'story_points': 'SECRET_VALUE'}, 'invalid_value', ['story_points']),
                                   (self.draft | {'description': []}, 'invalid_value', ['description'])):
            with self.subTest(code=code):
                status, result = self.invoke('preflight', draft=draft)
                self.assertEqual(status, 1)
                error = result['errors'][0]
                self.assertEqual(error['code'], code)
                self.assertEqual(error['fields'], fields)
                self.assertTrue(error['remediation'])
                self.assertNotIn('SECRET', json.dumps(result))
        self.assertEqual(self.jira.requests, [])

    def test_effective_config_selection_is_public_and_restores_environment(self):
        for existing in (None, 'original.yaml'):
            env = {} if existing is None else {'JIRA_TUI_CONFIG_FILE': existing}
            with patch.dict(os.environ, env, clear=True):
                with patch('jiratui.config.ApplicationConfiguration', return_value=self.config) as constructor:
                    self.assertIs(configuration(), self.config)
                    constructor.assert_called_once_with()
                def load():
                    self.assertEqual(os.environ['JIRA_TUI_CONFIG_FILE'], str(self.path.resolve()))
                    raise ValueError('simulated configuration failure')
                with patch('jiratui.config.ApplicationConfiguration', side_effect=load), self.assertRaises(ValueError):
                    configuration(self.path)
                self.assertEqual(os.environ.get('JIRA_TUI_CONFIG_FILE'), existing)


if __name__ == '__main__':
    unittest.main()
