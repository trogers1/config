"""Sprint flows through the public CLI and the existing in-memory Jira service."""
import copy
from contextlib import redirect_stdout, redirect_stderr
import io
import json
import unittest
from unittest.mock import patch

import httpx
from jira_ticket import cli
from jira_ticket.sprints import SPRINT_SCHEMA, validate_request, validate_sprint
import test_existing_ticket


class SprintJira(test_existing_ticket.ExistingJira):
    def __init__(self):
        super().__init__()
        self.sprint_field = 'customfield_87234'
        self.catalog.append({'id': self.sprint_field, 'name': 'Localized sprint name',
                             'schema': {'type': 'array', 'items': 'json', 'custom': SPRINT_SCHEMA}})
        self.sprints = [validate_sprint(value={'id': 701, 'name': 'Approved sprint', 'state': 'active'}),
                        validate_sprint(value={'id': 702, 'name': 'Parallel sprint', 'state': 'active'}),
                        validate_sprint(value={'id': 699, 'name': 'History', 'state': 'closed'}),
                        validate_sprint(value={'id': 703, 'name': 'Future plan', 'state': 'future'})]
        self.active_ids = {self.sprints[0]['id']}
        self.actual[self.sprint_field] = [copy.deepcopy(self.sprints[2])]
        self.sprint_posts = []
        self.sprint_failure = None
        self.page_failure = None
        self.drift = None
        self.active_reads = 0
        self.board_projects = []

    def handle(self, request):
        path = request.url.path
        method = request.method
        if path == '/rest/agile/1.0/board':
            self.requests.append((method, 'agile/board'))
            self.board_projects.append(request.url.params['projectKeyOrId'])
            start = int(request.url.params['startAt'])
            data = {'values': self.boards[start:start + 1], 'startAt': start,
                    'total': len(self.boards), 'isLast': start + 1 >= len(self.boards)}
            if self.page_failure == 'offset':
                data['startAt'] = start + 1
            elif self.page_failure == 'contradiction':
                data['isLast'] = False
            elif self.page_failure == 'repeated':
                data['values'] = self.boards[:1]
                data['total'] = 2
                data['isLast'] = start >= 1
            return httpx.Response(200, json=data)
        if path.startswith('/rest/agile/1.0/board/') and path.endswith('/sprint'):
            self.requests.append((method, 'active_sprints'))
            assert request.url.params['state'] == 'active'
            start = int(request.url.params['startAt'])
            if start == 0:
                self.active_reads += 1
            if self.drift == 'rollover' and self.active_reads > 1:
                self.active_ids = {self.sprints[1]['id']}
            if self.drift == 'membership' and self.active_reads > 1:
                self.actual[self.sprint_field].append(copy.deepcopy(self.sprints[3]))
            active = [s for s in self.sprints if s['id'] in self.active_ids]
            return httpx.Response(200, json={'values': active[start:start + 1], 'startAt': start,
                                            'total': len(active), 'isLast': start + 1 >= len(active)})
        if path.startswith('/rest/agile/1.0/sprint/') and not path.endswith('/issue'):
            self.requests.append((method, 'sprint_metadata'))
            identity = path.rsplit('/', 1)[1]
            sprint = next(s for s in self.sprints if s['id'] == identity)
            return httpx.Response(200, json=sprint)
        if method == 'POST' and (path.endswith('/issue') and '/sprint/' in path or path == '/rest/agile/1.0/backlog'):
            self.requests.append((method, path))
            body = json.loads(request.content)
            assert body == {'issues': ['999']}
            self.sprint_posts.append((path, body))
            if self.sprint_failure == 'http':
                return httpx.Response(403, json={'SECRET': 'private server detail'})
            self.actual[self.sprint_field] = [s for s in self.actual[self.sprint_field] if s['state'] == 'closed']
            if path.endswith('/issue'):
                identity = path.split('/')[-2]
                self.actual[self.sprint_field].append(copy.deepcopy(next(s for s in self.sprints if s['id'] == identity)))
            if self.sprint_failure == 'history':
                self.actual[self.sprint_field] = [s for s in self.actual[self.sprint_field] if s['state'] != 'closed']
            if self.sprint_failure == 'extra':
                self.actual[self.sprint_field].append(copy.deepcopy(self.sprints[3]))
            if self.sprint_failure == 'timeout':
                raise httpx.ReadTimeout('SECRET', request=request)
            return httpx.Response(204)
        if request.url.params.get('fields') == self.sprint_field:
            self.requests.append((method, 'sprint_memberships'))
            assert path == '/rest/api/3/issue/999'
            if self.sprint_failure == 'verification_http' and self.active_reads > 2:
                return httpx.Response(500, json={'SECRET': 'private server detail'})
            if self.sprint_posts and self.sprint_failure == 'readback':
                return httpx.Response(200, json={'id': '999', 'fields': {}})
            return httpx.Response(200, json={'id': '999', 'key': self.key,
                                            'fields': {self.sprint_field: self.actual[self.sprint_field]}})
        return super().handle(request)


