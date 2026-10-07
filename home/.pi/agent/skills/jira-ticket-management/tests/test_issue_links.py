"""Public CLI link behavior against a mocked Jira service; never live Jira."""
import copy
import io
import json
from contextlib import redirect_stdout
from unittest.mock import patch
import unittest

import httpx
from jira_ticket import cli
from jira_ticket.core import Creator, Failure, text_adf
import test_cli
from test_create_ticket import Jira


class LinkedJira(Jira):
    def __init__(self):
        super().__init__()
        self.link_catalog = {'issueLinkTypes': [
            {'id': '100', 'name': 'Blocks', 'inward': 'is blocked by', 'outward': 'blocks'},
            {'id': '101', 'name': 'Relates', 'inward': 'relates to', 'outward': 'relates to'}]}
        self.targets = {
            'OTHER-12': {'id': '12', 'key': 'OTHER-12', 'fields': {'summary': 'Existing cross-project target', 'project': {'id': '88'}}},
            'RI-13': {'id': '13', 'key': 'RI-13', 'fields': {'summary': 'Second existing target', 'project': {'id': '42'}}}}
        self.targets['12'] = self.targets['OLD-12'] = self.targets['OTHER-12']
        self.link_posts = []
        self.initial_links = []
        self.link_read_error = None
        self.link_write_error = None
        self.after_write_error = None
        self.preflight_error = None
        self.new_id = '999'
        self.field_mismatch = False

    def handle(self, request):
        path = request.url.path.removeprefix('/rest/api/3/')
        if path == 'issueLinkType':
            self.requests.append((request.method, path))
            assert request.method == 'GET'
            assert not request.url.params  # Not a paginated endpoint.
            if self.preflight_error == 'catalog':
                return httpx.Response(403, json={'secret': 'SECRET'})
            if self.preflight_error == 'timeout':
                raise httpx.ReadTimeout('SECRET', request=request)
            return httpx.Response(200, json=self.link_catalog)
        if path.startswith('issue/') and path[6:] in self.targets:
            self.requests.append((request.method, path))
            assert request.method == 'GET'
            assert request.url.params['fields'] == 'summary,project'
            return httpx.Response(200, json=self.targets[path[6:]])
        if path == 'issue/MISSING-1':
            self.requests.append((request.method, path))
            return httpx.Response(404, json={'secret': 'SECRET'})
        if path == 'issue/RI-999' and request.url.params.get('fields') == 'issuelinks':
            self.requests.append((request.method, path))
            error = self.after_write_error if self.link_posts else self.link_read_error
            data = {'id': self.new_id, 'key': 'RI-999', 'fields': {'issuelinks': copy.deepcopy(self.actual['issuelinks'])}}
            if error == 'missing':
                del data['fields']['issuelinks']
            elif error == 'null':
                data['fields']['issuelinks'] = None
            elif error == 'malformed':
                data['fields']['issuelinks'] = [{}]
            elif error == 'http':
                return httpx.Response(500, json={'secret': 'SECRET'})
            elif error == 'timeout':
                raise httpx.ReadTimeout('SECRET', request=request)
            return httpx.Response(200, json=data)
        if path == 'issueLink':
            self.requests.append((request.method, path))
            assert request.method == 'POST'
            body = json.loads(request.content)
            self.link_posts.append(body)
            if self.link_write_error == 'http':
                return httpx.Response(400, json={'secret': 'SECRET'})
            # Model Jira's GET representation independently from endpoint names:
            # when new is inward endpoint, its outwardIssue is the target.
            new_is_inward = body['inwardIssue']['key'] == 'RI-999'
            direction = 'outward' if new_is_inward else 'inward'
            target_key = body['outwardIssue' if new_is_inward else 'inwardIssue']['key']
            target = self.targets[target_key]
            entry = {'type': body['type'], direction + 'Issue': {'id': target['id'], 'key': target['key']}}
            if self.link_write_error == 'type':
                entry['type'] = {'id': '101'}
            elif self.link_write_error == 'direction':
                entry[('inward' if direction == 'outward' else 'outward') + 'Issue'] = entry.pop(direction + 'Issue')
            elif self.link_write_error == 'target_id':
                entry[direction + 'Issue']['id'] = '777'
            elif self.link_write_error == 'target_key':
                entry[direction + 'Issue']['key'] = 'WRONG-1'
            self.actual['issuelinks'].append(entry)
            if self.link_write_error == 'timeout':
                raise httpx.ReadTimeout('SECRET uncertain write', request=request)
            return httpx.Response(201)
        response = super().handle(request)
        if path == 'issue' and request.method == 'POST':
            self.actual['issuelinks'] = copy.deepcopy(self.initial_links)
            return httpx.Response(201, json={'key': 'RI-999', 'id': self.new_id})
        if path == 'issue/RI-999' and self.field_mismatch:
            data = response.json()
            data['fields']['summary'] = 'Wrong summary'
            return httpx.Response(200, json=data)
        return response


