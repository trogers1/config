#!/usr/bin/env python3
"""Public lifecycle regressions; invoked by dev.test.sh with its isolated fake tmux."""
import errno
import importlib.util
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
DEV = ROOT / "tmux_and_worktrees/bin/dev"
LIB = DEV.parent / "lib/dev_registry.py"
# Refuse to run against a real home/server when invoked outside the harness.
assert os.environ.get("FAKE_TMUX_DIR") and os.environ.get("TEST_REGISTRY_LIB")
BASE = Path(os.environ["FAKE_TMUX_DIR"]).parent / "workspace-tests"
BASE.mkdir()
os.environ["XDG_STATE_HOME"] = str(BASE / "state")
os.environ["FAKE_TMUX_DIR"] = str(BASE / "tmux")
FAKE = Path(os.environ["FAKE_TMUX_DIR"])
(FAKE / "sessions").mkdir(parents=True)
sys.path.insert(0, str(LIB.parent))
spec = importlib.util.spec_from_file_location("registry", LIB)
registry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(registry)


def run(*, args, cwd=None, success=True):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, text=True,
                            capture_output=True, timeout=15)
    assert (result.returncode == 0) == success, (args, result.stdout, result.stderr)
    return result


def terminal(*, args, answer, success, cwd=None):
    pid, fd = pty.fork()
    if pid == 0:
        if cwd:
            os.chdir(cwd)
        os.execv(str(DEV), [str(DEV), *map(str, args)])
    output = b""
    sent = False
    reaped = False
    deadline = time.monotonic() + 15
    try:
        while True:
            if time.monotonic() > deadline:
                raise AssertionError(f"PTY timeout: {output!r}")
            if not select.select([fd], [], [], 0.1)[0]:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            output += chunk
            if b"Start a fresh saved workspace? [y/N] " in output and not sent:
                os.write(fd, answer.encode() + b"\n")
                sent = True
        _, status = os.waitpid(pid, 0)
        reaped = True
        assert sent, output.decode()
        assert (os.waitstatus_to_exitcode(status) == 0) == success, output.decode()
        return output.decode()
    except BaseException:
        if not reaped:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        raise
    finally:
        os.close(fd)


def read():
    return registry.validate(data=json.loads(registry.REGISTRY.read_text()))


projects = [BASE / str(i) for i in range(1, 5)]
for project in projects:
    project.mkdir()
    (project / "devConfig.jsonc").write_text('{"windows":[{"name":"shell","command":"printf fixture"}]}')
for project in projects[:3]:
    run(args=[DEV, "open", project])
previous = read()
assert "boot_id" not in previous
# OS-specific boot queries must not become a runtime prerequisite again.
source = LIB.read_text()
assert "sysctl" not in source and "/proc/" not in source
previous["sessions"][str(projects[1])]["branch"] = "saved-feature"
registry.validate(data=previous)


def reset(*, version=registry.SCHEMA_VERSION, boot_metadata=None):
    data = json.loads(json.dumps(previous))
    data["version"] = version
    if boot_metadata is not None:
        data["boot_id"] = boot_metadata
    registry.validate(data=data)
    registry.REGISTRY.write_text(json.dumps(data, indent=2) + "\n")
    for directory in (FAKE / "sessions", FAKE / "panes"):
        shutil.rmtree(directory, ignore_errors=True)
    (FAKE / "sessions").mkdir()
    (FAKE / "log").write_text("")
    (FAKE / "fail-once").unlink(missing_ok=True)
    return registry.REGISTRY.read_bytes()


before = reset()
output = terminal(args=["open", projects[0]], answer="", success=False)
assert "3 recovery record(s)" in output
for record in previous["sessions"].values():
    assert record["name"] in output and record["path"] in output
assert "ENTIRE" in output and "No checkouts/worktrees or conversations are deleted" in output
assert "re-added only after success" in output and "dev resume-all" in output
assert "[branch: saved-feature]" in output
assert registry.REGISTRY.read_bytes() == before
assert not list((FAKE / "sessions").iterdir())

# Non-PTY invocation cannot silently discard the old workspace either.
run(args=[DEV, "new", projects[0]], success=False)
assert registry.REGISTRY.read_bytes() == before

