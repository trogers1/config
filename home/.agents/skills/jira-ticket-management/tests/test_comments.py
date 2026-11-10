"""Comment reads and additions through the public CLI; httpx only, no Jira/config."""
import copy
from contextlib import redirect_stdout
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
from test_existing_ticket import ExistingJira


ME = {'accountId': 'me', 'displayName': 'Taylor Rogers', 'active': True}


class CommentJira(ExistingJira):
    def __init__(self):
        super().__init__()
        self.page_size = 2
        self.myself = dict(ME)
        self.comments = [self.comment(id=str(n), author={'accountId': 'someone', 'displayName': 'Someone'},
                                      body=text_adf(f'Existing comment {n}')) for n in (101, 102, 103)]
        self.comments[0]['visibility'] = {'type': 'role', 'value': 'Developers', 'identifier': 'SECRET-ish'}
        self.posts = []
        self.comment_failure = None
        self.can_comment = True
        self.page_hook = None

    @staticmethod
    def comment(*, id, author, body):
        return {'id': id, 'self': 'https://jira.example/SECRET', 'author': {**author, 'self': 'SECRET'},
                'updateAuthor': author, 'body': body, 'created': '2026-11-01T10:00:00.000+0000',
                'updated': '2026-11-01T10:00:00.000+0000', 'jsdPublic': True}

    def handle(self, request):
        path = request.url.path.removeprefix('/rest/api/3/')
        if path == 'myself':
            self.requests.append((request.method, path))
            return httpx.Response(200, json=self.myself)
        if path == 'mypermissions':
            self.requests.append((request.method, path))
            assert dict(request.url.params) == {'issueId': '999', 'permissions': 'ADD_COMMENTS'}
            return httpx.Response(200, json={'permissions': {'ADD_COMMENTS': {'key': 'ADD_COMMENTS', 'havePermission': self.can_comment}}})
        if path == 'issue/999/comment':
            self.requests.append((request.method, path))
            if request.method == 'GET':
                assert request.url.params['orderBy'] == 'created'
                start = int(request.url.params['startAt'])
                if start and self.page_hook:
                    self.page_hook(self)
                page = self.comments[start:start + self.page_size]
                return httpx.Response(200, json={'startAt': start, 'maxResults': self.page_size,
                                                 'total': len(self.comments), 'comments': page})
            assert request.method == 'POST'
            body = json.loads(request.content)
            assert set(body) == {'body'}
            self.posts.append(body)
            if self.comment_failure == 'http':
                return httpx.Response(400, json={'SECRET': 'server'})
            created = self.comment(id='900', author={'accountId': self.myself['accountId'], 'displayName': 'Taylor Rogers'},
                                   body=copy.deepcopy(body['body']))
            self.comments.append(created)
            if self.comment_failure == 'timeout':
                raise httpx.ReadTimeout('SECRET', request=request)
            return httpx.Response(201, json={} if self.comment_failure == 'no_id' else created)
        if path == 'issue/999/comment/900':
            self.requests.append((request.method, path))
            assert request.method == 'GET'
            created = copy.deepcopy(self.comments[-1])
            if self.comment_failure == 'author':
                created['author'] = {'accountId': 'someone-else'}
            if self.comment_failure == 'body':
                created['body'] = text_adf('Different')
            return httpx.Response(200, json=created)
        return super().handle(request)


