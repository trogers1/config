#!/usr/bin/env python3
"""Reviewer regressions through the public CLI and isolated tmux transport."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

assert os.environ.get("FAKE_TMUX_DIR") and os.environ.get("TEST_REGISTRY_LIB")
ROOT = Path(__file__).resolve().parents[1]
DEV = ROOT / "tmux_and_worktrees/bin/dev"
LIB = Path(os.environ["TEST_REGISTRY_LIB"])
sys.path.insert(0, str(LIB))
import dev_registry

BASE = Path(os.environ["FAKE_TMUX_DIR"]).parent / "launch-blockers"
BASE.mkdir()
BIN = BASE / "bin"
BIN.mkdir()
(BIN / "pi").symlink_to("/usr/bin/false")
os.environ["PATH"] = str(BIN) + os.pathsep + os.environ["PATH"]


def run(*, args, cwd=None, success=True, env=None):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=env,
                            text=True, capture_output=True, timeout=15)
    assert (result.returncode == 0) == success, (args, result.stdout, result.stderr)
    return result


def isolate(*, name):
    root = BASE / name
    root.mkdir()
    os.environ["XDG_STATE_HOME"] = str(root / "state")
    os.environ["FAKE_TMUX_DIR"] = str(root / "tmux")
    fake = Path(os.environ["FAKE_TMUX_DIR"])
    (fake / "sessions").mkdir(parents=True)
    return root, fake


def records():
    path = Path(os.environ["XDG_STATE_HOME"]) / "dev/sessions.json"
    return dev_registry.validate(data=json.loads(path.read_text()))["sessions"]


def configure(*, project, name="agent", shell_command=None):
    project.mkdir(exist_ok=True)
    windows = [{"name": name, "agent": True}, {"name": "shell"}]
    if shell_command is not None:
        windows[1]["command"] = shell_command
    (project / "devConfig.jsonc").write_text(json.dumps({
        "defaultAgent": "pi", "agents": {"pi": "pi"}, "windows": windows,
    }))


def repository(*, project):
    run(args=["git", "init", "-q", "-b", "main", project])
    (project / ".worktree-init.sh").write_text(":\n")
    run(args=["git", "-C", project, "add", "."])
    run(args=["git", "-C", project, "commit", "-qm", "fixture"])


# Numeric and target-metacharacter names must bind and type into the exact
# created pane. The fake rejects nonexistent IDs; real tmux covers parsing too.
for index, name in enumerate(("1", "chat:.*[x]")):
    root, fake = isolate(name=f"target-{index}")
    project = root / "project"
    configure(project=project, name=name)
    run(args=[DEV, "new", "--no-attach", "--prompt", "assignment", project])
    record = records()[str(project)]
    pane = record["pane"]
    assert (fake / "panes" / pane).read_text().strip() == f"{record['name']}\t{name}"
    raw = (fake / "raw-log").read_text().splitlines()
    sends = [line for line in raw if line.startswith("send-keys ")]
    assert len(sends) == 2 and all(line.startswith(f"send-keys -t {pane} ") for line in sends), sends
    assert raw.index(f"select-window -t {pane}") < raw.index(sends[-1])

# Exact recovery must ignore both the old assignment and an editor override,
# even when the configured AGENT window is called nvim.
root, fake = isolate(name="exact-nvim")
project = root / "project"
configure(project=project, name="nvim")
run(args=[DEV, "new", "--no-attach", "--stage-agent", "--nvim-command",
          "nvim NEVER_OVERRIDE", "--prompt", "assignment", project])
record = records()[str(project)]
transcript = root / "exact.jsonl"
transcript.write_text("synthetic exact transcript\n")
metadata = {"agent": record["agent"], "session_id": "exact", "transcript_path": str(transcript)}
result = subprocess.run([sys.executable, str(LIB / "dev_registry.py"), "bind", record["agent"]],
                        input=json.dumps(metadata), text=True, capture_output=True, timeout=15,
                        env=dict(os.environ, TMUX="/fake/tmux,111,0", TMUX_PANE=record["pane"]))
assert result.returncode == 0, result.stderr
shutil.rmtree(Path(record["launch_manifest"]).parent)
run(args=["tmux", "kill-session", "-t", record["name"]])
(fake / "raw-log").write_text("")
run(args=[DEV, "resume-all"])
raw = (fake / "raw-log").read_text()
assert f"then pi --session {transcript};" in raw, raw
assert "NEVER_OVERRIDE" not in raw and "dev_launch.py" not in raw, raw
assert records()[str(project)]["conversation"] == metadata

# Both an unacknowledged Enter and a known-delivered Enter are irreversible.
# A real hook write after dispatch, and a subsequent commit failure, must survive
# without force-removing a newly created checkout or its branch.
for mode in ("before-enter", "after-enter", "late-commit"):
    root, fake = isolate(name=mode)
    project = root / "repo"
    configure(project=project)
    repository(project=project)
    transcript = root / "dispatched.jsonl"
    transcript.write_text("synthetic dispatched transcript\n")
    os.environ["DEV_TEST_TRANSCRIPT"] = str(transcript)
    (fake / "dispatch-failure").write_text(mode)
    try:
        result = run(args=[DEV, "tree", "--no-attach", "--prompt", "assignment", "task"],
                     cwd=project, success=False)
    finally:
        state = Path(os.environ["XDG_STATE_HOME"]) / "dev"
        if state.exists():
            state.chmod(0o700)
    checkout = root / "repo-worktrees/task"
    assert checkout.is_dir(), result.stderr
    assert "Preserved worktree" in result.stderr, result.stderr
    assert not result.stdout
    run(args=["git", "-C", project, "show-ref", "--verify", "refs/heads/task"])
    record = records()[str(checkout)]
    assert (fake / "sessions" / record["name"]).is_dir()
    assert record["conversation"] == (None if mode == "before-enter" else {
        "agent": "pi", "session_id": "dispatched", "transcript_path": str(transcript),
    }), record
    assert "kill-session" not in (fake / "raw-log").read_text()

# Late setup transport failures occur BEFORE Enter, so rollback is still safe.
for failure in ("select-window", "send-keys"):
    root, fake = isolate(name=f"setup-{failure}")
    project = root / "repo"
    configure(project=project, shell_command="printf setup")
    repository(project=project)
    (fake / "fail-once").write_text(failure)
    run(args=[DEV, "tree", "--no-attach", "--prompt", "assignment", "task"], cwd=project, success=False)
    assert not (root / "repo-worktrees/task").exists()
    assert not records()
    assert not list((fake / "sessions").iterdir())
    assert not any(line.endswith(" Enter") for line in (fake / "raw-log").read_text().splitlines())
    run(args=["git", "-C", project, "show-ref", "--verify", "refs/heads/task"], success=False)

# A refused saved-workspace decision publishes nothing, and never cleans up a
# pre-existing pending artifact belonging to another invocation.
root, fake = isolate(name="refusal")
saved = root / "saved"
configure(project=saved)
run(args=[DEV, "new", "--no-attach", "--stage-agent", "--prompt", "saved assignment", saved])
record = records()[str(saved)]
run(args=["tmux", "kill-session", "-t", record["name"]])
project = root / "repo"
configure(project=project)
repository(project=project)
state = Path(os.environ["XDG_STATE_HOME"]) / "dev"
before = {path.relative_to(state): path.read_bytes() for path in state.rglob("*") if path.is_file()}
for command in ([DEV, "new", "--no-attach", "--prompt", "refused", project],
                [DEV, "tree", "--no-attach", "--prompt", "refused", "task"]):
    result = run(args=command, cwd=project, success=False)
    assert "--no-attach cannot confirm" in result.stderr, result.stderr
    assert {path.relative_to(state): path.read_bytes() for path in state.rglob("*") if path.is_file()} == before
assert not (root / "repo-worktrees/task").exists()
print("dev launch blocker tests passed")
