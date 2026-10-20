#!/usr/bin/env python3
"""Persistent dev intent and exact agent metadata. Never read transcript contents."""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile

from dev_launch import STATE, pending_launch_command

LIB = Path(__file__).resolve().parent
REGISTRY = STATE / "sessions.json"
SCHEMA_VERSION = 4


def empty_registry():
    return {"version": SCHEMA_VERSION, "sessions": {}}


@contextlib.contextmanager
def locked(*, name):
    if not STATE.is_absolute():
        raise ValueError("XDG_STATE_HOME must be an absolute path")
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE / name).open("a", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            yield lock
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def text(*, value, name, empty=False):
    if not isinstance(value, str) or (not value and not empty) or any(c in value for c in "\n\r\t\0"):
        raise ValueError(f"{name} must be a {'possibly empty ' if empty else 'non-empty '}single-line string")
    return value


def conversation(*, value):
    if value is None:
        return None
    if not isinstance(value, dict) or value.get("agent") not in ("pi", "claude"):
        raise ValueError("conversation.agent must be pi or claude")
    text(value=value.get("session_id"), name="conversation.session_id")
    if "transcript_path" not in value:
        raise ValueError("conversation.transcript_path is missing (use null for ephemeral Pi)")
    file = value["transcript_path"]
    if file is not None:
        text(value=file, name="conversation.transcript_path")
        if not Path(file).is_absolute():
            raise ValueError("conversation.transcript_path must be absolute")
    if value["agent"] == "claude" and not re.fullmatch(r"[a-zA-Z0-9_-]+", value["session_id"]):
        raise ValueError("Claude session_id must contain only letters, digits, underscores or hyphens")
    return value


def load():
    if not REGISTRY.exists():
        return empty_registry()
    return validate(data=json.loads(REGISTRY.read_text(encoding="utf-8")))


def validate(*, data):
    if (not isinstance(data, dict) or type(data.get("version")) is not int
            or data["version"] not in (1, 2, 3, SCHEMA_VERSION) or not isinstance(data.get("sessions"), dict)):
        raise ValueError(f"Invalid registry schema: {REGISTRY}; restore its backup before retrying")
    # Old boot metadata no longer governs intent. Migrate without filtering or
    # reordering any records, even when that obsolete metadata is missing/stale.
    migrating = data["version"] != SCHEMA_VERSION
    data = dict(data, version=SCHEMA_VERSION)
    data.pop("boot_id", None)
    for key, record in data["sessions"].items():
        if not isinstance(record, dict) or key != record.get("path") or not Path(key).is_absolute():
            raise ValueError("Invalid registry session path")
        for field in ("name", "path", "branch", "nvim_command", "agent", "pane", "server"):
            text(value=record.get(field), name=f"registry.{field}", empty=field in ("branch", "nvim_command", "agent", "pane"))
        for field in ("stage_agent", "agent_enabled"):
            if not isinstance(record.get(field), bool):
                raise ValueError(f"registry.{field} must be boolean")
        if "conversation" not in record:
            raise ValueError("registry.conversation is missing")
        conversation(value=record["conversation"])
        if migrating:
            record.setdefault("launch_manifest", None)
        if "launch_manifest" not in record:
            raise ValueError("registry.launch_manifest is missing")
        manifest = record["launch_manifest"]
        if manifest is not None:
            text(value=manifest, name="registry.launch_manifest")
            if not Path(manifest).is_absolute():
                raise ValueError("registry.launch_manifest must be absolute")
    return data


def save(*, data):
    data = validate(data=data)
    fd, temporary = tempfile.mkstemp(prefix="sessions-", suffix=".tmp", dir=STATE)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, indent=2)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, REGISTRY)
        directory = os.open(STATE, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def tmux(*, args, check=True):
    return subprocess.run(["tmux", *args], text=True, capture_output=True, check=check)


def identity(*, target):
    result = tmux(args=["display-message", "-p", "-t", target,
                        "#{session_name}\t#{pane_id}\t#{socket_path}\t#{pid}"]).stdout.strip().split("\t")
    if len(result) != 4 or not re.fullmatch(r"%[0-9]+", result[1]) or not result[2] or not result[3].isdigit():
        raise ValueError(f"Cannot identify configured dev agent pane: {target}")
    return {"name": result[0], "pane": result[1], "server": f"{result[2]},{result[3]}"}


def shell(*, script, args):
    return subprocess.run(["bash", "-euc", '. "$1/tmux_worktree.sh"; shift; ' + script,
                           "dev-registry", str(LIB), *args], text=True, capture_output=True, check=True).stdout.rstrip("\n")


def register(*, args):
    if len(args) not in (8, 9):
        raise ValueError("register requires eight arguments and an optional launch manifest")
    name, path, branch, nvim, stage, agent, enabled, pane = args[:8]
    manifest = args[8] if len(args) == 9 and args[8] else None
    binding = identity(target=pane or name)
    with locked(name="registry.lock"):
        data = load()
        previous = data["sessions"].get(path)
        # A retry/adoption of the same live pane must not erase its conversation.
        same = previous and all(previous[k] == binding[k] for k in ("pane", "server"))
        preserving = previous is not None and (same or os.environ.get("DEV_RESUMING") == "true")
        data["sessions"][path] = {
            "name": name, "path": path, "branch": branch, "nvim_command": nvim,
            "stage_agent": stage == "true", "agent": agent, "agent_enabled": enabled == "true",
            "pane": binding["pane"] if pane else "", "server": binding["server"],
            "conversation": previous["conversation"] if preserving else None,
            "launch_manifest": previous["launch_manifest"] if preserving else manifest,
        }
        save(data=data)


def bind(*, agent):
    # Non-tmux agents and subagents are intentionally outside this registry.
    if not os.environ.get("TMUX") or not os.environ.get("TMUX_PANE") or os.environ.get("PI_SUBAGENT_DEPTH", "0") != "0":
        return
    if agent == "claude":
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict) or payload.get("hook_event_name") != "SessionStart":
            raise ValueError("Claude registry hook requires SessionStart metadata")
        if payload.get("agent_id") is not None:
            return
        if payload.get("source") not in ("startup", "resume", "clear", "compact", "fork"):
            raise ValueError("Claude SessionStart.source is missing or unsupported")
        text(value=payload.get("transcript_path"), name="Claude SessionStart.transcript_path")
        metadata = {"agent": agent, "session_id": payload.get("session_id"),
                    "transcript_path": payload.get("transcript_path")}
    else:
        metadata = json.load(sys.stdin)
    metadata = conversation(value=metadata)
    if metadata is None or metadata["agent"] != agent:
        raise ValueError("Agent metadata does not match the recording agent")
    binding = identity(target=os.environ["TMUX_PANE"])
    with locked(name="registry.lock"):
        data = load()
        for record in data["sessions"].values():
            if all(record[k] == binding[k] for k in ("pane", "server")) and record["agent"] == agent:
                record["name"] = binding["name"]
                record["conversation"] = metadata
                save(data=data)
                return


