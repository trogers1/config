#!/usr/bin/env python3
"""Public dev commands + package CLI transport, isolated HOME/config/fake tmux."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

assert os.environ.get("FAKE_TMUX_DIR") and os.environ.get("TEST_REGISTRY_LIB")
ROOT = Path(__file__).resolve().parents[1]
DEV = ROOT / "tmux_and_worktrees/bin/dev"
LIB = Path(os.environ["TEST_REGISTRY_LIB"])
sys.path.insert(0, str(LIB))
import dev_launch
import dev_registry

BASE = Path(os.environ["FAKE_TMUX_DIR"]).parent / "agent-profiles"
BASE.mkdir()
BIN = BASE / "bin"
BIN.mkdir()
shutil.copyfile(ROOT / "tests/fixtures/dev-profile-agent.py", BIN / "pi")
(BIN / "pi").chmod(0o700)
(BIN / "claude").symlink_to("/usr/bin/false")
os.environ["PATH"] = str(BIN) + os.pathsep + os.environ["PATH"]
os.environ.pop("PI_SUBAGENT_PROFILE", None)


def run(*, args, cwd=None, success=True, env=None):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=env,
                            text=True, capture_output=True, timeout=20)
    assert (result.returncode == 0) == success, (args, result.stdout, result.stderr)
    return result


def isolate(*, name):
    root = BASE / name
    root.mkdir()
    os.environ["HOME"] = str(root / "home")
    os.environ["XDG_STATE_HOME"] = str(root / "state")
    os.environ["FAKE_TMUX_DIR"] = str(root / "tmux")
    os.environ["PI_CODING_AGENT_DIR"] = str(root / "custom-agent-dir")
    os.environ["DEV_TEST_GUARD_CONFIG"] = str(root / "guard-config.json")
    os.environ["DEV_TEST_GUARD_LOG"] = str(root / "validator.jsonl")
    os.environ["DEV_TEST_AGENT_RECEIPT"] = str(root / "agent.json")
    (root / "tmux/sessions").mkdir(parents=True)
    config = {"profiles": ["planning", "coding", "-planning", "@planning"]}
    (root / "guard-config.json").write_text(json.dumps(config))
    agent_dir = Path(os.environ["PI_CODING_AGENT_DIR"])
    package = agent_dir / "packages/pi-guard"
    (package / "extensions").mkdir(parents=True)
    # The fake integration declares the real package's public identity/resources.
    manifest = json.loads((ROOT / "home/.pi/agent/packages/pi-guard/package.json").read_text())
    (package / "package.json").write_text(json.dumps({"name": manifest["name"], "pi": manifest["pi"]}))
    (package / "extensions/guard.ts").write_text("export default function() {}\n")
    shutil.copyfile(ROOT / "tests/fixtures/dev-guard-profile.mjs", package / "guard-profile.mjs")
    (agent_dir / "settings.json").write_text(json.dumps({"packages": ["./packages/pi-guard"]}))
    return root, agent_dir, package


def configure(*, root, command="pi", agent="pi", git=False):
    project = root / "project"
    project.mkdir()
    (project / "devConfig.jsonc").write_text(json.dumps({
        "defaultAgent": agent, "agents": {agent: command},
        "windows": [{"name": "cockpit", "agent": True}, {"name": "shell"}],
    }))
    if git:
        run(args=["git", "init", "-q", "-b", "main", project])
        (project / ".worktree-init.sh").write_text(":\n")
        run(args=["git", "-C", project, "add", "."])
        run(args=["git", "-C", project, "commit", "-qm", "fixture"])
    return project


def record(*, checkout):
    registry = Path(os.environ["XDG_STATE_HOME"]) / "dev/sessions.json"
    data = dev_registry.validate(data=json.loads(registry.read_text()))
    return data["sessions"][str(checkout)]


def execute(*, manifest, checkout, success=True):
    # Same serialized helper typed into the pane; fake tmux intentionally does
    # not execute Enter. Execute only this fake agent, never the user's Pi.
    command = run(args=[sys.executable, LIB / "dev_launch.py", "command", manifest]).stdout.strip()
    return run(args=shlex.split(command), cwd=checkout, success=success)


# new/open/tree support profile alone and profile+prompt; stage remains inert,
# and Enter uses the actual destination config via the package-owned CLI.
for entry in ("new", "open", "tree"):
    for with_prompt in (False, True):
        root, agent_dir, package = isolate(name=f"{entry}-{with_prompt}")
        project = configure(root=root, git=entry == "tree")
        prompt = '--assignment λ\n$(touch NEVER_RUN); "quotes"'
        options = ["--agent-profile", "planning"] + (["--prompt", prompt] if with_prompt else [])
        target = ["task"] if entry == "tree" else [project]
        result = run(args=[DEV, entry, "--no-attach", "--stage-agent", *options, *target], cwd=project)
        checkout = Path(result.stdout.strip())
        item = record(checkout=checkout)
        manifest = Path(item["launch_manifest"])
        data = json.loads(manifest.read_text())
        content = (manifest.parent / data["prompt_file"]).read_text() if data["prompt_file"] else None
        assert data["agent_profile"] == "planning" and content == (prompt if with_prompt else None)
        assert (data["prompt_file"] is not None) == with_prompt
        assert not (root / "agent.json").exists()
        raw = (root / "tmux/raw-log").read_text()
        assert "dev_launch.py" in raw and not any(line.endswith(" Enter") for line in raw.splitlines())
        assert prompt not in raw and "--guard-profile" not in raw and " -e " not in raw
        # Existing live sessions cannot silently ignore the profile-only option.
        before = manifest.read_bytes()
        run(args=[DEV, entry, "--no-attach", "--agent-profile", "coding", *target], cwd=project, success=False)
        assert manifest.read_bytes() == before
        # Exact recovery resumes recorded conversation, not the startup override.
        transcript = root / "exact.jsonl"
        transcript.write_text("synthetic exact transcript\n")
        metadata = {"agent": "pi", "session_id": "exact", "transcript_path": str(transcript)}
        bound = subprocess.run([sys.executable, str(LIB / "dev_registry.py"), "bind", "pi"],
                               input=json.dumps(metadata), text=True, capture_output=True, timeout=15,
                               env=dict(os.environ, TMUX="/fake/tmux,111,0", TMUX_PANE=item["pane"]))
        assert bound.returncode == 0, bound.stderr
        run(args=["tmux", "kill-session", "-t", item["name"]])
        (root / "tmux/raw-log").write_text("")
        run(args=[DEV, "resume-all"])
        raw = (root / "tmux/raw-log").read_text()
        assert f"then pi --session {transcript};" in raw
        assert "dev_launch.py" not in raw and "--guard-profile" not in raw
        # Execute the original fresh helper only against the fake executable.
        execute(manifest=manifest, checkout=checkout)
        receipt = json.loads((root / "agent.json").read_text())
        assert receipt["profile"] == "planning" and receipt["prompt"] == content
        assert receipt["subagent_profile"] is None
        assert not (checkout / "NEVER_RUN").exists()
        execute(manifest=manifest, checkout=checkout, success=False)


# Profile-only pending intent survives staged-before-start recovery. Immediate
# launch sends exactly one Enter; both use the same configured agent pane.
for staged in (True, False):
    root, agent_dir, package = isolate(name=f"profile-intent-{staged}")
    project = configure(root=root)
    # Ordinary unrelated auto-discovered extensions coexist with package guard,
    # as in the installed repository setup.
    (agent_dir / "extensions").mkdir()
    (agent_dir / "extensions/dev-session.ts").write_text("export default function() {}\n")
    options = ["--stage-agent"] if staged else []
    profile = "-planning" if staged else "@planning"
    run(args=[DEV, "new", "--no-attach", *options, "--agent-profile", profile, project])
    item = record(checkout=project)
    manifest = Path(item["launch_manifest"])
    raw = (root / "tmux/raw-log").read_text().splitlines()
    assert sum(line == f"send-keys -t {item['pane']} Enter" for line in raw) == (0 if staged else 1)
    run(args=["tmux", "kill-session", "-t", item["name"]])
    if staged:
        run(args=[DEV, "resume-all"])
        assert record(checkout=project)["launch_manifest"] == str(manifest)
        execute(manifest=manifest, checkout=project)
        assert json.loads((root / "agent.json").read_text())["profile"] == profile
    else:
        # Missing exact conversation never authorizes a second fresh launch.
        run(args=[DEV, "resume-all"], success=False)
        assert not (root / "agent.json").exists()


# The exact ./extensions manifest entry is its own discovery/ignore root.
# Ancestor ignore files cannot hide it, unlike ignore files inside that root.
root, agent_dir, package = isolate(name="ancestor-ignores")
project = configure(root=root)
for directory in (root, agent_dir, package):
    for name in (".gitignore", ".ignore", ".fdignore"):
        (directory / name).write_text("*\n")
run(args=[DEV, "new", "--no-attach", "--stage-agent", "--agent-profile", "planning", project])
execute(manifest=record(checkout=project)["launch_manifest"], checkout=project)
assert json.loads((root / "agent.json").read_text())["profile"] == "planning"


DISCOVERY_FILES = (".gitignore", ".ignore", ".fdignore", "index.ts", "index.js", "package.json")


def alter_discovery(*, package, filename):
    content = "guard.ts\n" if filename.startswith(".") else "export default function() {}\n"
    if filename == "package.json":
        content = json.dumps({"pi": {"extensions": ["./replacement.ts"]}})
        (package / "extensions/replacement.ts").write_text("export default function() {}\n")
    (package / "extensions" / filename).write_text(content)


def bare_project_alias(*, project, package):
    (project / ".pi").mkdir()
    (project / ".pi/policy").symlink_to(package, target_is_directory=True)
    (project / ".pi/settings.json").write_text(json.dumps({"packages": [{"source": "policy", "extensions": []}]}))


# Unknown/unavailable/conflicting/unsupported inputs fail before branch,
# worktree, session, initialization, or durable launch-artifact publication.
for mode in ("unknown", "disabled", "filtered", "autoload", "missing-cli", "ambiguous",
             "project-override", "project-ref-disabled", "top-level-filter", "npm",
             "claude", "wrapper", "subagent", "empty", "duplicate", "unavailable", "manifest-filter", "auto-alias",
             "bare-project-alias", *DISCOVERY_FILES):
    root, agent_dir, package = isolate(name=mode)
    project = configure(root=root, git=True, agent="claude" if mode == "claude" else "pi",
                        command="claude --continue || claude" if mode == "claude" else "env pi" if mode == "wrapper" else "pi")
    options = ["--agent-profile", "unknown" if mode == "unknown" else "" if mode == "empty" else "planning"]
    if mode == "duplicate":
        options.extend(["--agent-profile", "coding"])
    settings = {"packages": ["./packages/pi-guard"]}
    if mode in ("disabled", "filtered", "autoload"):
        settings["packages"] = [{"source": "./packages/pi-guard", **({"autoload": False} if mode == "autoload" else {"extensions": [] if mode == "disabled" else ["!extensions/guard.ts"]})}]
    elif mode == "unavailable":
        settings["packages"] = []
    elif mode == "manifest-filter":
        package_manifest = json.loads((package / "package.json").read_text())
        package_manifest["pi"]["extensions"] = ["./extensions", "!extensions/guard.ts"]
        (package / "package.json").write_text(json.dumps(package_manifest))
    elif mode in DISCOVERY_FILES:
        alter_discovery(package=package, filename=mode)
    elif mode == "bare-project-alias":
        bare_project_alias(project=project, package=package)
        run(args=["git", "-C", project, "add", "."])
        run(args=["git", "-C", project, "commit", "-qm", "bare project alias"])
    elif mode == "auto-alias":
        (agent_dir / "extensions").mkdir()
        (agent_dir / "extensions/guard.ts").symlink_to(package / "extensions/guard.ts")
    elif mode == "missing-cli":
        (package / "guard-profile.mjs").unlink()
    elif mode == "ambiguous":
        settings["packages"].append("./packages/pi-guard")
    elif mode in ("project-override", "project-ref-disabled"):
        (project / ".pi").mkdir()
        (project / ".pi/settings.json").write_text(json.dumps({"packages": [{"source": str(package), "extensions": []}]}))
        run(args=["git", "-C", project, "add", "."])
        run(args=["git", "-C", project, "commit", "-qm", "project override"])
        if mode == "project-ref-disabled":
            # Only the selected destination ref contains the disabling override.
            run(args=["git", "-C", project, "branch", "destination"])
            run(args=["git", "-C", project, "reset", "--hard", "HEAD~1"])
    elif mode == "top-level-filter":
        settings["extensions"] = ["-packages/pi-guard/extensions/guard.ts"]
    elif mode == "npm":
        settings["packages"] = ["npm:@trogers1/pi-guard"]
    elif mode == "subagent":
        os.environ["PI_SUBAGENT_PROFILE"] = "coding"
    (agent_dir / "settings.json").write_text(json.dumps(settings))
    try:
        for entry in ("new", "open", "tree"):
            if mode == "project-ref-disabled" and entry != "tree":
                continue
            branch = "destination" if mode == "project-ref-disabled" else "rejected"
            target = [branch] if entry == "tree" else [project]
            result = run(args=[DEV, entry, "--no-attach", *options, *target], cwd=project, success=False)
            assert result.stderr
            assert not (root / "state/dev/launches").exists()
            assert not list((root / "tmux/sessions").iterdir())
            assert not (root / f"project-worktrees/{branch}").exists()
            if branch == "rejected":
                run(args=["git", "-C", project, "show-ref", "--verify", "refs/heads/rejected"], success=False)
    finally:
        os.environ.pop("PI_SUBAGENT_PROFILE", None)


# A staged launch rechecks changed profile configuration/integration at Enter,
# fails without consuming intent, and can be corrected before its first attempt.
for change in ("config", "disabled", "subagent", "bare-project-alias", *DISCOVERY_FILES):
    root, agent_dir, package = isolate(name=f"staged-{change}")
    project = configure(root=root)
    run(args=[DEV, "new", "--no-attach", "--stage-agent", "--agent-profile", "planning", project])
    item = record(checkout=project)
    manifest = Path(item["launch_manifest"])
    if change == "config":
        (root / "guard-config.json").write_text(json.dumps({"profiles": ["coding"]}))
    elif change == "disabled":
        (agent_dir / "settings.json").write_text(json.dumps({"packages": [{"source": "./packages/pi-guard", "extensions": []}]}))
    elif change == "bare-project-alias":
        bare_project_alias(project=project, package=package)
    elif change in DISCOVERY_FILES:
        alter_discovery(package=package, filename=change)
    else:
        os.environ["PI_SUBAGENT_PROFILE"] = "coding"
    execute(manifest=manifest, checkout=project, success=False)
    assert not (root / "agent.json").exists()
    assert not (manifest.parent / dev_launch.ATTEMPTED_NAME).exists()
    os.environ.pop("PI_SUBAGENT_PROFILE", None)

# Primary-checkout conversion must validate the actual linked destination and
# selected branch ref before publishing artifacts or checking out main. This
# failure must precede even the conversion question, not rely on its refusal.
root, agent_dir, package = isolate(name="conversion-relative-config")
project = configure(root=root, git=True)
run(args=["git", "-C", project, "checkout", "-qb", "topic"])
os.environ["PI_GUARD_PROFILE_CONFIG"] = "relative-profiles.jsonc"
try:
    result = run(args=[DEV, "tree", "--agent-profile", "planning", "topic"], cwd=project, success=False)
finally:
    os.environ.pop("PI_GUARD_PROFILE_CONFIG", None)
assert "requires an absolute PI_GUARD_PROFILE_CONFIG path" in result.stderr, result.stderr
assert "Turn it into a worktree" not in result.stderr, result.stderr
assert run(args=["git", "-C", project, "branch", "--show-current"]).stdout.strip() == "topic"
assert not (root / "state/dev/launches").exists()
assert not (root / "project-worktrees/topic").exists()
assert not list((root / "tmux/sessions").iterdir())

print("dev agent profile tests passed")
