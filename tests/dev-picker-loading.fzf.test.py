#!/usr/bin/env python3
"""Public dev switch + real fzf, with gated discovery and bounded PTY groups."""
import errno
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import sys
import termios
import time
import unittest

spec = importlib.util.spec_from_file_location('fixtures', Path(__file__).with_name('dev-picker.test.py'))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)

GIT = r'''#!/usr/bin/env python3
import json, os, sys, time
from pathlib import Path
root = Path(os.environ['PROBE_ROOT'])
with (root / 'git-probes').open('a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\n')
if 'status' in sys.argv:
    sys.exit('picker must never scan Git status')
if 'worktree' in sys.argv and 'list' in sys.argv:
    with (root / 'discovery-pids').open('a') as log:
        log.write(json.dumps({'pid': os.getpid(), 'group': os.getpgrp()}) + '\n')
    deadline = time.monotonic() + 8
    while not (root / 'release').exists():
        if time.monotonic() > deadline: sys.exit('gated discovery timed out')
        time.sleep(0.02)
    if (root / 'fail').exists(): sys.exit('deliberate worktree discovery failure: repair test checkout')
os.execv(os.environ['REAL_GIT'], [os.environ['REAL_GIT'], *sys.argv[1:]])
'''

PYTHON = r'''#!/bin/sh
case "$*" in *dev_registry.py*list*) printf 'registry list\n' >> "$PROBE_ROOT/registry-probes";; esac
exec "$REAL_PYTHON" "$@"
'''