def forget(*, path):
    with locked(name="registry.lock"):
        data = load()
        data["sessions"].pop(path, None)
        save(data=data)


def inventory():
    if not STATE.is_absolute():
        raise ValueError("XDG_STATE_HOME must be an absolute path")
    if not REGISTRY.exists():
        return
    with locked(name="registry.lock"):
        records = load()["sessions"]
    # JSON/dict insertion order is the first successful opening order. Updating
    # an existing record preserves its position; forgetting then reopening appends.
    for path, record in records.items():
        print(f"{path}\t{record['name']}")


def prepare_workspace(*, target, no_attach):
    with locked(name="registry.lock"):
        data = load()
    if not data["sessions"] or shell(
            script='tmux_worktree_find_last_used_managed_session || true', args=[]):
        print("keep")
        return
    guidance = "Saved workspace preserved. Run dev resume-all (or dev switch and select a saved session) to recover it, or retry dev new/open/tree interactively to confirm a fresh start."
    print(f"No running managed dev sessions. Saved workspace: {len(data['sessions'])} recovery record(s):", file=sys.stderr)
    for record in data["sessions"].values():
        branch = f" [branch: {record['branch']}]" if record["branch"] else ""
        print(f"  {record['name']} — {record['path']}{branch}", file=sys.stderr)
    print("Fresh start replaces this ENTIRE saved workspace's recovery records only.\n"
          "No checkouts/worktrees or conversations are deleted.\n"
          f"Requested target {target} will be re-added only after success.", file=sys.stderr)
    if no_attach:
        raise ValueError(f"--no-attach cannot confirm a fresh start. {guidance}")
    try:
        with open("/dev/tty", "w", encoding="utf-8") as output, open("/dev/tty", "r", encoding="utf-8") as terminal:
            output.write("Start a fresh saved workspace? [y/N] ")
            output.flush()
            answer = terminal.readline().strip().lower()
    except OSError as error:
        raise ValueError(f"Cannot read fresh-start confirmation. {guidance}") from error
    if answer not in ("y", "yes"):
        raise ValueError(guidance)
    print("fresh")


