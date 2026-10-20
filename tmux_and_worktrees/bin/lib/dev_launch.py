#!/usr/bin/env python3
"""Durable, one-shot initial input for fresh dev agent launches (never shell eval)."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid

from dev_agent_profile import validate_profile

STATE = Path(os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local/state")) / "dev"
MANIFEST_NAME = "manifest.json"
PROMPT_NAME = "prompt.txt"
ATTEMPTED_NAME = "attempted"
SCHEMA_VERSION = 1
FRESH_COMMANDS = {"pi": ("pi",), "claude": ("claude", "claude --continue || claude")}


def single_line(*, value, name):
    if not isinstance(value, str) or not value or any(char in value for char in "\n\r\t\0"):
        raise ValueError(f"{name} must be a non-empty single-line string")
    return value


def absolute_path(*, value, name):
    path = Path(single_line(value=str(value), name=name))
    if not path.is_absolute():
        raise ValueError(f"{name} must be absolute")
    return path


def prompt_text(*, value):
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        raise ValueError("Initial prompt must be non-empty UTF-8 text without NUL bytes")
    value.encode("utf-8")
    return value


def resolved_windows(*, source):
    if not source or any(char in source for char in "\r\0"):
        raise ValueError("Invalid resolved window TSV")
    rows = [line.split("\t") for line in source.removesuffix("\n").split("\n")]
    for row in rows:
        if len(row) != 3 or row[0] not in ("window", "agent") or not row[1]:
            raise ValueError("Expected resolved windows as kind<TAB>name<TAB>command")
    names = [row[1] for row in rows]
    if len(set(names)) != len(names):
        raise ValueError("Launch options require unique configured window names")
    return rows


def agent_window(*, rows, agent):
    if agent not in FRESH_COMMANDS:
        raise ValueError("Launch options support only pi and claude")
    selected = [row for row in rows if row[0] == "agent"]
    if len(selected) != 1:
        raise ValueError("Launch options require exactly one configured agent window")
    row = selected[0]
    if row[2] not in FRESH_COMMANDS[agent]:
        raise ValueError(f"Unsupported fresh {agent} launch command: {row[2]!r}; use one of {FRESH_COMMANDS[agent]!r}")
    return row


def executable(*, agent):
    found = shutil.which(agent)
    if not found:
        raise ValueError(f"Agent executable is unavailable: {agent}")
    return str(Path(found).resolve())


def launches_root():
    root = (absolute_path(value=STATE, name="dev state") / "launches").resolve()
    return absolute_path(value=root, name="launch directory")


def sync_directory(*, path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def private_file(*, path):
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise ValueError(f"Launch input must be an owned private regular file (0600): {path}")


def read_manifest(*, manifest_path):
    path = absolute_path(value=manifest_path, name="launch manifest")
    root = launches_root()
    if path.name != MANIFEST_NAME or path.parent.parent != root or path != path.resolve():
        raise ValueError(f"Launch manifest must be in a unique directory under {root}")
    metadata = path.parent.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise ValueError(f"Launch directory must be owned and private (0700): {path.parent}")
    private_file(path=path)
    data = json.loads(path.read_text(encoding="utf-8"))
    if (not isinstance(data, dict) or set(data) != {"version", "agent", "prompt_file", "prompt_sha256", "agent_profile"}
            or type(data["version"]) is not int or data["version"] != SCHEMA_VERSION
            or not isinstance(data["agent"], str) or data["agent"] not in FRESH_COMMANDS):
        raise ValueError(f"Invalid launch manifest schema: {path}")
    profile = data["agent_profile"]
    if profile is not None:
        single_line(value=profile, name="agent profile")
        if data["agent"] != "pi":
            raise ValueError("--agent-profile is supported only for Pi")
    if data["prompt_file"] is None:
        if data["prompt_sha256"] is not None or profile is None:
            raise ValueError(f"Invalid profile-only launch manifest: {path}")
        prompt_path, prompt = None, None
    else:
        if data["prompt_file"] != PROMPT_NAME or not isinstance(data["prompt_sha256"], str):
            raise ValueError(f"Invalid launch prompt schema: {path}")
        prompt_path = path.parent / PROMPT_NAME
        private_file(path=prompt_path)
        snapshot = prompt_path.read_bytes()
        prompt = prompt_text(value=snapshot.decode("utf-8"))
        if hashlib.sha256(snapshot).hexdigest() != data["prompt_sha256"]:
            raise ValueError(f"Launch prompt snapshot has changed: {prompt_path}")
    return path, data["agent"], prompt_path, prompt, profile


def launch_command(*, manifest_path):
    path, _, _, _, _ = read_manifest(manifest_path=manifest_path)
    helper = absolute_path(value=Path(__file__).resolve(), name="launch helper")
    interpreter = absolute_path(value=Path(sys.executable).resolve(), name="Python interpreter")
    return shlex.join([str(interpreter), str(helper), "run", str(path)])


def pending_launch_command(*, manifest_path):
    command = launch_command(manifest_path=manifest_path)
    marker = Path(manifest_path).parent / ATTEMPTED_NAME
    if os.path.lexists(marker):
        raise ValueError("Initial launch was already attempted; refusing to replay its prompt/profile. Restore the exact conversation or dev close then start intentionally afresh")
    return command


def write_private(*, path, content):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(content)
        output.flush()
        os.fsync(output.fileno())


def validate_input(*, agent, prompt, prompt_file, profile, cwd, repo, ref, source):
    # Nonmutating preflight: a refused workspace must not publish a bundle.
    rows = resolved_windows(source=source)
    agent_window(rows=rows, agent=agent)
    if prompt is not None and prompt_file is not None:
        raise ValueError("Provide only one of --prompt or --prompt-file")
    if prompt is None and prompt_file is None and profile is None:
        raise ValueError("Provide a prompt or --agent-profile")
    if prompt_file is not None and not Path(prompt_file).is_file():
        raise ValueError(f"Initial prompt file must be a regular file: {prompt_file}")
    content = None
    if prompt is not None or prompt_file is not None:
        content = prompt_text(value=Path(prompt_file).read_bytes().decode("utf-8") if prompt_file is not None else prompt)
    if profile is not None:
        single_line(value=profile, name="agent profile")
        if agent != "pi":
            raise ValueError("--agent-profile is supported only for Pi; Claude retains native permissions")
        validate_profile(profile=profile, cwd=cwd, repo=repo, ref=ref)
    executable(agent=agent)
    launches_root()
    # Validate the eventual helper invocation's path before publishing anything.
    absolute_path(value=Path(__file__).resolve(), name="launch helper")
    absolute_path(value=Path(sys.executable).resolve(), name="Python interpreter")
    return content


def prepare(*, agent, prompt, prompt_file, profile, cwd, repo, ref, source):
    content = validate_input(agent=agent, prompt=prompt, prompt_file=prompt_file, profile=profile,
                             cwd=cwd, repo=repo, ref=ref, source=source)
    root = launches_root()
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    sync_directory(path=STATE)
    staging = Path(tempfile.mkdtemp(prefix=".pending-", dir=root))
    destination = root / uuid.uuid4().hex
    try:
        snapshot = content.encode("utf-8") if content is not None else None
        if snapshot is not None:
            write_private(path=staging / PROMPT_NAME, content=snapshot)
        manifest = {"version": SCHEMA_VERSION, "agent": agent,
                    "prompt_file": PROMPT_NAME if snapshot is not None else None,
                    "prompt_sha256": hashlib.sha256(snapshot).hexdigest() if snapshot is not None else None,
                    "agent_profile": profile}
        write_private(path=staging / MANIFEST_NAME, content=(json.dumps(manifest) + "\n").encode("utf-8"))
        sync_directory(path=staging)
        os.rename(staging, destination)
        sync_directory(path=root)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return destination / MANIFEST_NAME


def replace_windows(*, manifest_path, source, cwd=None, repo=None, ref=None):
    _, agent, _, _, profile = read_manifest(manifest_path=manifest_path)
    if profile is not None and cwd is not None:
        validate_profile(profile=profile, cwd=cwd, repo=repo, ref=ref)
    rows = resolved_windows(source=source)
    row = agent_window(rows=rows, agent=agent)
    row[2] = pending_launch_command(manifest_path=manifest_path)
    return "\n".join("\t".join(row) for row in rows)


def run(*, manifest_path):
    path, agent, prompt_path, prompt, profile = read_manifest(manifest_path=manifest_path)
    binary = executable(agent=agent)
    arguments = [agent]
    if profile is not None:
        # Resolve again at Enter time, using the actual destination settings and
        # package config. Never force-enable an extension or inherit a profile.
        validate_profile(profile=profile, cwd=Path.cwd())
        # Pi otherwise parses @names as files and -names as flags.
        arguments.append(f"--guard-profile={profile}")
    if prompt_path is not None:
        arguments.extend(["@" + str(prompt_path)] if agent == "pi" else ["--", prompt])
    # O_EXCL serializes concurrent starts; any uncertainty after this durable
    # marker is deliberately non-replayable, including a failed exec.
    try:
        descriptor = os.open(path.parent / ATTEMPTED_NAME, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as error:
        raise ValueError("Initial launch already attempted; refusing to replay its prompt/profile") from error
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        output.write("attempted\n")
        output.flush()
        os.fsync(output.fileno())
    sync_directory(path=path.parent)
    os.execv(binary, arguments)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    for name in ("validate", "prepare"):
        create = commands.add_parser(name)
        create.add_argument("--agent", required=True)
        inputs = create.add_mutually_exclusive_group()
        inputs.add_argument("--prompt")
        inputs.add_argument("--prompt-file")
        create.add_argument("--agent-profile")
        create.add_argument("--cwd", default=str(Path.cwd()))
        create.add_argument("--settings-repo")
        create.add_argument("--settings-ref")
    for name in ("command", "windows", "run"):
        operation = commands.add_parser(name)
        operation.add_argument("manifest")
        if name == "windows":
            operation.add_argument("--cwd")
            operation.add_argument("--settings-repo")
            operation.add_argument("--settings-ref")
    args = parser.parse_args()
    if args.operation == "validate":
        validate_input(agent=args.agent, prompt=args.prompt, prompt_file=args.prompt_file, profile=args.agent_profile,
                       cwd=args.cwd, repo=args.settings_repo, ref=args.settings_ref, source=sys.stdin.read())
    elif args.operation == "prepare":
        print(prepare(agent=args.agent, prompt=args.prompt, prompt_file=args.prompt_file, profile=args.agent_profile,
                      cwd=args.cwd, repo=args.settings_repo, ref=args.settings_ref, source=sys.stdin.read()))
    elif args.operation == "command":
        print(launch_command(manifest_path=args.manifest))
    elif args.operation == "windows":
        print(replace_windows(manifest_path=args.manifest, source=sys.stdin.read(),
                              cwd=args.cwd, repo=args.settings_repo, ref=args.settings_ref))
    elif args.operation == "run":
        run(manifest_path=args.manifest)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, UnicodeError, subprocess.SubprocessError) as error:
        print(f"dev launch: {error}", file=sys.stderr)
        raise SystemExit(1)