@unittest.skipUnless(shutil.which('fzf'), 'real fzf required')
class LoadingTests(unittest.TestCase):
    def setUp(self):
        self.started = time.monotonic()
        self.f = fixtures.DevPickerTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.f.dev(args=['new', str(self.f.repo)])
        self.f.dev(args=['new', str(self.f.worktree)])
        self.f.run_cmd(args=['git', '-C', str(self.f.worktree), 'branch', '-m', 'topic-renamed'])
        # Keep one live OPEN and one saved checkout with deliberately stale
        # recorded branch metadata; ALL must use cheap actual branch metadata.
        sessions = self.f.sessions()
        sessions = {name: values for name, values in sessions.items()
                    if values['DTREE_WORKTREE_PATH'] == str(self.f.repo)}
        next(iter(sessions.values()))['DTREE_BRANCH'] = 'tmux-stored-branch'
        (Path(self.f.env['FAKE_TMUX_DIR']) / 'sessions.json').write_text(json.dumps(sessions))
        self.registry = Path(self.f.env['XDG_STATE_HOME']) / 'dev/sessions.json'
        self.before_registry = self.registry.read_bytes()
        self.before_sessions = self.f.sessions()
        (self.f.bin / 'fzf').unlink()
        (self.f.bin / 'fzf').symlink_to(shutil.which('fzf'))
        self.f.env.update(TERM='xterm-256color', SHELL='/bin/sh', PROBE_ROOT=str(self.f.root),
                          REAL_GIT=shutil.which('git'), REAL_PYTHON=sys.executable)
        for name, content in [('git', GIT), ('python3', PYTHON)]:
            (self.f.bin / name).write_text(content)
            (self.f.bin / name).chmod(0o755)
        self.picker_started = time.monotonic()
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(self.f.repo)
            os.execve(str(fixtures.DEV), [str(fixtures.DEV), 'switch'], self.f.env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 180, 0, 0))
        self.output = bytearray()
        self.deadline = time.monotonic() + 12
        self.addCleanup(self.close)

    def close(self):
        os.close(self.fd)
        if self.pid is not None:
            os.killpg(self.pid, signal.SIGKILL)
            os.waitpid(self.pid, 0)
        # Reload discovery is a separate fzf-owned process group. Check it really
        # died, and kill it on a failed test so no fake processes can escape.
        leaked = []
        file = self.f.root / 'discovery-pids'
        for record in map(json.loads, file.read_text().splitlines() if file.exists() else []):
            group = record['group']
            self.assertNotEqual(group, os.getpgrp(), 'reload must have an isolated process group')
            try:
                os.killpg(group, 0)
            except ProcessLookupError:
                continue
            leaked.append(record)
            try:
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.assertEqual(leaked, [], 'fzf leaked cancelled discovery processes')
        print(f'  {self.id().split(".")[-1]}: {time.monotonic() - self.started:.2f}s', flush=True)

    def wait(self, *, predicate, reason):
        while time.monotonic() < self.deadline:
            if predicate():
                return
            ready, _, _ = select.select([self.fd], [], [], 0.03)
            if ready:
                try:
                    self.output.extend(os.read(self.fd, 65536))
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
            time.sleep(0.01)
        self.fail(f'{reason}: {bytes(self.output[-5000:])!r}')

    def shown(self, *, text, since=0):
        self.wait(predicate=lambda: text in self.output[since:], reason=f'missing {text!r}')

    def press(self, *, keys):
        marker = len(self.output)
        os.write(self.fd, keys)
        return marker

    def exited(self, *, code):
        status = None

        def done():
            nonlocal status
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.pid = None
                return True
            return False

        self.wait(predicate=done, reason='picker did not exit')
        self.assertEqual(os.waitstatus_to_exitcode(status), code, bytes(self.output))
        self.assertEqual(self.registry.read_bytes(), self.before_registry)
        self.assertEqual(self.f.sessions(), self.before_sessions)

    def initial(self):
        self.shown(text=b'show ALL')
        self.shown(text=('open  ' + next(iter(self.before_sessions))).encode())
        self.shown(text=b'tmux-stored-branch')
        self.open_elapsed = time.monotonic() - self.picker_started
        self.assertFalse((self.f.root / 'git-probes').exists())
        self.assertEqual((self.f.root / 'registry-probes').read_text().splitlines(), ['registry list'])

    def loading(self):
        started = time.monotonic()
        marker = self.press(keys=b'\x01')
        self.shown(text='Loading available sessions/worktrees…'.encode(), since=marker)
        self.loading_elapsed = time.monotonic() - started
        self.wait(predicate=lambda: (self.f.root / 'discovery-pids').exists(), reason='discovery never started')
        self.assertFalse((self.f.root / 'release').exists())
        # Real fzf's native Unicode spinner must also be active, not replaced by
        # a blocking transform that prevents the terminal from repainting.
        self.wait(predicate=lambda: any(chr(c).encode() in self.output[marker:]
                                       for c in range(0x2801, 0x2900)), reason='native reload spinner missing')
        return marker

    def test_loading_query_toggle_and_success(self):
        self.initial()
        self.press(keys=b"'topic")
        self.loading()
        # The loading message was visible while discovery was still blocked.
        marker = len(self.output)
        released = time.monotonic()
        (self.f.root / 'release').touch()
        self.shown(text=b'ALL sessions/worktrees', since=marker)
        self.shown(text=b'1/3', since=marker)
        self.shown(text=b'topic-renamed', since=marker)
        all_elapsed = time.monotonic() - released
        marker = self.press(keys=b'\x01')
        self.shown(text=b'OPEN sessions', since=marker)
        self.shown(text=b'0/1', since=marker)
        marker = self.press(keys=b'\x01')
        self.shown(text=b'ALL sessions/worktrees', since=marker)
        self.shown(text=b'1/3', since=marker)
        self.press(keys=b'\x03')
        self.exited(code=0)
        print(f'  initial OPEN: {self.open_elapsed:.3f}s; Loading after Ctrl+A: {self.loading_elapsed:.3f}s; '
              f'ALL after gate release: {all_elapsed:.3f}s; zero initial Git probes, one registry ordering read', flush=True)

    def test_discovery_error_is_visible_and_actionable(self):
        self.initial()
        self.loading()
        (self.f.root / 'fail').touch()
        marker = len(self.output)
        (self.f.root / 'release').touch()
        self.shown(text=b'ALL discovery failed', since=marker)
        self.shown(text=b'dev --list for details', since=marker)
        self.press(keys=b'\x03')
        self.exited(code=1)
        self.shown(text=b'deliberate worktree discovery failure')

    def test_error_then_back_to_open_is_harmless(self):
        self.initial()
        self.loading()
        (self.f.root / 'fail').touch()
        marker = len(self.output)
        (self.f.root / 'release').touch()
        self.shown(text=b'ALL discovery failed', since=marker)
        marker = self.press(keys=b'\x01')
        self.shown(text=b'OPEN sessions', since=marker)
        self.shown(text=b'1/1', since=marker)
        self.press(keys=b'\x03')
        self.exited(code=0)

    def test_rapid_toggle_and_cancel_kills_blocked_discovery(self):
        self.initial()
        self.loading()
        marker = self.press(keys=b'\x01')
        self.shown(text=b'OPEN sessions', since=marker)
        marker = self.press(keys=b'\x01')
        self.shown(text='Loading available sessions/worktrees…'.encode(), since=marker)
        self.wait(predicate=lambda: len((self.f.root / 'discovery-pids').read_text().splitlines()) == 2,
                  reason='second discovery never started')
        self.press(keys=b'\x03')
        self.exited(code=0)
        # No release: passing requires cancellation, not waiting for discovery.
        time.sleep(0.1)


if __name__ == '__main__':
    signal.alarm(50)
    unittest.main(verbosity=2)
