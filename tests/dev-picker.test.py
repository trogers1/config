#!/usr/bin/env python3
"""Public dev list/switch flows: real Git, isolated state, strict process fakes.

Run: python3 tests/dev-picker.test.py (90s suite / 8s per command bounds).
No real tmux, fzf, user registry, or conversation files are used.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

DEV = Path(__file__).resolve().parents[1] / "tmux_and_worktrees/bin/dev"
spec = importlib.util.spec_from_file_location('picker_format', DEV.parent / 'lib/dev_picker_format.py')
picker_format = importlib.util.module_from_spec(spec)
spec.loader.exec_module(picker_format)

FAKE_TMUX = r'''#!/usr/bin/env python3
import fcntl, json, os, sys
from pathlib import Path
root = Path(os.environ['FAKE_TMUX_DIR'])
args = sys.argv[1:]
with (root / 'log').open('a') as log:
    log.write(json.dumps(args) + '\n')
statefile = root / 'sessions.json'
state = json.loads(statefile.read_text()) if statefile.exists() else {}
cmd = args[0]
target = args[args.index('-t') + 1] if '-t' in args else ''
name = target.lstrip('=').split(':')[0]
if cmd == 'list-sessions':
    for session in sorted(state):
        if 'session_created' in args[-1]:
            print(str(state[session].get('_created', 0)) + '\t$' + str(state[session].get('_id', 0)) + '\t' + session)
        else:
            print(session)
elif cmd == 'has-session':
    # tmux prefers exact names, then accepts a unique prefix unless '=' is used.
    matched = name in state or (not target.startswith('=') and sum(s.startswith(name) for s in state) == 1)
    sys.exit(0 if matched else 1)
elif cmd == 'show-environment':
    key = args[-1]
    if name not in state or key not in state[name]: sys.exit(1)
    print(key + '=' + state[name][key])
elif cmd == 'set-environment':
    if '-u' in args: state[name].pop(args[-1], None)
    else: state[name][args[-2]] = args[-1]
elif cmd == 'new-session':
    name = args[args.index('-s') + 1]
    if name in state: sys.exit('session already exists')
    next_id = max((values.get('_id', 0) for values in state.values()), default=0) + 1
    state[name] = {'_created': next_id, '_id': next_id}
    if '-P' in args: print('%1')
elif cmd == 'new-window':
    if '-P' in args: print('%1')
elif cmd == 'kill-session':
    del state[name]
elif cmd == 'display-message':
    if args[-1] == '#S':
        print(os.environ.get('FAKE_CURRENT', ''))
    else:
        if name not in state: sys.exit(1)
        print(name + '\t%1\t/fake/socket\t123')
elif cmd in ('attach-session', 'switch-client'):
    if name not in state: sys.exit('no exact session: ' + name)
    # Prove the production lifecycle lock has been released before attachment.
    lock = Path(os.environ['XDG_STATE_HOME']) / 'dev/lifecycle.lock'
    if lock.exists():
        with lock.open('a') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
elif cmd not in ('select-window', 'send-keys'):
    sys.exit('unsupported fake tmux operation: ' + repr(args))
statefile.write_text(json.dumps(state))
'''

FAKE_FZF = r'''#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
rows = sys.stdin.read().splitlines()
initial_rows = rows[:]
if os.environ.get('PICK_SCOPE') == 'all':
    rows = subprocess.check_output(['bash', os.environ['DEV_PICKER_HELPER']], text=True).splitlines()
Path(os.environ['FZF_LOG']).write_text(json.dumps({'args': sys.argv[1:], 'rows': rows, 'initial_rows': initial_rows,
    'defaults': os.environ.get('FZF_DEFAULT_OPTS'), 'file': os.environ.get('FZF_DEFAULT_OPTS_FILE')}))
mode = os.environ.get('PICK_MODE', 'select')
if mode == 'cancel' or (len(rows) == 1 and 'PICK_PATH' not in os.environ): sys.exit(130)
if mode == 'error': sys.exit(2)
if mode == 'invalid': print('$(touch ' + os.environ['MUTATION_TRAP'] + ')'); sys.exit(0)
if mode == 'multiple': print('\n'.join(rows)); sys.exit(0)
chosen = [row for row in rows[1:] if row.split('\t', 1)[1].endswith('  ' + os.environ['PICK_PATH'])]
if len(chosen) != 1:
    print('expected exactly one matching inventory row', file=sys.stderr)
    sys.exit(2)
print(chosen[0])
'''


class DevPickerTests(unittest.TestCase):
    def setUp(self):
        self.started = time.monotonic()
        self.temp = tempfile.TemporaryDirectory(prefix="dev-picker-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        for name, content in (("tmux", FAKE_TMUX), ("fzf", FAKE_FZF)):
            file = self.bin / name
            file.write_text(content)
            file.chmod(0o755)
        self.env = dict(os.environ)
        for key in ("TMUX", "TMUX_PANE", "DEV_LIFECYCLE_LOCK_FD", "DEV_LIFECYCLE_LOCK_OWNER", "PI_SUBAGENT_DEPTH"):
            self.env.pop(key, None)
        self.env.update(HOME=str(self.root / "home"), XDG_STATE_HOME=str(self.root / "state"),
                        XDG_CONFIG_HOME=str(self.root / "config"), PATH=f"{self.bin}:{os.environ['PATH']}",
                        GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1",
                        GIT_AUTHOR_NAME="test", GIT_AUTHOR_EMAIL="test@example.com",
                        GIT_COMMITTER_NAME="test", GIT_COMMITTER_EMAIL="test@example.com",
                        FAKE_TMUX_DIR=str(self.root / "tmux"), FZF_LOG=str(self.root / "fzf.json"),
                        MUTATION_TRAP=str(self.root / "injected"),
                        FZF_DEFAULT_OPTS="--print-query --multi --bind=start:execute(touch SHOULD_NOT_RUN)")
        Path(self.env["HOME"]).mkdir()
        Path(self.env["FAKE_TMUX_DIR"]).mkdir()
        self.repo = self.root / "project space"
        self.run_cmd(args=["git", "init", "-q", "-b", "main", str(self.repo)])
        (self.repo / "devConfig.jsonc").write_text('{"windows":[{"name":"term","command":""}]}')
        self.run_cmd(args=["git", "add", "."], cwd=self.repo)
        self.run_cmd(args=["git", "commit", "-qm", "initial"], cwd=self.repo)
        self.worktree = self.root / "project space-worktrees" / "topic"
        self.run_cmd(args=["git", "worktree", "add", "-qb", "topic", str(self.worktree)], cwd=self.repo)
        self.other = self.root / "elsewhere"
        self.run_cmd(args=["git", "worktree", "add", "-q", "--detach", str(self.other)], cwd=self.repo)
        self.stray = self.worktree.parent / "stray"
        self.stray.mkdir()

    def tearDown(self):
        print(f"  {self.id().split('.')[-1]}: {time.monotonic() - self.started:.2f}s", flush=True)

    def run_cmd(self, *, args, cwd=None, success=True):
        with subprocess.Popen(args, cwd=cwd or self.root, env=self.env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              start_new_session=True) as process:
            try:
                stdout, stderr = process.communicate(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
                raise
            result = subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def dev(self, *, args, cwd=None, success=True):
        return self.run_cmd(args=[str(DEV), *args], cwd=cwd, success=success)

    def sessions(self):
        file = Path(self.env['FAKE_TMUX_DIR']) / 'sessions.json'
        return json.loads(file.read_text()) if file.exists() else {}

    def log(self):
        file = Path(self.env['FAKE_TMUX_DIR']) / 'log'
        return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

    def choose(self, *, path, cwd=None, success=True, scope='open'):
        self.env['PICK_PATH'] = str(path)
        self.env['PICK_SCOPE'] = scope
        return self.dev(args=['switch'], cwd=cwd, success=success)

    def test_inventory_and_open_worktree(self):
        output = self.dev(args=['--list'], cwd=self.worktree)
        self.assertIn(f'Repository: {self.repo}', output)
        self.assertIn(f'Default worktree directory: {self.worktree.parent}', output)
        for path in (self.repo, self.worktree, self.other):
            self.assertIn(f'path: {path}', output)
        self.assertNotIn(str(self.stray), output)
        self.assertIn('branch: (detached)', output)
        (self.worktree / 'dirty').write_text('dirty')
        self.assertIn('status: dirty', self.dev(args=['--list'], cwd=self.repo))
        self.choose(path=self.worktree, cwd=self.repo, scope='all')
        self.assertEqual([s['DTREE_WORKTREE_PATH'] for s in self.sessions().values()], [str(self.worktree)])
        picker = json.loads(Path(self.env['FZF_LOG']).read_text())
        self.assertNotIn('--tmux=center,80%,70%', picker['args'])
        self.assertEqual(picker['defaults'], '')
        self.assertEqual(picker['file'], '/dev/null')
        self.assertEqual(len(picker['initial_rows']), 1)  # Empty OPEN scope still launches.
        self.assertIn('--prompt=OPEN> ', picker['args'])
        self.assertTrue(any(arg.startswith('--bind=ctrl-a:transform:') for arg in picker['args']))
        self.assertIn('Ctrl+A: show ALL', ' '.join(picker['args']))
        output = self.dev(args=['--list'], cwd=self.worktree)
        self.assertEqual(output.count(f'path: {self.worktree}\n'), 1)
        self.assertIn('open:', output)
        self.choose(path=self.worktree, cwd=self.repo)
        picker = json.loads(Path(self.env['FZF_LOG']).read_text())
        self.assertEqual(len(picker['initial_rows']), 2)
        self.assertIn('open', picker['initial_rows'][1])
        self.assertFalse(any(row.endswith('  ' + str(self.repo)) for row in picker['initial_rows'][1:]))

    def test_display_alignment_and_exact_untrusted_path(self):
        unusual = self.root / "wide 界 é $(touch injected) 'quoted'"
        self.run_cmd(args=['git', 'worktree', 'add', '-qb', 'long-branch-name', str(unusual)], cwd=self.repo)
        self.choose(path=unusual, cwd=self.repo, scope='all')
        state = self.sessions()
        state['session 界 é'] = state.pop(next(iter(state)))
        (Path(self.env['FAKE_TMUX_DIR']) / 'sessions.json').write_text(json.dumps(state))
        self.choose(path=unusual, cwd=self.repo, scope='all')
        picker = json.loads(Path(self.env['FZF_LOG']).read_text())
        rows = [row.split('\t', 1)[1] for row in picker['rows'][1:]]
        starts = [picker_format.width(text=row[:row.index(str(self.root))]) for row in rows]
        self.assertEqual(len(set(starts)), 1)
        self.assertTrue(all('\t' not in row for row in rows))
        self.assertIn(str(unusual), [s['DTREE_WORKTREE_PATH'] for s in self.sessions().values()])
        self.assertFalse((self.repo / 'injected').exists())

    def test_long_names_are_display_only_and_unicode_aligned(self):
        limit = picker_format.MAX_NAME_WIDTH
        self.run_cmd(args=['git', 'config', 'core.precomposeunicode', 'false'], cwd=self.repo)
        cases = [
            ('x' * limit, 'x' * limit),
            ('x' * limit + 'a', 'x' * (limit - 1) + '…'),
            ('x' * limit + 'b', 'x' * (limit - 1) + '…'),
            ('界' * limit, '界' * ((limit - 1) // 2) + '…'),
            ('é' * limit, 'é' * limit),
            ('é' * (limit + 1), 'é' * (limit - 1) + '…'),
        ]
        statefile = Path(self.env['FAKE_TMUX_DIR']) / 'sessions.json'
        for index, (name, displayed) in enumerate(cases):
            with self.subTest(name=name):
                path = self.root / f'long-name-{index}'
                self.run_cmd(args=['git', 'worktree', 'add', '-qb', name, str(path)], cwd=self.repo)
                self.dev(args=['tree', '--no-attach', name], cwd=self.repo)
                state = self.sessions()
                generated = next(key for key, value in state.items() if value['DTREE_WORKTREE_PATH'] == str(path))
                state[name] = state.pop(generated)
                statefile.write_text(json.dumps(state))
                for scope in ('open', 'all'):
                    self.choose(path=path, cwd=self.repo, scope=scope)
                    picker = json.loads(Path(self.env['FZF_LOG']).read_text())
                    rows = [row.split('\t', 1)[1] for row in picker['rows'][1:]]
                    selected = next(row for row in rows if row.endswith('  ' + str(path)))
                    self.assertEqual(re.split(r' {2,}', selected), ['open', displayed, displayed, str(path)])
                    starts = [picker_format.width(text=row[:row.index(str(self.root))]) for row in rows]
                    self.assertEqual(len(set(starts)), 1)
                    self.assertEqual(self.log()[-1], ['attach-session', '-t', '=' + name])
                self.assertIn('branch: ' + name, self.dev(args=['--list'], cwd=self.repo))

    def test_open_exact_attach_and_popup_switch_outside_repo(self):
        self.dev(args=['new', str(self.repo)])
        before = len(self.log())
        self.choose(path=self.repo)
        calls = self.log()[before:]
        session = next(iter(self.sessions()))
        self.assertIn(['attach-session', '-t', '=' + session], calls)
        self.assertFalse(any(call[0] == 'new-session' for call in calls))
        self.env['TMUX'] = '/fake/socket,123,0'
        self.choose(path=self.repo)
        self.assertEqual(self.log()[-1], ['switch-client', '-t', '=' + session])
        self.assertIn('--tmux=center,80%,70%', json.loads(Path(self.env['FZF_LOG']).read_text())['args'])
        statefile = Path(self.env['FAKE_TMUX_DIR']) / 'sessions.json'
        state = self.sessions()
        state['unmanaged-shell'] = {}
        statefile.write_text(json.dumps(state))
        output = self.dev(args=['--list'])
        self.assertIn('Outside a Git checkout', output)
        self.assertNotIn('unmanaged-shell', output)

    def test_selected_saved_only_and_missing_checkout(self):
        self.dev(args=['new', str(self.repo)])
        self.dev(args=['new', str(self.worktree)])
        registry = Path(self.env['XDG_STATE_HOME']) / 'dev/sessions.json'
        original_registry = registry.read_bytes()
        statefile = Path(self.env['FAKE_TMUX_DIR']) / 'sessions.json'
        statefile.write_text('{}')  # Simulate reboot without intentional closure.
        output = self.dev(args=['--list'])
        self.assertEqual(output.count('saved:'), 2)
        self.assertEqual(registry.read_bytes(), original_registry)
        self.choose(path=self.worktree, scope='all')
        self.assertEqual([s['DTREE_WORKTREE_PATH'] for s in self.sessions().values()], [str(self.worktree)])
        self.assertEqual(self.log()[-1][0], 'attach-session')
        # Missing checkouts remain visible; failed recovery must not attach/fallback.
        shutil.rmtree(self.repo)
        output = self.dev(args=['--list'])
        self.assertIn('status: missing', output)
        before = len(self.log())
        output = self.choose(path=self.repo, success=False, scope='all')
        self.assertIn('missing', output.lower())
        self.assertFalse(any(c[0] in ('attach-session', 'new-session') for c in self.log()[before:]))
        self.assertIn(str(self.repo), json.loads(registry.read_text())['sessions'])

    def test_recovery_ignores_unrelated_prefix_matching_session(self):
        self.dev(args=['new', str(self.repo)])
        registry = Path(self.env['XDG_STATE_HOME']) / 'dev/sessions.json'
        name = json.loads(registry.read_text())['sessions'][str(self.repo)]['name']
        prefix_match = name + '-other'
        statefile = Path(self.env['FAKE_TMUX_DIR']) / 'sessions.json'
        statefile.write_text(json.dumps({prefix_match: {}}))
        self.dev(args=['resume-all'])
        self.assertEqual(set(self.sessions()), {name, prefix_match})
        self.assertEqual(self.sessions()[name]['DTREE_WORKTREE_PATH'], str(self.repo))
        statefile.write_text(json.dumps({prefix_match: {}}))
        self.choose(path=self.repo, scope='all')
        self.assertEqual(set(self.sessions()), {name, prefix_match})
        self.assertEqual(self.log()[-1], ['attach-session', '-t', '=' + name])

    def test_cancellation_and_untrusted_picker_output(self):
        self.dev(args=['new', str(self.repo)])
        registry = Path(self.env['XDG_STATE_HOME']) / 'dev/sessions.json'
        original = registry.read_bytes()
        before = len(self.log())
        for mode in ('cancel', 'invalid', 'multiple', 'error'):
            self.env['PICK_MODE'] = mode
            output = self.dev(args=['switch'], cwd=self.repo, success=mode == 'cancel')
            if mode in ('invalid', 'multiple'):
                self.assertIn('invalid picker selection', output)
            self.assertEqual(registry.read_bytes(), original)
            self.assertFalse(Path(self.env['MUTATION_TRAP']).exists())
        self.assertFalse(any(c[0] in ('attach-session', 'switch-client', 'new-session', 'set-environment')
                             for c in self.log()[before:]))

    def test_saved_opening_order_survives_reuse_close_and_recovery(self):
        projects = [self.root / name for name in ('zulu', 'middle', 'alpha')]
        for project in projects:
            project.mkdir()
            (project / 'devConfig.jsonc').write_text((self.repo / 'devConfig.jsonc').read_text())
            self.dev(args=['new', str(project)])
        self.assertEqual(list(self.sessions()), sorted(self.sessions(), reverse=True))
        registry = Path(self.env['XDG_STATE_HOME']) / 'dev/sessions.json'
        statefile = Path(self.env['FAKE_TMUX_DIR']) / 'sessions.json'

        def order(*, expected, scope='open', cwd=None):
            before = registry.read_bytes()
            self.env['PICK_MODE'] = 'cancel'
            self.env['PICK_SCOPE'] = scope
            self.dev(args=['switch'], cwd=cwd)
            rows = json.loads(Path(self.env['FZF_LOG']).read_text())['rows'][1:]
            self.assertEqual([row.split('  ')[-1].lstrip() for row in rows], [str(path) for path in expected])
            self.assertEqual(registry.read_bytes(), before)

        order(expected=projects)
        order(expected=projects + [self.repo, self.other, self.worktree], scope='all', cwd=self.repo)
        # Reusing the first/current session is neither MRU nor current-last.
        self.dev(args=['new', str(projects[0])])
        self.env.update(TMUX='/fake/socket,123,0', FAKE_CURRENT=next(iter(self.sessions())))
        order(expected=projects)
        self.env.pop('TMUX')
        self.dev(args=['close'], cwd=projects[1])
        self.dev(args=['new', str(projects[1])])
        expected = [projects[0], projects[2], projects[1]]
        order(expected=expected)
        # A reboot loses live sessions but not persisted insertion order. Restore
        # the last entry first, so live creation order disagrees with saved order.
        statefile.write_text('{}')
        order(expected=[], scope='open')
        order(expected=expected, scope='all')
        self.env['PICK_MODE'] = 'select'
        self.choose(path=expected[-1], scope='all')
        order(expected=[expected[-1]])
        order(expected=expected, scope='all')  # saved/open entries stay mixed.
        self.dev(args=['resume-all'])
        self.dev(args=['resume-all'])  # Existing records must not move on retry.
        order(expected=expected)
        order(expected=expected, scope='all')

    def test_pretracking_sessions_follow_saved_then_creation_order(self):
        self.dev(args=['new', str(self.repo)])
        state = self.sessions()
        # Realistic legacy path tags with tied creation seconds and nonlexical
        # session ids. Untagged shells must not enter the managed picker.
        state.update({'alpha-legacy': {'DTREE_WORKTREE_PATH': str(self.other), '_created': 10, '_id': 11},
                      'zulu-legacy': {'DTREE_WORKTREE_PATH': str(self.worktree), '_created': 10, '_id': 2},
                      'unmanaged-shell': {'_created': 1, '_id': 0}})
        (Path(self.env['FAKE_TMUX_DIR']) / 'sessions.json').write_text(json.dumps(state))
        self.env['PICK_MODE'] = 'cancel'
        registry = Path(self.env['XDG_STATE_HOME']) / 'dev/sessions.json'
        before = registry.read_bytes()
        for scope in ('open', 'all'):
            self.env['PICK_SCOPE'] = scope
            self.dev(args=['switch'], cwd=self.repo)
            rows = json.loads(Path(self.env['FZF_LOG']).read_text())['rows'][1:]
            self.assertEqual([row.split('  ')[-1].lstrip() for row in rows],
                             list(map(str, (self.repo, self.worktree, self.other))))
            self.assertEqual(registry.read_bytes(), before)

    def test_missing_dependency_empty_and_malformed_registry(self):
        self.dev(args=['switch'])
        self.assertEqual(len(json.loads(Path(self.env['FZF_LOG']).read_text())['initial_rows']), 1)
        # Remove fake fzf and restrict PATH so a developer's installed fzf cannot leak in.
        (self.bin / 'fzf').unlink()
        for tool in ('dirname',):
            (self.bin / tool).symlink_to(shutil.which(tool))
        self.env['PATH'] = str(self.bin)
        self.assertIn('requires fzf', self.dev(args=['switch'], success=False))
        self.env['PATH'] = f"{self.bin}:{os.environ['PATH']}"
        (self.bin / 'fzf').write_text(FAKE_FZF)
        (self.bin / 'fzf').chmod(0o755)
        self.assertIn('No managed sessions', self.dev(args=['--list']))
        registry = Path(self.env['XDG_STATE_HOME']) / 'dev/sessions.json'
        registry.parent.mkdir(parents=True, exist_ok=True)
        registry.write_text('{"version":1,"sessions":{"relative":{}}}')
        self.assertIn('Invalid registry session path', self.dev(args=['--list'], success=False))
        # Both scopes fail explicitly when the ordering source is malformed.
        self.assertIn('Invalid registry session path', self.dev(args=['switch'], success=False))
        self.assertIn('switch', self.dev(args=['--help']))
        self.assertIn('Usage: dev switch', self.dev(args=['switch', 'unexpected'], success=False))


if __name__ == '__main__':
    signal.alarm(90)
    unittest.main(verbosity=2)
