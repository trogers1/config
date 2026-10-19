#!/usr/bin/env python3
"""Bounded, isolated PTY integration test: real tmux, dev, and fzf popups.

Never connects to the default/live tmux socket or reads a real terminal.
Run: python3 tests/dev-bindings.tmux.test.py
"""
import fcntl
import os
from pathlib import Path
import pty
import select
import shlex
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
import unittest

REPO = Path(__file__).resolve().parents[1]


class DevBindingTests(unittest.TestCase):
    def test_real_popup_prefixes_and_chooser(self):
        tmux = shutil.which("tmux")
        self.assertIsNotNone(tmux, "tmux is required")
        self.assertIsNotNone(shutil.which("fzf"), "real fzf is required")
        with tempfile.TemporaryDirectory(prefix="dev-bindings-") as temporary:
            root = Path(temporary).resolve()
            checkout = root / "project with 'quotes'"
            checkout.mkdir()
            home = root / "home"
            home.mkdir()
            bin_dir = root / "bin"
            bin_dir.mkdir()
            dev = bin_dir / "dev"
            dev.write_text('#!/bin/sh\nprintf "%s\\n" "$PWD" "$TMUX_PANE" >> "$BINDING_LOG"\n'
                           f'exec {shlex.quote(str(REPO / "tmux_and_worktrees/bin/dev"))} "$@"\n')
            dev.chmod(0o755)
            env = dict(os.environ)
            for key in ("TMUX", "TMUX_PANE", "DEV_LIFECYCLE_LOCK_FD", "DEV_INITIALIZER_PID",
                        "FZF_DEFAULT_OPTS", "FZF_DEFAULT_OPTS_FILE", "FZF_DEFAULT_COMMAND"):
                env.pop(key, None)
            env.update(HOME=str(home), XDG_STATE_HOME=str(root / "state"),
                       PATH=f"{bin_dir}:{env['PATH']}", TERM="xterm-256color", SHELL="/bin/sh",
                       BINDING_LOG=str(root / "bindings.log"))
            base = [tmux, "-S", str(root / "tmux.sock")]
            client = None
            other_client = None
            other_master, other_slave = pty.openpty()
            fcntl.ioctl(other_slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
            os.set_blocking(master, False)
            output = bytearray()

            def command(*, args):
                return subprocess.run([*base, *args], env=env, capture_output=True,
                                      text=True, check=True, timeout=3).stdout.strip()

            def drain():
                while select.select([master], [], [], 0)[0]:
                    try:
                        data = os.read(master, 65536)
                    except BlockingIOError:
                        break
                    if not data:
                        break
                    output.extend(data)
                    # Answer the cursor-position query as a real terminal does.
                    if b"\x1b[6n" in data:
                        os.write(master, b"\x1b[1;1R")

            def wait_for(*, predicate, reason):
                deadline = time.monotonic() + 4
                while True:
                    drain()
                    if predicate():
                        return
                    self.assertIsNone(client.poll(), "isolated tmux client exited")
                    self.assertLess(time.monotonic(), deadline, f"{reason}; isolated PTY tail: {bytes(output[-2500:])!r}")
                    time.sleep(0.02)

            def key_table():
                return command(args=["display-message", "-c", os.ttyname(slave), "-p", "#{client_key_table}"])

            def open_picker(*, prefix):
                output.clear()
                os.write(master, prefix)
                wait_for(predicate=lambda: key_table() == "prefix", reason=f"{prefix!r} not decoded as prefix")
                # A prefix by itself must only enter the prefix table, not launch fzf.
                time.sleep(0.15)
                drain()
                self.assertNotIn(b"Esc: cancel", output, "prefix alone opened picker")
                self.assertEqual(key_table(), "prefix")
                os.write(master, b"w")
                wait_for(predicate=lambda: b"Esc: cancel" in output and b"open  bindings" in output, reason=f"{prefix!r} + w did not open real popup")
                self.assertEqual(key_table(), "root")
                self.assertIn(b"bindings", output, "popup did not show tagged session inventory")
                # Allow fzf's terminal initialization to finish before cancelling.
                time.sleep(0.4)
                drain()
                os.write(master, b"\x1b")
                # A subsequent prefix reaching tmux proves the real popup closed.
                time.sleep(1.1)
                os.write(master, b"\x02")
                wait_for(predicate=lambda: key_table() == "prefix", reason="popup did not close on Escape")
                os.write(master, b"\x1b")
                wait_for(predicate=lambda: key_table() == "root", reason="prefix table did not reset")

            try:
                command(args=["-f", "/dev/null", "new-session", "-d", "-s", "bindings", "-c", str(checkout)])
                command(args=["source-file", str(REPO / "tmux_and_worktrees/tmux-worktree.conf")])
                command(args=["set-option", "-g", "escape-time", "10"])
                command(args=["set-option", "-g", "extended-keys", "on"])
                command(args=["set-option", "-g", "extended-keys-format", "csi-u"])
                command(args=["set-environment", "-t", "bindings", "DTREE_WORKTREE_PATH", str(checkout)])
                # Session environments can retain an obsolete pane from a previous shell.
                command(args=["set-environment", "-t", "bindings", "TMUX_PANE", "%9999"])
                pane = command(args=["display-message", "-p", "-t", "bindings:", "#{pane_id}"])
                client = subprocess.Popen([*base, "attach-session", "-t", "bindings"], env=env,
                                          stdin=slave, stdout=slave, stderr=slave)
                wait_for(predicate=lambda: command(args=["list-clients", "-F", "#{client_session}"]) == "bindings",
                         reason="test client did not attach")
                command(args=["new-session", "-d", "-s", "decoy", "-c", str(home)])
                other_client = subprocess.Popen([*base, "attach-session", "-t", "decoy"], env=env,
                                                stdin=other_slave, stdout=other_slave, stderr=other_slave)
                wait_for(predicate=lambda: len(command(args=["list-clients"]).splitlines()) == 2,
                         reason="decoy client did not attach")
                for prefix in (b"\x02", b"\x1b ", b"\x1b[32;3u", b"\x1b[98;5u"):
                    open_picker(prefix=prefix)
                output.clear()
                os.write(master, b"\x02s")
                wait_for(predicate=lambda: command(args=["display-message", "-p", "#{pane_in_mode}"]) == "1",
                         reason="native session chooser did not open")
                self.assertNotIn(b"Esc: cancel", output)
                os.write(master, b"\x1b")
                wait_for(predicate=lambda: command(args=["display-message", "-p", "#{pane_in_mode}"]) == "0",
                         reason="native chooser did not close")
                self.assertEqual(key_table(), "root")
                command(args=["has-session", "-t", "=bindings"])
                self.assertFalse((root / "state/dev/sessions.json").exists())
                self.assertEqual((root / "bindings.log").read_text().splitlines(),
                                 [str(checkout), pane] * 4)
                # Failure must be visible on the initiating client, not swallowed
                # by the background job. Normal cases above always used real dev/fzf.
                dev.write_text('#!/bin/sh\necho "test picker startup failure" >&2\nexit 47\n')
                output.clear()
                os.write(master, b"\x02w")
                wait_for(predicate=lambda: b"dev switch failed" in output,
                         reason="background picker failure was not visible")
                self.assertEqual(key_table(), "root")
            finally:
                subprocess.run([*base, "kill-server"], env=env, capture_output=True, timeout=3)
                if client is not None:
                    try:
                        client.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        client.kill()
                        client.wait(timeout=2)
                if other_client is not None:
                    other_client.wait(timeout=3)
                os.close(other_master)
                os.close(other_slave)
                os.close(master)
                os.close(slave)


if __name__ == "__main__":
    signal.alarm(45)
    unittest.main(verbosity=2)