def commit_workspace(*, mode, path):
    if mode not in ("fresh", "keep"):
        raise ValueError("Invalid workspace decision")
    with locked(name="registry.lock"):
        data = load()
        if path not in data["sessions"]:
            raise ValueError(f"Successful workspace target was not registered: {path}")
        if mode == "fresh":
            data["sessions"] = {path: data["sessions"][path]}
        save(data=data)


def resume_all(*, path=None):
    with locked(name="registry.lock"):
        data = load()
        sessions = data["sessions"]
        if path is not None and path not in sessions:
            raise ValueError(f"No registered dev session for {path!r}; use dev new/dev tree to create one")
        records = list(sessions.values()) if path is None else [sessions[path]]
    failures = []
    for record in records:
        path, name = record["path"], record["name"]
        try:
            existing = shell(script='tmux_worktree_find_session_for_worktree_path "$1" || true', args=[path])
            if existing:
                print(f"Already open: {existing}")
                continue
            if tmux(args=["has-session", "-t", f"={name}"], check=False).returncode == 0:
                raise ValueError(f"tmux name {name!r} is occupied by another session; rename it and retry")
            if not Path(path).is_dir():
                raise ValueError(f"checkout missing: {path}; restore it at that path and retry")
            if record["agent_enabled"] and not record["pane"]:
                raise ValueError("session predates tracking; its configured agent/pane cannot be inferred. Run dev close from that checkout, then dev new/dev tree to bootstrap tracking")
            windows = shell(script='tmux_worktree_dev_config_windows_for_path "$1" "$2"', args=[path, record["agent"]])
            lines = [line.split("\t", 2) for line in windows.splitlines()]
            agent_lines = [line for line in lines if line[0] == "agent" and line[2]]
            recorded = conversation(value=record["conversation"])
            recovery_manifest = None
            if record["agent_enabled"]:
                if len(agent_lines) != 1:
                    raise ValueError("configured agent window is missing/disabled; restore devConfig.jsonc and retry")
                if recorded is None:
                    if record["launch_manifest"] is not None:
                        if not record["stage_agent"]:
                            raise ValueError("initial launch has no exact conversation and was not staged; refusing to replay its prompt/profile. Restore the exact conversation or dev close then start intentionally afresh")
                        pending_launch_command(manifest_path=record["launch_manifest"])
                        recovery_manifest = record["launch_manifest"]
                    elif not record["stage_agent"]:
                        raise ValueError("exact agent conversation was never recorded; load the registry integration in the original agent, or dev close then dev new to intentionally start over")
                else:
                    if recorded["agent"] != record["agent"]:
                        raise ValueError("recorded conversation does not match selected agent")
                    transcript = recorded["transcript_path"]
                    if not transcript or not Path(transcript).is_file() or not os.access(transcript, os.R_OK) or Path(transcript).stat().st_size == 0:
                        raise ValueError(f"exact {record['agent']} transcript missing/empty: {transcript!r}; restore that file and retry (ephemeral sessions cannot resume)")
                    # Never retain a --continue / fallback-to-fresh command on resume.
                    command = (["pi", "--session", transcript] if record["agent"] == "pi"
                               else ["claude", "--resume", recorded["session_id"]])
                    quoted_file = shlex.quote(transcript)
                    failure = shlex.quote(f"dev resume: exact transcript missing/empty/unreadable: {transcript}; restore that file and retry dev resume-all")
                    # Check again when Enter is pressed, especially for staged
                    # commands that may sit at the prompt for hours.
                    agent_lines[0][2] = (
                        f"if [ -r {quoted_file} ] && [ -s {quoted_file} ]; then {shlex.join(command)}; "
                        f"else printf '%s\\n' {failure} >&2; fi"
                    )
            else:
                # A config change must not introduce an untracked fresh conversation.
                for line in agent_lines:
                    line[2] = ""
            windows = "\n".join("\t".join(line) for line in lines)
            arguments = [name, path, record["branch"], record["nvim_command"], windows,
                         str(record["stage_agent"]).lower(), record["agent"]]
            # Only pending launches receive the eighth argument: the shell
            # adapter rewrites that window. Exact resumes must never be rewritten.
            if recovery_manifest is not None:
                arguments.append(recovery_manifest)
            shell(script='DEV_RESUMING=true tmux_worktree_create_standard_session "$@"', args=arguments)
            print(f"Resumed detached: {name}")
        except (ValueError, OSError, subprocess.CalledProcessError) as error:
            detail = error.stderr.strip() if isinstance(error, subprocess.CalledProcessError) else str(error)
            failures.append(f"{name}: {detail}")
    if failures:
        raise ValueError("Resume failed (records retained):\n" + "\n".join(failures))


