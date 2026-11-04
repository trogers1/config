"""Search through the public CLI and HTTP boundary; no live Jira access."""
from contextlib import redirect_stdout
import io
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx
from jira_ticket import cli
from jira_ticket.search import FIELDS


class SearchTests(unittest.TestCase):
    def invoke(self, *, pages, extra=(), jql='project = OTHER ORDER BY updated DESC', expected_jql='project = "RI" AND (project = OTHER) ORDER BY updated DESC'):
        requests = []

        def handle(request):
            requests.append(request)
            self.assertEqual(request.method, 'GET')
            self.assertEqual(request.url.path, '/rest/api/3/search/jql')
            self.assertEqual(request.url.params['jql'], expected_jql)
            self.assertEqual(request.url.params['fields'], ','.join(FIELDS))
            page = pages[len(requests) - 1]
            return httpx.Response(200, json=page) if isinstance(page, dict) else httpx.Response(page, json={'errorMessages': ['SECRET']})

        config = SimpleNamespace(jira_base_url='https://browser.example', jira_api_base_url='https://api.example', default_project_key_or_id='RI')
        client = httpx.Client(base_url=config.jira_api_base_url, transport=httpx.MockTransport(handle))
        output = io.StringIO()
        with patch.object(cli, 'configuration', return_value=config), patch.object(cli, 'client_for', return_value=client), redirect_stdout(output):
            code = cli.main(['search', '--jql', jql, *extra])
        return code, json.loads(output.getvalue()), requests

    def test_search_and_explicit_continuation(self):
        issue = {'id': '123', 'key': 'OTHER-1', 'fields': {'summary': 'A realistic ticket',
                 'status': {'id': '1', 'name': 'Open'}, 'issuetype': {'id': '3', 'name': 'Task'}}}
        code, result, requests = self.invoke(pages=[{'issues': [issue], 'isLast': False, 'nextPageToken': 'opaque+/='}], extra=['--limit', '1'])
        self.assertEqual(code, 0)
        self.assertEqual(result['outcome'], 'search')
        self.assertTrue(result['read_only'])
        self.assertEqual(result['issues'], [{'id': issue['id'], 'key': issue['key'], 'link': 'https://browser.example/browse/OTHER-1', **issue['fields']}])
        self.assertEqual(result['next_page_token'], 'opaque+/=')
        self.assertFalse(result['is_last'])
        self.assertEqual(len(requests), 1)
        self.assertNotIn('nextPageToken', requests[0].url.params)
        code, result, requests = self.invoke(pages=[{'issues': [], 'isLast': True}], extra=['--limit', '1', '--next-page-token', result['next_page_token']])
        self.assertEqual(code, 0)
        self.assertEqual(requests[0].url.params['nextPageToken'], 'opaque+/=')
        self.assertEqual(result['issues'], [])
        self.assertTrue(result['is_last'])
        self.assertIsNone(result['next_page_token'])

    def test_scope_preserves_boolean_grouping_quoted_text_and_ordering(self):
        for jql, expected in (
            ('status = Open OR status = Closed', 'project = "RI" AND (status = Open OR status = Closed)'),
            ('summary ~ "order by" order by updated DESC', 'project = "RI" AND (summary ~ "order by") order by updated DESC'),
            ("summary ~ 'order by'", "project = \"RI\" AND (summary ~ 'order by')"),
            ('assignee in membersOf("order by") ORDER BY key', 'project = "RI" AND (assignee in membersOf("order by")) ORDER BY key'),
            ('ORDER BY updated DESC', 'project = "RI" ORDER BY updated DESC'),
        ):
            with self.subTest(jql=jql):
                code, result, _ = self.invoke(pages=[{'issues': [], 'isLast': True}], jql=jql, expected_jql=expected)
                self.assertEqual(code, 0)
                self.assertEqual(result['project'], 'RI')

    def test_unbalanced_query_cannot_escape_project_scope(self):
        for jql in (
            'status = Open) OR project = OTHER OR (status = Open',
            'status = Open) OR (project = OTHER',
            '(status = Open', 'status = Open)',
            'summary ~ "unterminated', "summary ~ 'unterminated",
            'status = Open ORDER BY "unterminated',
            'status = Open ORDER BY key)',
        ):
            with self.subTest(jql=jql):
                code, result, requests = self.invoke(pages=[], jql=jql)
                self.assertEqual(code, 1)
                self.assertEqual(requests, [])
                self.assertNotIn(jql, result['message'])

    def test_valid_nested_and_escaped_quoted_content(self):
        for jql in (
            '(status = Open OR (status = Closed AND assignee = currentUser()))',
            'summary ~ "(quoted parentheses)"',
            r'summary ~ "escaped \"quote\" and )"',
            r"summary ~ 'escaped \'quote\' and ('",
        ):
            with self.subTest(jql=jql):
                code, _, requests = self.invoke(pages=[{'issues': [], 'isLast': True}], jql=jql,
                                                expected_jql=f'project = "RI" AND ({jql})')
                self.assertEqual(code, 0)
                self.assertEqual(len(requests), 1)

    def test_invalid_input_fails_before_configuration(self):
        for args in (['--jql', ' '], ['--jql', 'x', '--limit', '0'], ['--jql', 'x', '--limit', '101'], ['--jql', 'x', '--next-page-token', '']):
            with self.subTest(args=args), patch.object(cli, 'configuration') as config, redirect_stdout(io.StringIO()):
                self.assertEqual(cli.main(['search', *args]), 1)
                config.assert_not_called()

    def test_errors_and_malformed_pages_fail_without_raw_server_content(self):
        for page in (400, 401, 403, 429, 500, {}, {'issues': [], 'isLast': False},
                     {'issues': [], 'isLast': True, 'nextPageToken': 'unexpected'},
                     {'issues': [{}], 'isLast': True}, {'issues': [], 'isLast': 'true'}):
            with self.subTest(page=page):
                code, result, requests = self.invoke(pages=[page])
                self.assertEqual(code, 1)
                self.assertNotIn('SECRET', json.dumps(result))
                self.assertEqual(len(requests), 1)

    def test_repeated_continuation_token_fails(self):
        code, _, _ = self.invoke(pages=[{'issues': [], 'isLast': False, 'nextPageToken': 'same'}], extra=['--next-page-token', 'same'])
        self.assertEqual(code, 1)

    def test_help_is_offline(self):
        with patch.object(cli, 'configuration') as config, redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as exit:
            cli.main(['search', '--help'])
        self.assertEqual(exit.exception.code, 0)
        config.assert_not_called()
