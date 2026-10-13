#!/usr/bin/env python3
import argparse
import json
import sys


def strip_jsonc(source):
    out = []
    in_string = False
    escape = False
    i = 0

    while i < len(source):
        ch = source[i]
        nxt = source[i + 1] if i + 1 < len(source) else ""

        if in_string:
            out.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            i += 1
            continue

        if ch == '"':
            in_string = True
            out.append(ch)
            i += 1
        elif ch == "/" and nxt == "/":
            i += 2
            while i < len(source) and source[i] not in "\r\n":
                i += 1
        elif ch == "/" and nxt == "*":
            i += 2
            while i + 1 < len(source) and not (source[i] == "*" and source[i + 1] == "/"):
                i += 1
            i += 2
        else:
            out.append(ch)
            i += 1

    return "".join(out)


def strip_trailing_commas(source):
    out = []
    in_string = False
    escape = False

    for ch in source:
        if in_string:
            out.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue

        if ch == '"':
            in_string = True
            out.append(ch)
        elif ch in "]}":
            while out and out[-1].isspace():
                out.pop()
            if out and out[-1] == ",":
                out.pop()
            out.append(ch)
        else:
            out.append(ch)

    return "".join(out)


def read_agents(config, name):
    agents = config.get("agents", {})
    if not isinstance(agents, dict):
        raise SystemExit(f"{name} agents must be an object")
    for agent, command in agents.items():
        if not isinstance(command, str) or not command:
            raise SystemExit(f"{name} agents.{agent} must be a non-empty command string")

    default_agent = config.get("defaultAgent")
    if default_agent is not None and default_agent not in agents:
        raise SystemExit(f"{name} defaultAgent {default_agent!r} is not defined in agents")

    return agents, default_agent


def warn(message):
    print(f"warning: {message}", file=sys.stderr)


# A missing agent is not worth failing a session over: the agent window, if
# any, opens as an empty shell instead.
def agent_command(agents, default_agent, args):
    agent = args.agent or default_agent
    if agent is None:
        warn(f"{args.name} has an agent window but no defaultAgent; opening no agent (pass --agent <name>)")
        return ""
    if agent not in agents:
        available = ", ".join(sorted(agents)) or "none"
        warn(f"agent {agent!r} is not available in {args.name} (available: {available}); opening no agent")
        return ""
    return agents[agent]


def parse_args():
    parser = argparse.ArgumentParser(description="Print a devConfig.jsonc's tmux windows as <kind>\t<name>\t<command> lines.")
    parser.add_argument("config", help="devConfig.jsonc path, or - to read it from stdin")
    parser.add_argument("--name", help="how messages name the config (default: its path)")
    parser.add_argument("--agent", default="", help="agent for the agent window (default: defaultAgent)")
    args = parser.parse_args()
    if args.name is None:
        args.name = "stdin" if args.config == "-" else args.config
    return args


def main():
    args = parse_args()
    if args.config == "-":
        source = sys.stdin.read()
    else:
        with open(args.config, "r", encoding="utf-8") as f:
            source = f.read()
    name = args.name

    config = json.loads(strip_trailing_commas(strip_jsonc(source)))
    windows = config.get("windows", [])
    if not isinstance(windows, list):
        raise SystemExit(f"{name} windows must be an array")
    agents, default_agent = read_agents(config, name)
    if not windows:
        raise SystemExit(f"No windows configured in {name}")

    lines = []
    has_agent_window = False
    for index, window in enumerate(windows):
        if not isinstance(window, dict):
            raise SystemExit(f"{name} windows[{index}] must be an object")

        window_name = window.get("name")
        if not isinstance(window_name, str) or not window_name:
            raise SystemExit(f"{name} windows[{index}].name must be a non-empty string")

        is_agent = window.get("agent", False)
        if not isinstance(is_agent, bool):
            raise SystemExit(f"{name} windows[{index}].agent must be a boolean")
        if is_agent:
            # The agent window's command comes from the selected agent, so a
            # fixed command alongside it would be ambiguous.
            if "command" in window:
                raise SystemExit(f"{name} windows[{index}] sets both agent and command")
            has_agent_window = True
            kind = "agent"
            command = agent_command(agents, default_agent, args)
        else:
            kind = "window"
            command = window.get("command", "")
            if command is None:
                command = ""
            if not isinstance(command, str):
                raise SystemExit(f"{name} windows[{index}].command must be a string")

        # The kind comes first because it is never empty: bash `read` with a
        # tab IFS collapses empty fields, so only the last one may be empty.
        lines.append(f"{kind}\t{window_name}\t{command}")

    if args.agent and not has_agent_window:
        warn(f"agent {args.agent!r} is not available in {name}, which has no agent window; opening no agent")

    for line in lines:
        print(line)


if __name__ == "__main__":
    main()