class SprintCliTests(unittest.TestCase):
    invoke = test_existing_ticket.ExistingCliTests.invoke
    assert_read_only = test_existing_ticket.ExistingCliTests.assert_read_only

    def setUp(self):
        test_existing_ticket.ExistingCliTests.setUp(self)
        self.jira = SprintJira()
        self.config.default_project_key_or_id = 'WRONG_DEFAULT'
        self.request = validate_request(value={'action': 'add', 'id': self.jira.sprints[0]['id']})

    def discover(self, *, board=None):
        args = ['sprints', 'RI-999'] + (['--board', board] if board is not None else [])
        client = httpx.Client(base_url='https://jira.example/', transport=httpx.MockTransport(self.jira.handle))
        output = io.StringIO()
        with patch.object(cli, 'configuration', return_value=self.config), patch.object(cli, 'client_for', return_value=client), redirect_stdout(output):
            code = cli.main(args)
        self.assertNotIn('SECRET', output.getvalue())
        return code, json.loads(output.getvalue())

    def test_discover_preview_approve_add_remove_and_noops_preserve_history(self):
        code, choices = self.discover()
        self.assertEqual((code, choices['outcome']), (0, 'sprints'))
        self.assertEqual(choices['boards'][0]['active_sprints'], [self.jira.sprints[0]])
        self.assertEqual(set(self.jira.board_projects), {self.jira.actual['project']['id']})
        code, plan = self.invoke({'sprint': self.request}, dry=True)
        self.assertEqual((code, plan['outcome']), (0, 'dry_run'))
        self.assertEqual(plan['sprint']['id'], self.request['id'])
        self.assertEqual(plan['sprint']['field_id'], self.jira.sprint_field)
        self.assertEqual(plan['payload'], {'fields': {}})
        self.assert_read_only()
        for action in ('add', 'add', 'remove', 'remove'):
            before = len(self.jira.sprint_posts)
            code, result = self.invoke({'sprint': self.request | {'action': action}})
            self.assertEqual(code, 0, result)
            self.assertEqual(result['sprint']['status'], 'verified')
            self.assertIn('sprint', result['verified_fields'])
            self.assertEqual(self.jira.actual[self.jira.sprint_field][0], self.jira.sprints[2])
            self.assertEqual(result['writes'], len(self.jira.sprint_posts) - before)
        self.assertEqual(len(self.jira.sprint_posts), 2)
        self.assertTrue(self.jira.sprint_posts[-1][0].endswith('/backlog'))
        self.assertEqual(self.jira.puts, [])

    def test_multiple_boards_need_context_parallel_active_sprints_select_exact_id(self):
        self.jira.boards.append(self.jira.boards[0] | {'id': 6111, 'name': 'Another Scrum board'})
        self.jira.active_ids.add(self.jira.sprints[1]['id'])
        code, result = self.discover()
        self.assertEqual(code, 0)
        self.assertEqual(len(result['boards']), 2)
        self.assertEqual(len(result['boards'][0]['active_sprints']), 2)
        code, result = self.invoke({'sprint': self.request}, dry=True)
        self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
        code, result = self.invoke({'sprint': self.request, 'board': str(self.jira.boards[1]['id'])}, dry=True)
        self.assertEqual(code, 0, result)
        self.assertEqual(result['sprint']['board']['id'], str(self.jira.boards[1]['id']))
        self.assert_read_only()

    def test_extra_memberships_reject_destructive_add_and_remove_before_any_write(self):
        for state_index in (1, 3):
            for action in ('add', 'remove'):
                self.jira = SprintJira()
                self.jira.actual[self.jira.sprint_field].append(copy.deepcopy(self.jira.sprints[state_index]))
                if action == 'remove':
                    self.jira.actual[self.jira.sprint_field].append(copy.deepcopy(self.jira.sprints[0]))
                code, result = self.invoke({'summary': 'Approved', 'sprint': self.request | {'action': action}})
                self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
                self.assertIn('additional active or future', result['message'])
                self.assert_read_only()

    def test_noop_never_invokes_issue_wide_operation_for_other_memberships(self):
        self.jira.actual[self.jira.sprint_field].extend(copy.deepcopy([self.jira.sprints[0], self.jira.sprints[3]]))
        code, result = self.invoke({'sprint': self.request})
        self.assertEqual((code, result['outcome']), (0, 'unchanged'))
        self.jira.actual[self.jira.sprint_field] = [s for s in self.jira.actual[self.jira.sprint_field] if s['id'] != self.request['id']]
        before = copy.deepcopy(self.jira.actual[self.jira.sprint_field])
        code, result = self.invoke({'sprint': self.request | {'action': 'remove'}})
        self.assertEqual((code, result['outcome']), (0, 'unchanged'))
        self.assertEqual(self.jira.actual[self.jira.sprint_field], before)
        self.assertEqual(self.jira.sprint_posts, [])
        self.assert_read_only()

    def test_noop_first_verification_failure_is_unverified_without_uncertain_mutation(self):
        for action in ('add', 'remove'):
            with self.subTest(action=action):
                self.jira = SprintJira()
                if action == 'add':
                    self.jira.actual[self.jira.sprint_field].append(copy.deepcopy(self.jira.sprints[0]))
                self.jira.sprint_failure = 'verification_http'
                code, result = self.invoke({'sprint': self.request | {'action': action}, 'links': self.links})
                self.assertEqual((code, result['outcome']), (1, 'partial_failure'))
                self.assertEqual(result['failed_step'], 'sprint_verification')
                self.assertEqual(result['sprint']['status'], 'unverified')
                self.assertFalse(result['sprint']['write_needed'])
                self.assertEqual(result['writes'], 0)
                self.assertEqual(self.jira.active_reads, 3)
                self.assertNotIn('uncertain_operation', result)
                self.assertEqual(self.jira.sprint_posts, [])
                self.assertEqual(self.jira.link_posts, [])
                self.assertEqual([link['status'] for link in result['links']], ['pending', 'pending'])
                self.assert_read_only()

    def test_rollover_between_preview_execute_never_retargets(self):
        code, _ = self.invoke({'sprint': self.request}, dry=True)
        self.assertEqual(code, 0)
        self.jira.active_ids = {self.jira.sprints[1]['id']}
        code, result = self.invoke({'sprint': self.request})
        self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
        self.assertIn('Exact approved sprint ID', result['message'])
        self.assert_read_only()

    def test_precheck_drift_stops_after_prior_verified_edit_before_sprint_and_links(self):
        for drift in ('rollover', 'membership'):
            self.jira = SprintJira()
            self.jira.drift = drift
            code, result = self.invoke({'summary': 'Approved', 'sprint': self.request, 'links': self.links})
            self.assertEqual((code, result['outcome']), (1, 'partial_failure'))
            self.assertEqual(result['failed_step'], 'sprint_precheck')
            self.assertEqual(result['sprint']['status'], 'pending')
            self.assertNotIn('uncertain_operation', result)
            self.assertEqual(result['writes'], 1)
            self.assertEqual(self.jira.sprint_posts, [])
            self.assertEqual(self.jira.link_posts, [])

    def test_uncertain_writes_and_readbacks_stop_without_retry_or_later_links(self):
        for failure in ('http', 'timeout', 'readback', 'history', 'extra'):
            self.jira = SprintJira()
            self.jira.sprint_failure = failure
            code, result = self.invoke({'sprint': self.request, 'links': self.links})
            self.assertEqual((code, result['outcome']), (1, 'partial_failure'), result)
            self.assertEqual(result['sprint']['status'], 'unverified')
            self.assertEqual(result['uncertain_operation'], 'sprint_update')
            self.assertEqual(result['failed_step'], 'sprint_update' if failure in ('http', 'timeout') else 'sprint_verification')
            self.assertEqual(len(self.jira.sprint_posts), 1)
            self.assertEqual(self.jira.link_posts, [])
            self.assertEqual([link['status'] for link in result['links']], ['pending', 'pending'])
            self.assertIn(self.request['id'], result['remaining_action'])
            self.assertEqual(result['id'], '999')
            self.assertEqual(result['link'], 'https://browser.example/browse/RI-999')

    def test_combined_estimate_status_sprint_links_and_shared_board_context(self):
        for agile in (False, True):
            self.jira = SprintJira()
            if agile:
                del self.jira.edit['customfield_10004']
            draft = {'story_points': 2, 'status': 'Done', 'sprint': self.request,
                     'board': str(self.jira.boards[0]['id']), 'links': self.links}
            code, result = self.invoke(draft)
            self.assertEqual((code, result['outcome']), (0, 'updated'), result)
            writes = [path for method, path in self.jira.requests if method != 'GET']
            self.assertEqual(len(writes), 5)
            self.assertEqual(writes[1], 'issue/999/transitions')
            self.assertIn('/sprint/' + self.request['id'] + '/issue', writes[2])
            self.assertEqual(writes[-2:], ['issueLink', 'issueLink'])

    def test_malformed_boards_sprints_fields_membership_and_pagination_fail_closed(self):
        for failure in ('offset', 'contradiction', 'repeated', 'board', 'duplicate_board', 'kanban',
                        'no_active', 'duplicate_sprint', 'state', 'schema', 'ambiguous_field',
                        'missing_field', 'serialized', 'membership', 'duplicate_membership'):
            self.jira = SprintJira()
            if failure in ('offset', 'contradiction', 'repeated'):
                self.jira.page_failure = failure
            elif failure == 'board':
                self.jira.boards[0]['id'] = True
            elif failure == 'duplicate_board':
                self.jira.boards.append(copy.deepcopy(self.jira.boards[0]))
            elif failure == 'kanban':
                self.jira.boards[0]['type'] = 'kanban'
            elif failure == 'no_active':
                self.jira.active_ids.clear()
            elif failure == 'duplicate_sprint':
                self.jira.sprints.append(copy.deepcopy(self.jira.sprints[0]))
            elif failure == 'state':
                self.jira.sprints[0]['state'] = 'future'
            elif failure == 'schema':
                self.jira.catalog[-1]['schema']['items'] = 'string'
            elif failure == 'ambiguous_field':
                self.jira.catalog.append(copy.deepcopy(self.jira.catalog[-1]))
            elif failure == 'missing_field':
                self.jira.catalog.pop()
            elif failure == 'serialized':
                self.jira.actual[self.jira.sprint_field] = ['legacy SECRET']
            elif failure == 'membership':
                self.jira.actual[self.jira.sprint_field] = [{}]
            else:
                self.jira.actual[self.jira.sprint_field] *= 2
            code, result = self.invoke({'summary': 'Approved', 'sprint': self.request})
            self.assertEqual((code, result['outcome']), (1, 'preflight_failed'), failure)
            self.assert_read_only()

    def test_sprint_project_type_move_rejected_and_same_context_allowed(self):
        code, result = self.invoke({'project': 'OTHER', 'sprint': self.request})
        self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
        self.assertIn('actual project/type move', result['message'])
        self.assert_read_only()
        self.jira.types.append({'id': '4', 'name': 'Another type', 'subtask': False})
        code, result = self.invoke({'type': 'Another type', 'sprint': self.request})
        self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
        self.assertIn('actual project/type move', result['message'])
        self.assert_read_only()
        code, result = self.invoke({'project': 'RI', 'type': 'Task', 'sprint': self.request}, dry=True)
        self.assertEqual(code, 0, result)
        self.assert_read_only()

    def test_offline_schema_help_and_create_rejection(self):
        for value in ('current', None, {}, {'action': 'add', 'id': 701},
                      self.request | {'id': 'SECRET'}, self.request | {'action': 'backlog'}, self.request | {'extra': 'SECRET'}):
            self.path.write_text(json.dumps({'sprint': value}), encoding='utf-8')
            with patch.object(cli, 'configuration') as config, redirect_stdout(io.StringIO()) as output:
                self.assertEqual(cli.main(['update', '999', '--draft', str(self.path)]), 1)
            config.assert_not_called()
            self.assertNotIn('SECRET', output.getvalue())
        self.path.write_text(json.dumps(cli.example_draft() | {'sprint': self.request}), encoding='utf-8')
        with patch.object(cli, 'configuration') as config, redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(['create', '--draft', str(self.path)]), 1)
        config.assert_not_called()
        for args in (['sprints', '--help'], ['sprints', '../SECRET'], ['sprints', '999', '--board', 'SECRET']):
            with patch.object(cli, 'configuration') as config, redirect_stdout(io.StringIO()) as output, redirect_stderr(output):
                if '--help' in args:
                    with self.assertRaises(SystemExit) as raised:
                        cli.main(args)
                    self.assertEqual(raised.exception.code, 0)
                else:
                    self.assertEqual(cli.main(args), 1)
            config.assert_not_called()
            self.assertNotIn('SECRET', output.getvalue())
        self.assertEqual(self.jira.requests, [])


if __name__ == '__main__':
    unittest.main()
