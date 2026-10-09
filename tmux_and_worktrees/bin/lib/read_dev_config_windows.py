#!/usr/bin/env python3
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


def read_agents(config):
    agents = config.get("agents", {})
    if not isinstance(agents, dict):
        raise SystemExit("devConfig.jsonc agents must be an object")
    for name, command in agents.items():
        if not isinstance(command, str) or not command:
            raise SystemExit(f"devConfig.jsonc agents.{name} must be a non-empty command string")

    default_agent = config.get("defaultAgent")
    if default_agent is not None and default_agent not in agents:
        raise SystemExit(f"devConfig.jsonc defaultAgent {default_agent!r} is not defined in agents")

    return agents, default_agent


def agent_command(agents, default_agent, requested_agent, path):
    agent = requested_agent or default_agent
    if agent is None:
        raise SystemExit(f"{path} has an agent window but no defaultAgent; pass --agent <name>")
    if agent not in agents:
        available = ", ".join(sorted(agents))
        raise SystemExit(f"Unknown agent {agent!r} in {path}; available: {available}")
    return agents[agent]


def main():
    if len(sys.argv) not in (2, 3):
        raise SystemExit("Usage: read_dev_config_windows.py <devConfig.jsonc> [agent]")

    path = sys.argv[1]
    requested_agent = sys.argv[2] if len(sys.argv) == 3 else ""
    with open(path, "r", encoding="utf-8") as f:
        source = f.read()

    config = json.loads(strip_trailing_commas(strip_jsonc(source)))
    windows = config.get("windows", [])
    if not isinstance(windows, list):
        raise SystemExit("devConfig.jsonc windows must be an array")
    agents, default_agent = read_agents(config)

    lines = []
    has_agent_window = False
    for index, window in enumerate(windows):
        if not isinstance(window, dict):
            raise SystemExit(f"devConfig.jsonc windows[{index}] must be an object")

        name = window.get("name")
        if not isinstance(name, str) or not name:
            raise SystemExit(f"devConfig.jsonc windows[{index}].name must be a non-empty string")

        is_agent = window.get("agent", False)
        if not isinstance(is_agent, bool):
            raise SystemExit(f"devConfig.jsonc windows[{index}].agent must be a boolean")
        if is_agent:
            # The agent window's command comes from the selected agent, so a
            # fixed command alongside it would be ambiguous.
            if "command" in window:
                raise SystemExit(f"devConfig.jsonc windows[{index}] sets both agent and command")
            has_agent_window = True
            kind = "agent"
            command = agent_command(agents, default_agent, requested_agent, path)
        else:
            kind = "window"
            command = window.get("command", "")
            if command is None:
                command = ""
            if not isinstance(command, str):
                raise SystemExit(f"devConfig.jsonc windows[{index}].command must be a string")

        # The kind comes first because it is never empty: bash `read` with a
        # tab IFS collapses empty fields, so only the last one may be empty.
        lines.append(f"{kind}\t{name}\t{command}")

    if requested_agent and not has_agent_window:
        raise SystemExit(f"--agent {requested_agent} was given, but {path} has no agent window")

    for line in lines:
        print(line)


if __name__ == "__main__":
    main()
