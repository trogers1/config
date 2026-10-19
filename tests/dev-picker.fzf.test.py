#!/usr/bin/env python3
"""Real fzf reload/transform smoke in a controlling PTY; isolated Git/tmux/state.

Run: python3 tests/dev-picker.fzf.test.py (30s suite, 10s per picker).
"""
import errno
import importlib.util
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import termios
import fcntl
import time
import unittest

spec = importlib.util.spec_from_file_location('picker_tests', Path(__file__).with_name('dev-picker.test.py'))
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


@unittest.skipUnless(shutil.which('fzf'), 'real fzf is required')
class RealFzfTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.DevPickerTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        (self.fixture.bin / 'fzf').unlink()
        (self.fixture.bin / 'fzf').symlink_to(shutil.which('fzf'))
        self.fixture.env.update(TERM='xterm-256color', SHELL='/bin/sh')

    def picker(self, *, empty_open):
        f = self.fixture
        if not empty_open:
            f.dev(args=['new', str(f.repo)])
        registry = Path(f.env['XDG_STATE_HOME']) / 'dev/sessions.json'
        before_registry = registry.read_bytes() if registry.exists() else None
        before_sessions = f.sessions()
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(f.repo)
            os.execve(str(fixtures.DEV), [str(fixtures.DEV), 'switch'], f.env)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 180, 0, 0))
        output = bytearray()
        deadline = time.monotonic() + 10

        def wait_for(*, text, since=None):
            start = len(output) if since is None else since
            while time.monotonic() < deadline:
                if text in output[start:]:
                    return
                ready, _, _ = select.select([fd], [], [], 0.1)
                if ready:
                    try:
                        data = os.read(fd, 65536)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            break
                        raise
                    if not data:
                        break
                    output.extend(data)
                    if text in output[start:]:
                        return
            self.fail(f'fzf did not show {text!r}: {bytes(output)!r}')

        try:
            wait_for(text=b'show ALL')
            os.write(fd, b"'topic")  # Exact substring, not fuzzy matches in temp paths.
            marker = len(output)
            os.write(fd, b'\x01')  # Ctrl+A: OPEN -> ALL, preserving query.
            wait_for(text=b'show OPEN', since=marker)
            wait_for(text=b'1/3', since=marker)  # Reload finished, one exact match.
            marker = len(output)
            os.write(fd, b'\x01')  # ALL -> OPEN, no state mutations.
            wait_for(text=b'show ALL', since=marker)
            wait_for(text=b'0/0' if empty_open else b'0/1', since=marker)
            self.assertEqual(f.sessions(), before_sessions)
            self.assertEqual(registry.read_bytes() if registry.exists() else None, before_registry)
            marker = len(output)
            os.write(fd, b'\x01')
            wait_for(text=b'show OPEN', since=marker)
            wait_for(text=b'1/3', since=marker)
            os.write(fd, b'\r')
            while time.monotonic() < deadline:
                done, status = os.waitpid(pid, os.WNOHANG)
                if done:
                    pid = None
                    self.assertEqual(os.waitstatus_to_exitcode(status), 0, bytes(output))
                    break
                ready, _, _ = select.select([fd], [], [], 0.05)
                if ready:
                    try:
                        output.extend(os.read(fd, 65536))
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
            else:
                self.fail(f'dev switch did not exit within ten seconds: {bytes(output)!r}')
            # With no query, fzf would select the primary checkout, not topic.
            self.assertIn(str(f.worktree), [s['DTREE_WORKTREE_PATH'] for s in f.sessions().values()], bytes(output))
            self.assertEqual(f.log()[-1][0], 'attach-session')
        finally:
            os.close(fd)
            if pid:
                os.killpg(pid, signal.SIGKILL)
                os.waitpid(pid, 0)

    def test_saved_order_default_and_standard_query_ranking(self):
        started = time.monotonic()
        f = self.fixture
        projects = [f.root / name for name in ('zulu-target', 'target')]
        for project in projects:
            project.mkdir()
            (project / 'devConfig.jsonc').write_text((f.repo / 'devConfig.jsonc').read_text())
            f.dev(args=['new', str(project)])
        names = list(f.sessions())
        # Empty query selects the earliest opening (not alphabetical); a query
        # still favors fzf's stronger word-start match, not saved input order.
        for query, expected in ((b'', names[0]), (b'target', names[1])):
            pid, fd = pty.fork()
            if pid == 0:
                os.chdir(f.root)
                os.execve(str(fixtures.DEV), [str(fixtures.DEV), 'switch'], f.env)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 180, 0, 0))
            deadline = time.monotonic() + 8
            output = bytearray()
            sent = False
            try:
                while time.monotonic() < deadline:
                    done, status = os.waitpid(pid, os.WNOHANG)
                    if done:
                        pid = None
                        self.assertEqual(os.waitstatus_to_exitcode(status), 0, bytes(output))
                        break
                    if select.select([fd], [], [], 0.05)[0]:
                        try:
                            output.extend(os.read(fd, 65536))
                        except OSError as error:
                            if error.errno != errno.EIO:
                                raise
                    if not sent and b'2/2' in output and b'show ALL' in output:
                        os.write(fd, query)
                        # fzf processes the complete query before accepting it.
                        os.write(fd, b'\r')
                        sent = True
                else:
                    self.fail(f'ordering/query picker timed out: {bytes(output)!r}')
                self.assertEqual(f.log()[-1], ['attach-session', '-t', '=' + expected])
            finally:
                os.close(fd)
                if pid:
                    os.killpg(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)
        print(f'  saved-order/default + query-ranking: {time.monotonic() - started:.2f}s', flush=True)

    def test_empty_open_toggle_and_retained_query(self):
        self.picker(empty_open=True)

    def test_open_toggle_and_retained_query(self):
        self.picker(empty_open=False)


if __name__ == '__main__':
    signal.alarm(30)
    unittest.main(verbosity=2)