class CommentTests(unittest.TestCase):
    def setUp(self):
        self.jira = CommentJira()
        self.config = SimpleNamespace(default_project_key_or_id='RI', jira_base_url='https://browser.example', jira_api_base_url='https://jira.example')
        directory = TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)

    def invoke(self, *args):
        output = io.StringIO()
        client = httpx.Client(base_url='https://jira.example/', transport=httpx.MockTransport(self.jira.handle))
        with patch.object(cli, 'configuration', return_value=self.config), patch.object(cli, 'client_for', return_value=client), redirect_stdout(output):
            code = cli.main(list(args))
        self.assertNotIn('SECRET', output.getvalue())
        return code, json.loads(output.getvalue())

    def body_file(self, content, name='comment.txt'):
        path = self.directory / name
        path.write_text(content, encoding='utf-8')
        return str(path)

    def comment_requests(self):
        return [r for r in self.jira.requests if '/comment' in r[1]]

    def test_get_omits_comments_unless_requested(self):
        code, result = self.invoke('get', 'RI-999')
        self.assertEqual((code, result['outcome']), (0, 'issue'))
        self.assertNotIn('comments', result)
        self.assertEqual(self.comment_requests(), [])

    def test_get_with_comments_reads_all_pages_oldest_first(self):
        code, result = self.invoke('get', 'RI-999', '--comments')
        self.assertEqual((code, result['outcome']), (0, 'issue'))
        self.assertEqual(result['details']['summary'], self.jira.actual['summary'])
        self.assertEqual([c['id'] for c in result['comments']], ['101', '102', '103'])
        self.assertEqual(result['comments'][0], {
            'id': '101', 'author': {'accountId': 'someone', 'displayName': 'Someone'},
            'created': '2026-11-01T10:00:00.000+0000', 'updated': '2026-11-01T10:00:00.000+0000',
            'visibility': {'type': 'role', 'value': 'Developers'}, 'body': text_adf('Existing comment 101')})
        self.assertIsNone(result['comments'][1]['visibility'])
        self.assertEqual(len(self.comment_requests()), 2)
        self.assertTrue(all(m == 'GET' for m, _ in self.jira.requests))

    def test_get_with_malformed_or_repeated_comments_fails(self):
        for corrupt in (lambda c: c.update(author={'displayName': 'No account'}), lambda c: c.update(body='text'), lambda c: c.update(id='x'),
                        lambda c: c.update(visibility='role')):
            with self.subTest(corrupt=corrupt):
                self.jira = CommentJira()
                corrupt(self.jira.comments[2])
                code, result = self.invoke('get', 'RI-999', '--comments')
                self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
        for change in (lambda j: j.comments[2].update(id='101'),
                       lambda j: setattr(j, 'page_hook', lambda jira: jira.comments.pop(0)),
                       lambda j: setattr(j, 'page_hook', lambda jira: jira.comments.append(jira.comments[-1] | {'id': '104'}))):
            with self.subTest(change=change):
                self.jira = CommentJira()
                change(self.jira)
                code, result = self.invoke('get', 'RI-999', '--comments')
                self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))

    def test_get_with_no_comments_or_anonymous_author(self):
        self.jira.comments = []
        code, result = self.invoke('get', 'RI-999', '--comments')
        self.assertEqual((code, result['comments']), (0, []))
        self.assertEqual(len(self.comment_requests()), 1)
        self.jira = CommentJira()
        del self.jira.comments[1]['author']
        code, result = self.invoke('get', 'RI-999', '--comments')
        self.assertEqual(code, 0)
        self.assertIsNone(result['comments'][1]['author'])

    def test_dry_run_shows_authenticated_author_and_writes_nothing(self):
        code, result = self.invoke('comment', 'RI-999', '--text-file', self.body_file('Looks good.\n\nShip it.\n\n'), '--dry-run')
        self.assertEqual((code, result['outcome']), (0, 'dry_run'))
        self.assertTrue(result['read_only'])
        self.assertEqual((result['id'], result['key'], result['link']), ('999', 'RI-999', 'https://browser.example/browse/RI-999'))
        self.assertEqual(result['author'], {'accountId': 'me', 'displayName': 'Taylor Rogers'})
        self.assertEqual(result['payload'], {'body': text_adf('Looks good.\n\nShip it.\n')})
        self.assertEqual(result['payload']['body']['content'][-1], {'type': 'paragraph', 'content': []})
        self.assertTrue(all(m == 'GET' for m, _ in self.jira.requests))
        self.assertEqual(self.jira.posts, [])

    def test_add_text_comment_posts_once_by_id_and_verifies(self):
        code, result = self.invoke('comment', 'RI-999', '--text-file', self.body_file('Looks *good*.\r\nThanks'))
        self.assertEqual((code, result['outcome']), (0, 'commented'))
        self.assertEqual(self.jira.posts, [{'body': text_adf('Looks *good*.\nThanks')}])
        self.assertIn(('POST', 'issue/999/comment'), self.jira.requests)
        self.assertEqual(result['comment']['author']['accountId'], 'me')
        self.assertEqual(result['comment']['link'], 'https://browser.example/browse/RI-999?focusedCommentId=900')
        self.assertEqual(result['comment']['body'], self.jira.posts[0]['body'])

    def test_add_adf_comment(self):
        adf = {'type': 'doc', 'version': 1, 'content': [{'type': 'codeBlock', 'attrs': {'language': 'sh'}, 'content': [{'type': 'text', 'text': 'uv run pytest'}]}]}
        code, result = self.invoke('comment', '999', '--adf-file', self.body_file(json.dumps(adf), 'comment.json'))
        self.assertEqual((code, result['outcome']), (0, 'commented'))
        self.assertEqual(self.jira.posts, [{'body': adf}])

    def test_inactive_unverified_or_unpermitted_author_fails_before_write(self):
        for change, message in ((lambda j: j.myself.update(active=False), 'not active'),
                                (lambda j: j.myself.pop('accountId'), 'could not be verified'),
                                (lambda j: setattr(j, 'can_comment', False), 'cannot add comments')):
            with self.subTest(message=message):
                self.jira = CommentJira()
                change(self.jira)
                code, result = self.invoke('comment', 'RI-999', '--text-file', self.body_file('Hi'), '--dry-run')
                self.assertEqual((code, result['outcome']), (1, 'preflight_failed'))
                self.assertIn(message, result['message'])
                self.assertEqual(self.jira.posts, [])

    def test_failures_after_post_are_partial_and_never_retried(self):
        for failure, step in (('http', 'comment_create'), ('timeout', 'comment_create'), ('no_id', 'comment_verification'),
                              ('author', 'comment_verification'), ('body', 'comment_verification')):
            with self.subTest(failure=failure):
                self.jira = CommentJira()
                self.jira.comment_failure = failure
                code, result = self.invoke('comment', 'RI-999', '--text-file', self.body_file('Hi'))
                self.assertEqual((code, result['outcome']), (1, 'partial_failure'))
                self.assertEqual((result['failed_step'], result['uncertain_operation']), (step, 'comment_create'))
                self.assertEqual(len(self.jira.posts), 1)
                self.assertIn('Do not repeat uncertain writes', result['message'])
                self.assertIn('never repost', result['remaining_action'])
                self.assertEqual(result['link'], 'https://browser.example/browse/RI-999')
                if failure in ('author', 'body'):
                    self.assertEqual(result['comment_id'], '900')
                    self.assertEqual(result['comment_link'], 'https://browser.example/browse/RI-999?focusedCommentId=900')
                    self.assertIn(result['comment_link'], result['remaining_action'])
                else:
                    self.assertNotIn('comment_id', result)

    def test_invalid_input_fails_before_configuration(self):
        cases = [['RI-999', '--text-file', self.body_file('  \n\n', 'blank.txt')],
                 ['RI-999', '--text-file', str(self.directory / 'missing.txt')],
                 ['RI-999', '--adf-file', self.body_file('not json', 'bad.json')],
                 ['RI-999', '--adf-file', self.body_file(json.dumps({'type': 'doc', 'version': 1, 'content': [{'type': 'mediaSingle', 'content': []}]}), 'unsupported.json')],
                 ['RI-999', '--text-file', self.body_file('\ufeffHi', 'bom.txt')],
                 ['RI-999', '--adf-file', self.body_file('{"type": "doc", "version": 1, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Approved", "text": "Other"}]}]}', 'duplicate.json')],
                 ['https://SECRET', '--text-file', self.body_file('Hi')]]
        for args in cases:
            with self.subTest(args=args), patch.object(cli, 'configuration') as config:
                output = io.StringIO()
                with redirect_stdout(output):
                    self.assertEqual(cli.main(['comment', *args]), 1)
                config.assert_not_called()
                self.assertNotIn('SECRET', output.getvalue())

    def test_body_source_is_required_and_exclusive(self):
        for args in (['comment', 'RI-999'], ['comment', 'RI-999', '--text-file', 'a', '--adf-file', 'b']):
            with self.subTest(args=args), patch.object(cli, 'configuration') as config, redirect_stdout(io.StringIO()), \
                    patch('sys.stderr', io.StringIO()), self.assertRaises(SystemExit) as exit:
                cli.main(args)
            self.assertEqual(exit.exception.code, 2)
            config.assert_not_called()