def inside_initializer():
    """A live initializer ancestor is waiting for us; acquiring its lock deadlocks."""
    marker = os.environ.get("DEV_INITIALIZER_PID", "")
    if not marker.isdigit():
        return False
    ancestor = os.getppid()
    while ancestor > 1:
        if ancestor == int(marker):
            return True
        parent = subprocess.run(["ps", "-o", "ppid=", "-p", str(ancestor)],
                                text=True, capture_output=True, check=False).stdout.strip()
        if not parent.isdigit():
            return False  # The initializer has exited; descendants lock normally.
        ancestor = int(parent)
    return False


def main():
    command, *args = sys.argv[1:]
    if command in ("external", "initialize"):
        # subprocess closes inherited descriptors, not just their environment
        # markers. Project scripts and a newly spawned tmux server must never
        # retain the lifecycle lock or the ability to unlock it.
        env = dict(os.environ)
        for key in ("DEV_LIFECYCLE_LOCK_FD", "DEV_RESUMING", "DEV_INITIALIZER_PID"):
            env.pop(key, None)
        if command == "initialize":
            env["DEV_INITIALIZER_PID"] = str(os.getpid())
        raise SystemExit(subprocess.run(args, env=env, close_fds=True).returncode)
    elif command == "run":
        if inside_initializer():
            raise ValueError("dev lifecycle commands cannot run synchronously inside an active worktree initializer; run them after dev tree finishes")
        # Serialize intentional lifecycle operations, separately from hook writes.
        with locked(name="lifecycle.lock") as lock:
            # fd 3 is reserved by dev tree --no-attach for caller stdout.
            descriptor = fcntl.fcntl(lock.fileno(), fcntl.F_DUPFD_CLOEXEC, 10)
            try:
                env = dict(os.environ, DEV_LIFECYCLE_LOCK_FD=str(descriptor))
                raise SystemExit(subprocess.run(args, env=env, pass_fds=(descriptor,)).returncode)
            finally:
                os.close(descriptor)
    elif command == "unlock":
        if os.environ.get("DEV_LIFECYCLE_LOCK_FD"):
            fcntl.flock(int(os.environ["DEV_LIFECYCLE_LOCK_FD"]), fcntl.LOCK_UN)
    elif command == "check":
        with locked(name="registry.lock"):
            load()
    elif command == "prepare-workspace":
        prepare_workspace(target=args[0], no_attach=args[1] == "true")
    elif command == "commit-workspace":
        commit_workspace(mode=args[0], path=args[1])
    elif command == "checkpoint":
        with locked(name="registry.lock"):
            print(json.dumps(load()["sessions"].get(args[0])))
    elif command == "restore":
        path, previous = args
        with locked(name="registry.lock"):
            data = load()
            record = json.loads(previous)
            if record is None:
                data["sessions"].pop(path, None)
            else:
                data["sessions"][path] = record
            save(data=data)
    elif command == "register":
        register(args=args)
    elif command == "adopt":
        name, path, branch = args
        with locked(name="registry.lock"):
            data = load()
            if path not in data["sessions"]:
                binding = identity(target=name)
                data["sessions"][path] = {
                    "name": name, "path": path, "branch": branch, "nvim_command": "",
                    "stage_agent": False, "agent": "", "agent_enabled": True,
                    "pane": "", "server": binding["server"], "conversation": None,
                    "launch_manifest": None,
                }
                save(data=data)
    elif command == "bind":
        bind(agent=args[0])
    elif command == "forget":
        forget(path=args[0])
    elif command == "list":
        if args:
            raise ValueError("Usage: dev_registry.py list")
        inventory()
    elif command == "resume":
        if len(args) != 1:
            raise ValueError("Usage: dev_registry.py resume <absolute registered path>")
        resume_all(path=args[0])
    elif command == "resume-all":
        resume_all()
    else:
        raise ValueError(f"Unknown registry operation: {command}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"dev registry: {error}", file=sys.stderr)
        raise SystemExit(1)
