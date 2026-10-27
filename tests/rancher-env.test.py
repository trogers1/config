#!/usr/bin/env python3
"""Exercise the installed zsh startup boundary with a fake Rancher CLI/socket."""
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest

REPO = Path(__file__).resolve().parents[1]
RUNTIME_KEYS = (
    "DOCKER_HOST",
    "TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE",
    "TESTCONTAINERS_RYUK_DISABLED",
    "TESTCONTAINERS_HOST_OVERRIDE",
)


class RancherEnvironmentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="rancher-env-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        (self.home / ".zshenv").symlink_to(REPO / "home/.zshenv")
        self.bin = self.home / ".rd/bin"
        self.bin.mkdir(parents=True)
        self.host = f"unix://{self.home}/.rd/docker.sock"
        self.ip = "192.0.2.10"
        rdctl = self.bin / "rdctl"
        rdctl.write_text(
            '#!/bin/sh\n'
            '[ "$*" = "info --field ip-address" ] || exit 2\n'
            'echo called >> "$HOME/rdctl-calls"\n'
            'if [ -e "$HOME/rdctl-fail" ]; then exit 1; fi\n'
            'printf "%s\\n" "$FAKE_RANCHER_IP"\n'
        )
        rdctl.chmod(0o755)
        self.env = {key: value for key, value in os.environ.items() if key not in RUNTIME_KEYS}
        self.env.update(HOME=str(self.home), ZDOTDIR=str(self.home), FAKE_RANCHER_IP=self.ip)

    def start_rancher(self):
        connection = socket.socket(socket.AF_UNIX)
        self.addCleanup(connection.close)
        connection.bind(str(self.home / ".rd/docker.sock"))

    def run_shell(self, *, script='exec /usr/bin/printenv', overrides=None, interactive=False, check=True):
        result = subprocess.run(
            ["/bin/zsh", *(["-i"] if interactive else []), "-c", script],
            env={**self.env, **(overrides or {})},
            capture_output=True, text=True, timeout=10, check=check,
        )
        return result

    def environment(self, *, overrides=None):
        result = self.run_shell(overrides=overrides)
        self.assertEqual(result.stderr, "")
        return dict(line.split("=", 1) for line in result.stdout.splitlines())

    def test_rancher_initializes_all_runtime_variables_without_interactive_startup(self):
        self.start_rancher()
        (self.home / ".zshrc").write_text('print -u2 "must not read zshrc"\n')
        env = self.environment()
        self.assertEqual(env["DOCKER_HOST"], self.host)
        self.assertEqual(env["TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE"], "/var/run/docker.sock")
        self.assertEqual(env["TESTCONTAINERS_RYUK_DISABLED"], "true")
        self.assertEqual(env["TESTCONTAINERS_HOST_OVERRIDE"], self.ip)
        self.assertEqual(env["PATH"].split(":").count(str(self.bin)), 1)
        # Repeating initialization must not repeat the CLI request or PATH entry.
        result = self.run_shell(script='configure-rancher-desktop; source "$HOME/.zshenv"; exec /usr/bin/printenv')
        self.assertEqual(result.stderr, "")
        self.assertEqual((self.home / "rdctl-calls").read_text().splitlines(), ["called", "called"])

    def test_no_socket_leaves_runtime_unset(self):
        env = self.environment()
        for key in RUNTIME_KEYS:
            self.assertNotIn(key, env)
        self.assertFalse((self.home / "rdctl-calls").exists())

    def test_existing_overrides_are_preserved_without_cli_call(self):
        self.start_rancher()
        overrides = dict(zip(RUNTIME_KEYS, [self.host, "/custom/socket", "false", "custom-host"]))
        env = self.environment(overrides=overrides)
        for key, value in overrides.items():
            self.assertEqual(env[key], value)
        self.assertFalse((self.home / "rdctl-calls").exists())

    def test_other_docker_endpoint_is_not_reconfigured(self):
        self.start_rancher()
        endpoint = "unix:///another/docker.sock"
        env = self.environment(overrides={"DOCKER_HOST": endpoint})
        self.assertEqual(env["DOCKER_HOST"], endpoint)
        for key in RUNTIME_KEYS[1:]:
            self.assertNotIn(key, env)
        self.assertFalse((self.home / "rdctl-calls").exists())

    def test_prompt_retry_can_initialize_after_delayed_startup(self):
        self.start_rancher()
        (self.home / ".rd/docker.sock").rename(self.home / ".rd/pending.sock")
        result = self.run_shell(
            script='[[ -z "${DOCKER_HOST:-}" ]] || exit 1; mv "$HOME/.rd/pending.sock" "$HOME/.rd/docker.sock"; configure-rancher-desktop; print -r -- "$TESTCONTAINERS_HOST_OVERRIDE"'
        )
        self.assertEqual(result.stdout.strip(), self.ip)

    def test_failed_or_empty_rdctl_prevents_unattended_execution(self):
        self.start_rancher()
        marker = self.home / "workload-started"
        for mode in ("failed", "empty"):
            with self.subTest(mode=mode):
                failure = self.home / "rdctl-fail"
                if mode == "failed":
                    failure.touch()
                else:
                    failure.unlink()
                result = self.run_shell(
                    script='touch "$HOME/workload-started"',
                    overrides={"FAKE_RANCHER_IP": ""} if mode == "empty" else {},
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("rdctl could not determine its IP address", result.stderr)
                self.assertFalse(marker.exists())

    def test_interactive_failure_leaves_shell_usable_and_retry_recovers(self):
        self.start_rancher()
        (self.home / "rdctl-fail").touch()
        result = self.run_shell(
            interactive=True,
            script='print -r -- usable; rm "$HOME/rdctl-fail"; configure-rancher-desktop || exit 1; print -r -- "$TESTCONTAINERS_HOST_OVERRIDE"',
        )
        self.assertEqual(result.stdout.splitlines(), ["usable", self.ip])
        self.assertIn("rdctl could not determine its IP address", result.stderr)


if __name__ == "__main__":
    unittest.main()