repo = BASE / "repo"
run(args=["git", "init", "-q", "-b", "main", repo])
(repo / "devConfig.jsonc").write_text((projects[0] / "devConfig.jsonc").read_text())
(repo / ".worktree-init.sh").write_text("exit 19\n")
run(args=["git", "-C", repo, "add", "."])
run(args=["git", "-C", repo, "commit", "-qm", "fixture"])
worktree = BASE / "repo-worktrees/fresh"
result = run(args=[DEV, "tree", "--no-attach", "fresh"], cwd=repo, success=False)
assert "--no-attach cannot confirm" in result.stderr and "dev resume-all" in result.stderr
assert not result.stdout and not worktree.exists()
assert registry.REGISTRY.read_bytes() == before
# Declining a creating operation must not even create a branch or run init.
output = terminal(args=["tree", "fresh"], cwd=repo, answer="n", success=False)
assert not worktree.exists()
assert registry.REGISTRY.read_bytes() == before
run(args=["git", "-C", repo, "show-ref", "--verify", "refs/heads/fresh"], success=False)

# Consent is provisional until success: init and post-register tmux errors both
# preserve the complete old list, and partial sessions/worktrees are rolled back.
terminal(args=["tree", "fresh"], cwd=repo, answer="y", success=False)
assert registry.REGISTRY.read_bytes() == before
assert not worktree.exists()
run(args=["git", "-C", repo, "show-ref", "--verify", "refs/heads/fresh"], success=False)
for failure in ("new-window", "send-keys", "select-window"):
    reset()
    if failure == "new-window":
        (projects[0] / "devConfig.jsonc").write_text('{"windows":[{"name":"shell"},{"name":"other"}]}')
    else:
        (projects[0] / "devConfig.jsonc").write_text('{"windows":[{"name":"shell","command":"printf fixture"}]}')
    before = registry.REGISTRY.read_bytes()
    (FAKE / "fail-once").write_text(failure + "\n")
    terminal(args=["new", projects[0]], answer="yes", success=False)
    assert registry.REGISTRY.read_bytes() == before, failure
    assert not list((FAKE / "sessions").iterdir()), failure

reset()
terminal(args=["open", projects[0]], answer="Y", success=True)
assert set(read()["sessions"]) == {str(projects[0])}
run(args=[DEV, "open", projects[3]])
run(args=[DEV, "resume-all"])
assert set(read()["sessions"]) == {str(projects[0]), str(projects[3])}
assert not (FAKE / "sessions/2-dev").exists() and not (FAKE / "sessions/3-dev").exists()
assert all(project.is_dir() for project in projects)

# Losing the server (reboot or otherwise) requires a new decision. Unmanaged
# sessions do not suppress it, even when the server itself is running.
shutil.rmtree(FAKE / "sessions")
(FAKE / "sessions/unmanaged").mkdir(parents=True)
before = registry.REGISTRY.read_bytes()
terminal(args=["open", projects[3]], answer="n", success=False)
assert registry.REGISTRY.read_bytes() == before
assert list((FAKE / "sessions").iterdir()) == [FAKE / "sessions/unmanaged"]
terminal(args=["open", projects[3]], answer="y", success=True)
assert list(read()["sessions"]) == [str(projects[3])]

# Explicit recovery retains ALL records. A partial bulk recovery leaves managed
# sessions running; failed selected recovery alone does not waive confirmation.
# The selected-path command is the same entry used by dev switch.
for selected in (False, True):
    reset()
    if selected:
        before = registry.REGISTRY.read_bytes()
        run(args=["python3", LIB, "run", "python3", LIB, "resume", BASE / "missing"], success=False)
        assert registry.REGISTRY.read_bytes() == before
        recovery = ["python3", LIB, "run", "python3", LIB, "resume", projects[1]]
    else:
        recovery = [DEV, "resume-all"]
    (FAKE / "fail-once").write_text("new-session\n")
    run(args=recovery, success=False)
    assert set(read()["sessions"]) == set(previous["sessions"])
    if selected:
        before = registry.REGISTRY.read_bytes()
        terminal(args=["open", projects[3]], answer="n", success=False)
        assert registry.REGISTRY.read_bytes() == before
    else:
        run(args=[DEV, "open", projects[3]])
        assert list(read()["sessions"]) == [*previous["sessions"], str(projects[3])]