class LinkCliTests(unittest.TestCase):
    invoke = test_cli.CliTests.invoke
    assert_no_writes = test_cli.CliTests.assert_no_writes

    def setUp(self):
        test_cli.CliTests.setUp(self)
        self.jira = LinkedJira()
        self.links = [{'type': 'Blocks', 'direction': 'outward', 'issue': 'OTHER-12'},
                      {'type': '100', 'direction': 'inward', 'issue': 'RI-13'}]
        self.draft['links'] = copy.deepcopy(self.links)

    def statuses(self, result):
        return [link['status'] for link in result['links']]

    def test_discovery_needs_no_project_and_returns_verified_labels(self):
        self.config.default_project_key_or_id = None
        code, result = self.invoke('link-types')
        self.assertEqual(code, 0)
        self.assertEqual(result, {'outcome': 'link_types', 'link_types': self.jira.link_catalog['issueLinkTypes']})
        self.assertEqual(self.jira.requests, [('GET', 'issueLinkType')])

    def test_catalog_fails_closed_and_redacts_untrusted_content(self):
        valid = copy.deepcopy(self.jira.link_catalog['issueLinkTypes'][0])
        bad = [None, [], {}, {'issueLinkTypes': None}, {'issueLinkTypes': {}},
               {'issueLinkTypes': [None]}, {'issueLinkTypes': [valid, valid]}]
        for field in ('id', 'name', 'inward', 'outward'):
            for value in (None, '', '  ', 1, True, []):
                bad.append({'issueLinkTypes': [valid | {field: value}]})
        bad.append({'issueLinkTypes': [valid | {'id': 'SECRET'}]})
        for catalog in bad:
            with self.subTest(catalog=catalog):
                self.jira.link_catalog = catalog
                code, result = self.invoke('link-types')
                self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
                self.assertNotIn('SECRET', json.dumps(result))
        self.assert_no_writes()

    def test_schema_errors_are_actionable_redacted_and_before_config(self):
        valid = self.links[0]
        cases = [None, {}, 'SECRET', [None], [[]], [{}], [valid | {'SECRET_KEY': 'SECRET'}],
                 [{k: v for k, v in valid.items() if k != 'issue'}]]
        for field in valid:
            cases.extend([[valid | {field: value}] for value in (None, '', '  ', 12, True, {})])
        cases.extend([[valid | {'direction': value}] for value in ('OUTWARD', 'blocks', 'SECRET')])
        cases.extend([[valid | {'issue': value}] for value in ('new', '$ticket1', 'batch:1', 'https://SECRET', 'RI-1/SECRET', '12?SECRET')])
        for links in cases:
            with self.subTest(links=links):
                self.path.write_text(json.dumps(self.draft | {'links': links}), encoding='utf-8')
                output = io.StringIO()
                with patch.object(cli, 'configuration') as config, redirect_stdout(output):
                    self.assertEqual(cli.main(['create', '--draft', str(self.path)]), 1)
                config.assert_not_called()
                error = json.loads(output.getvalue())['errors'][0]
                self.assertEqual(error['fields'], ['links'])
                self.assertTrue(error['remediation'])
                self.assertNotIn('SECRET', output.getvalue())
        self.assertEqual(self.jira.requests, [])

    def test_empty_links_preserve_no_links_shape_and_do_not_read_catalog(self):
        code, preview = self.invoke('preflight', self.draft | {'links': []})
        self.assertEqual(code, 0)
        self.assertNotIn('post_create_links', preview)
        code, result = self.invoke('create', self.draft | {'links': []})
        self.assertEqual(result, {'outcome': 'created', 'key': 'RI-999', 'link': 'https://browser.example/browse/RI-999'})
        self.assertNotIn(('GET', 'issueLinkType'), self.jira.requests)
        self.assertEqual(self.jira.link_posts, [])

    def test_cross_project_canonical_preview_and_readable_labels(self):
        code, result = self.invoke('preflight')
        self.assertEqual(code, 0)
        plan = result['post_create_links'][0]
        self.assertEqual(plan['issue'], {'id': '12', 'key': 'OTHER-12', 'summary': 'Existing cross-project target'})
        self.assertEqual(plan['type']['id'], '100')
        self.assertEqual(plan['relationship'], 'NEW ticket blocks OTHER-12')
        self.assertEqual(result['post_create_links'][1]['relationship'], 'NEW ticket is blocked by RI-13')
        self.assertNotIn('issuelinks', result['payload']['fields'])
        self.assert_no_writes()

    def test_multiple_links_sequential_with_correct_post_and_readback_orientation(self):
        code, result = self.invoke('create')
        self.assertEqual((code, result['outcome']), (0, 'created'))
        self.assertEqual(self.statuses(result), ['verified', 'verified'])
        self.assertEqual(self.jira.link_posts, [
            {'type': {'id': '100'}, 'inwardIssue': {'key': 'RI-999'}, 'outwardIssue': {'key': 'OTHER-12'}},
            {'type': {'id': '100'}, 'inwardIssue': {'key': 'RI-13'}, 'outwardIssue': {'key': 'RI-999'}}])
        self.assertEqual(self.jira.requests[-6:], [('GET', 'issue/RI-999'), ('POST', 'issueLink'), ('GET', 'issue/RI-999'),
                                                ('GET', 'issue/RI-999'), ('POST', 'issueLink'), ('GET', 'issue/RI-999')])
        transition = self.jira.requests.index(('POST', 'issue/RI-999/transitions'))
        first_link = self.jira.requests.index(('POST', 'issueLink'))
        self.assertLess(transition, first_link)
        self.assertEqual(self.jira.requests.count(('POST', 'issue')), 1)
        self.assertNotIn('failed_step', result)

    def test_alias_target_posts_canonical_key_and_parent_stays_separate(self):
        draft = self.draft | {'parent': 'RI-444', 'links': [self.links[0] | {'issue': '12'}]}
        code, result = self.invoke('create', draft)
        self.assertEqual(code, 0)
        self.assertEqual(self.jira.actual['parent'], {'id': '444'})
        self.assertEqual(result['links'][0]['issue']['key'], 'OTHER-12')
        self.assertEqual(self.jira.link_posts[0]['outwardIssue'], {'key': 'OTHER-12'})

    def test_opposite_relationships_are_distinct_not_duplicate(self):
        links = [self.links[0], self.links[0] | {'direction': 'inward', 'type': '100', 'issue': '12'}]
        code, result = self.invoke('create', self.draft | {'links': links})
        self.assertEqual(code, 0)
        self.assertEqual(self.statuses(result), ['verified', 'verified'])
        self.assertEqual(len(self.jira.link_posts), 2)

    def test_already_existing_automation_links_verified_without_duplicate_post(self):
        self.jira.initial_links = [{'type': {'id': '100'}, 'outwardIssue': {'id': '12', 'key': 'OTHER-12'}}]
        code, result = self.invoke('create')
        self.assertEqual(code, 0)
        self.assertEqual(self.statuses(result), ['verified', 'verified'])
        self.assertEqual(len(self.jira.link_posts), 1)
        self.assertEqual(self.jira.link_posts[0]['inwardIssue']['key'], 'RI-13')

    def test_alias_and_type_name_id_duplicates_rejected_before_create(self):
        for alias in ('12', 'OLD-12', 'OTHER-12'):
            with self.subTest(alias=alias):
                links = [self.links[0], self.links[0] | {'type': '100', 'issue': alias}]
                code, result = self.invoke('create', self.draft | {'links': links})
                self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
                self.assertIn('Duplicate canonical', result['message'])
        self.assert_no_writes()

    def test_absent_ambiguous_type_and_absent_issue_fail_preflight(self):
        for changes in ({'type': 'SECRET'}, {'issue': 'MISSING-1'}):
            code, result = self.invoke('create', self.draft | {'links': [self.links[0] | changes]})
            self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
            self.assertNotIn('SECRET', json.dumps(result))
        self.jira.link_catalog['issueLinkTypes'].append(self.jira.link_catalog['issueLinkTypes'][0] | {'id': '102'})
        code, result = self.invoke('create')
        self.assertEqual(code, 1)
        self.assert_no_writes()

    def test_preflight_http_timeout_or_malformed_target_no_mutations(self):
        for error in ('catalog', 'timeout'):
            self.jira.preflight_error = error
            code, result = self.invoke('create')
            self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
            self.assertNotIn('SECRET', json.dumps(result))
        self.jira.preflight_error = None
        self.jira.targets['OTHER-12'] = {'id': '12', 'key': 'OTHER-12', 'fields': {'summary': 'Target'}}
        code, result = self.invoke('create')
        self.assertEqual(code, 1)
        self.assert_no_writes()

    def test_wrong_readback_type_direction_id_or_key_partial_stops(self):
        for error in ('type', 'direction', 'target_id', 'target_key'):
            with self.subTest(error=error):
                self.jira.link_posts.clear()
                self.jira.requests.clear()
                self.jira.link_write_error = error
                code, result = self.invoke('create')
                self.assertEqual((code, result['outcome']), (1, 'partial_failure'))
                self.assertEqual(result['failed_step'], 'link_verification')
                self.assertEqual(self.statuses(result), ['unverified', 'pending'])
                self.assertEqual(result['key'], 'RI-999')
                self.assertEqual(result['link'], 'https://browser.example/browse/RI-999')
                self.assertIn('RI-999 blocks OTHER-12 [unverified]', result['remaining_action'])
                self.assertIn('is blocked by RI-13 [pending]', result['remaining_action'])
                self.assertEqual(len(self.jira.link_posts), 1)
                self.assertEqual(self.jira.requests.count(('POST', 'issue')), 1)

    def test_link_post_http_and_timeout_never_retry_next_link_pending(self):
        for error in ('http', 'timeout'):
            with self.subTest(error=error):
                self.jira.link_posts.clear()
                self.jira.link_write_error = error
                code, result = self.invoke('create')
                self.assertEqual((code, result['outcome']), (1, 'partial_failure'))
                self.assertEqual(result['failed_step'], 'link_update')
                self.assertEqual(self.statuses(result), ['unverified', 'pending'])
                self.assertEqual(len(self.jira.link_posts), 1)
                self.assertIn('may have succeeded', result['message'])
                self.assertNotIn('SECRET', json.dumps(result))

    def test_missing_malformed_or_failed_precheck_fail_closed_without_link_post(self):
        for error in ('missing', 'null', 'malformed', 'http', 'timeout'):
            with self.subTest(error=error):
                self.jira.link_read_error = error
                code, result = self.invoke('create')
                self.assertEqual((code, result['outcome']), (1, 'partial_failure'))
                self.assertEqual(result['failed_step'], 'link_precheck')
                self.assertEqual(self.statuses(result), ['pending', 'pending'])
                self.assertEqual(self.jira.link_posts, [])
                self.assertNotIn('SECRET', json.dumps(result))

    def test_failed_post_write_readback_is_unverified_not_pending(self):
        for error in ('missing', 'malformed', 'http', 'timeout'):
            with self.subTest(error=error):
                self.jira.link_posts.clear()
                self.jira.after_write_error = error
                code, result = self.invoke('create')
                self.assertEqual(code, 1)
                self.assertEqual(result['failed_step'], 'link_verification')
                self.assertEqual(self.statuses(result), ['unverified', 'pending'])
                self.assertEqual(len(self.jira.link_posts), 1)

    def test_second_failure_retains_first_verified_and_third_pending(self):
        original = self.jira.handle
        def fail_second(request):
            if request.url.path.endswith('/issueLink') and len(self.jira.link_posts) == 1:
                self.jira.link_write_error = 'timeout'
            return original(request)
        links = self.links + [{'type': '101', 'direction': 'outward', 'issue': 'RI-13'}]
        with patch.object(self.jira, 'handle', side_effect=fail_second):
            code, result = self.invoke('create', self.draft | {'links': links})
        self.assertEqual(code, 1)
        self.assertEqual(self.statuses(result), ['verified', 'unverified', 'pending'])
        self.assertEqual(len(self.jira.link_posts), 2)

    def test_earlier_estimate_status_and_field_failure_leaves_links_pending(self):
        for error in ('estimate', 'status', 'fields'):
            with self.subTest(error=error):
                self.jira = LinkedJira()
                if error == 'estimate':
                    self.jira.estimate = None
                    self.jira.estimate_error = 'timeout'
                elif error == 'status':
                    self.jira.transition_error = True
                else:
                    self.jira.field_mismatch = True
                code, result = self.invoke('create')
                self.assertEqual(code, 1)
                self.assertEqual(self.statuses(result), ['pending', 'pending'])
                self.assertEqual(self.jira.link_posts, [])
                self.assertIn('blocks OTHER-12 [pending]', result['remaining_action'])

    def test_unknown_create_outcome_never_attempts_links(self):
        self.jira.create_timeout = True
        code, result = self.invoke('create')
        self.assertEqual((code, result['outcome']), (1, 'unknown'))
        self.assertNotIn('links', result)
        self.assertNotIn('key', result)
        self.assertEqual(self.jira.link_posts, [])
        self.assertEqual(self.jira.requests.count(('POST', 'issue')), 1)

    def test_self_link_rejected_by_created_id_or_key(self):
        for target in ({'id': '999', 'key': 'OTHER-12'}, {'id': '12', 'key': 'RI-999'}):
            with self.subTest(target=target):
                self.jira.targets['OTHER-12'].update(target)
                code, result = self.invoke('create')
                self.assertEqual(code, 1)
                self.assertEqual(result['failed_step'], 'link_precheck')
                self.assertIn('Self-links', result['message'])
                self.assertEqual(self.statuses(result), ['pending', 'pending'])
                self.assertEqual(self.jira.link_posts, [])

    def test_later_self_link_prevents_all_link_writes(self):
        self.jira.targets['RI-13']['id'] = '999'
        code, result = self.invoke('create')
        self.assertEqual(code, 1)
        self.assertEqual(result['failed_step'], 'link_precheck')
        self.assertEqual(self.statuses(result), ['pending', 'pending'])
        self.assertEqual(self.jira.link_posts, [])

    def test_readback_identity_fallback_when_create_has_no_id(self):
        original = self.jira.handle
        def no_create_id(request):
            response = original(request)
            if request.method == 'POST' and request.url.path == '/rest/api/3/issue':
                return httpx.Response(201, json={'key': 'RI-999'})
            return response
        with patch.object(self.jira, 'handle', side_effect=no_create_id):
            code, result = self.invoke('create')
        self.assertEqual(code, 0)
        self.assertEqual(self.statuses(result), ['verified', 'verified'])

    def test_all_dry_run_aliases_with_links_never_write(self):
        for command, extra in (('dry-run', []), ('--dry-run', []), ('create', ['--dry-run'])):
            self.path.write_text(json.dumps(self.draft), encoding='utf-8')
            output = io.StringIO()
            client = httpx.Client(base_url='https://jira.example/', transport=httpx.MockTransport(self.jira.handle))
            with patch.object(cli, 'configuration', return_value=self.config), patch.object(cli, 'client_for', return_value=client), redirect_stdout(output):
                self.assertEqual(cli.main([command, '--draft', str(self.path), *extra]), 0)
            self.assertEqual(len(json.loads(output.getvalue())['post_create_links']), 2)
            self.assert_no_writes()

    def test_core_validates_links_defensively_before_any_requests(self):
        with httpx.Client(base_url='https://jira.example/', transport=httpx.MockTransport(self.jira.handle)) as client:
            creator = Creator(client)
            for links in ('bad', {}, [self.links[0] | {'direction': 'blocks'}], [self.links[0] | {'unexpected': 'SECRET'}]):
                with self.assertRaises(Failure):
                    creator.prepare(project='RI', summary='Summary', description=text_adf('Description'), issue_type='Task', status='Done', points='unset', links=links)
        self.assertEqual(self.jira.requests, [])


if __name__ == '__main__':
    unittest.main()
