"""Identity contracts through create/update CLIs and the fake HTTP boundary."""
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import httpx
from jira_ticket import cli
from jira_ticket.core import USER_PAGE_SIZE
from test_create_ticket import Jira
from test_existing_ticket import ExistingJira


EMAIL = 'person@example.com'
PERSON = {'accountId': 'person', 'emailAddress': EMAIL, 'active': True}
OTHER = {'accountId': 'other', 'displayName': 'Other', 'active': True}


class IdentityResolutionTests(unittest.TestCase):
    def invoke(self, *, update, pages, selector=EMAIL, unassigned=False, missing_readback=False, bad_id=False):
        jira = ExistingJira() if update else Jira()
        if unassigned:
            jira.actual['assignee'] = None
        starts = []
        original = jira.handle

        def handle(request):  # httpx transport callback
            path = request.url.path.removeprefix('/rest/api/3/')
            if path == 'users/search':
                self.assertEqual(request.method, 'GET')
                self.assertEqual(set(request.url.params), {'startAt', 'maxResults'})
                self.assertEqual(int(request.url.params['maxResults']), USER_PAGE_SIZE)
                starts.append(int(request.url.params['startAt']))
                page = pages[min(len(starts) - 1, len(pages) - 1)]
                return httpx.Response(403 if page == 'unavailable' else 200, json=page)
            if path == 'user' and bad_id:
                jira.requests.append((request.method, path))
                return httpx.Response(404, json={})
            response = original(request)
            if missing_readback and request.method == 'GET' and path == 'issue/999' and jira.puts:
                data = response.json()
                data['fields'].pop('assignee', None)
                return httpx.Response(200, json=data)
            return response

        draft = {'assignee': selector}
        if not update:
            draft |= {'summary': 'Approved', 'description': 'Approved description',
                      'type': jira.types[0]['id'], 'status': jira.statuses[0]['id'], 'story_points': 'unset'}
        config = SimpleNamespace(default_project_key_or_id='RI', jira_base_url='https://browser.example',
                                 jira_api_base_url='https://jira.example')
        with TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / 'draft.json'
            path.write_text(json.dumps(draft), encoding='utf-8')
            args = ['update', jira.key] if update else ['create']
            args += ['--draft', str(path)]
            output = io.StringIO()
            client = httpx.Client(base_url='https://jira.example/', transport=httpx.MockTransport(handle))
            with patch.object(cli, 'configuration', return_value=config), patch.object(cli, 'client_for', return_value=client), redirect_stdout(output):
                code = cli.main(args)
        return code, json.loads(output.getvalue()), jira, starts

    def test_clamped_short_pages_continue_to_empty_and_find_later_match(self):
        for update in (False, True):
            with self.subTest(update=update):
                code, result, jira, starts = self.invoke(update=update, pages=[[OTHER], [PERSON], []], selector=EMAIL.upper())
                self.assertEqual(code, 0, result)
                self.assertEqual(starts, [0, 1, 2])
                self.assertEqual(jira.actual['assignee'], {'accountId': PERSON['accountId']})

    def test_bad_enumeration_and_ambiguous_later_matches_fail_before_writes(self):
        malformed = [None, {}, {'accountId': '', 'active': True}, PERSON | {'active': 1},
                     PERSON | {'displayName': None}, PERSON | {'emailAddress': 42}]
        cases = [([[PERSON], [PERSON | {'accountId': 'second'}], []], False),
                 ([[PERSON], [PERSON]], True), (['unavailable'], True),
                 ([[OTHER], {}], True), ([[PERSON], ['bad']], True)]
        cases += [([[PERSON, bad], []], True) for bad in malformed]
        for update in (False, True):
            for pages, malformed_error in cases:
                with self.subTest(update=update, pages=pages):
                    code, result, jira, _ = self.invoke(update=update, pages=pages)
                    self.assertEqual(code, 1, result)
                    self.assertTrue(all(method == 'GET' for method, _ in jira.requests))
                    if malformed_error:
                        self.assertIn('verified id:ACCOUNT_ID', json.dumps(result))

    def test_hidden_email_is_valid_but_cannot_match_display_name(self):
        hidden = {'accountId': 'hidden', 'displayName': EMAIL, 'active': True}
        for update in (False, True):
            for user in (hidden, hidden | {'emailAddress': None}):
                with self.subTest(update=update, user=user):
                    code, result, jira, _ = self.invoke(update=update, pages=[[user], []])
                    self.assertEqual(code, 1, result)
                    self.assertTrue(all(method == 'GET' for method, _ in jira.requests))
                    code, result, _, _ = self.invoke(update=update, pages=[[user], [PERSON], []])
                    self.assertEqual(code, 0, result)

    def test_null_existing_assignee_does_not_bypass_explicit_identity_validation(self):
        code, result, jira, starts = self.invoke(update=True, pages=[[]], selector='id:None', unassigned=True, bad_id=True)
        self.assertEqual(code, 1, result)
        self.assertIn(('GET', 'user'), jira.requests)
        self.assertEqual(jira.puts, [])
        self.assertEqual(starts, [])

    def test_already_unassigned_null_and_blank_are_noops_without_user_lookup(self):
        for selector in (None, '', '  '):
            with self.subTest(selector=selector):
                code, result, jira, starts = self.invoke(update=True, pages=[[]], selector=selector, unassigned=True)
                self.assertEqual(code, 0, result)
                self.assertEqual(result['outcome'], 'unchanged')
                self.assertEqual(jira.puts, [])
                self.assertEqual(starts, [])
                self.assertFalse(any(path.startswith('user') for _, path in jira.requests))

    def test_missing_assignee_after_unassign_is_partial_failure_with_one_put(self):
        code, result, jira, _ = self.invoke(update=True, pages=[[]], selector=None, missing_readback=True)
        self.assertEqual(code, 1, result)
        self.assertEqual(result['outcome'], 'partial_failure')
        self.assertEqual(len(jira.puts), 1)
        self.assertEqual(sum(method != 'GET' for method, _ in jira.requests), 1)