# If EVERY recovery fails, there is no hidden intent flag: the next ordinary
# open asks again. No records are lost by either the recovery or the decline.
reset()
for project in projects[:3]:
    project.rename(project.with_name(project.name + "-away"))
before = registry.REGISTRY.read_bytes()
result = run(args=[DEV, "resume-all"], success=False)
assert result.stderr.count("checkout missing:") == 3
assert registry.REGISTRY.read_bytes() == before
assert not list((FAKE / "sessions").iterdir())
terminal(args=["open", projects[3]], answer="", success=False)
assert registry.REGISTRY.read_bytes() == before
for project in projects[:3]:
    project.with_name(project.name + "-away").rename(project)

# Successful bulk or selected recovery preserves every saved record. Once ANY
# managed session is running, an ordinary open appends without prompting.
for recovery in ([DEV, "resume-all"],
                 ["python3", LIB, "run", "python3", LIB, "resume", projects[1]]):
    reset()
    run(args=recovery)
    run(args=[DEV, "open", projects[3]])
    assert set(read()["sessions"]) == {*previous["sessions"], str(projects[3])}

# Tree creation commits the fresh baseline only after init/session success;
# later no-attach calls with live managed sessions accumulate without prompting.
reset()
(repo / ".worktree-init.sh").write_text(":\n")
run(args=["git", "-C", repo, "add", "."])
run(args=["git", "-C", repo, "commit", "-qm", "successful init"])
before = registry.REGISTRY.read_bytes()
(FAKE / "fail-once").write_text("select-window\n")
terminal(args=["tree", "fresh"], cwd=repo, answer="yes", success=False)
assert registry.REGISTRY.read_bytes() == before
assert not worktree.exists()
run(args=["git", "-C", repo, "show-ref", "--verify", "refs/heads/fresh"], success=False)
terminal(args=["tree", "fresh"], cwd=repo, answer="yes", success=True)
assert set(read()["sessions"]) == {str(worktree)}
run(args=[DEV, "tree", "--no-attach", "next"], cwd=repo)
assert set(read()["sessions"]) == {str(worktree), str(BASE / "repo-worktrees/next")}

# Both old schemas migrate ALL records, data and insertion order, regardless of
# obsolete boot provenance. Read-only/declined operations do not rewrite files.
for version, metadata in ((1, None), (2, None), (2, "darwin:1:0"),
                          (2, "linux:00000000-0000-0000-0000-000000000000"),
                          (2, {"obsolete": "ignored"})):
    before = reset(version=version, boot_metadata=metadata)
    terminal(args=["new", projects[0]], answer="no", success=False)
    assert registry.REGISTRY.read_bytes() == before
    run(args=[DEV, "resume-all"])
    migrated = json.loads(registry.REGISTRY.read_text())
    assert migrated["version"] == registry.SCHEMA_VERSION and "boot_id" not in migrated
    assert list(migrated["sessions"]) == list(previous["sessions"])
    # Pane bindings necessarily change on recovery; every other field is exact.
    for path, saved in previous["sessions"].items():
        assert {k: v for k, v in migrated["sessions"][path].items() if k not in ("pane", "server")} == {
            k: v for k, v in saved.items() if k not in ("pane", "server")}
reset(version=1)
terminal(args=["new", projects[0]], answer="yes", success=True)
assert list(read()["sessions"]) == [str(projects[0])]
# A confirmed fresh baseline drops the former workspace order. Later openings
# append, rather than path-sort, and public inventory retains that order.
for project in (projects[3], projects[1]):
    run(args=[DEV, "open", project])
before = registry.REGISTRY.read_bytes()
output = run(args=[DEV, "--list"], cwd=BASE).stdout
assert [line.removeprefix("  path: ") for line in output.splitlines() if line.startswith("  path: ")] == [
    str(projects[index]) for index in (0, 3, 1)
], output
assert registry.REGISTRY.read_bytes() == before
print("dev saved workspace tests passed")
