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


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: read_dev_config_windows.py <devConfig.jsonc>")

    path = sys.argv[1]
    with open(path, "r", encoding="utf-8") as f:
        source = f.read()

    config = json.loads(strip_trailing_commas(strip_jsonc(source)))
    windows = config.get("windows", [])
    if not isinstance(windows, list):
        raise SystemExit("devConfig.jsonc windows must be an array")

    for index, window in enumerate(windows):
        if not isinstance(window, dict):
            raise SystemExit(f"devConfig.jsonc windows[{index}] must be an object")

        name = window.get("name")
        command = window.get("command", "")
        if not isinstance(name, str) or not name:
            raise SystemExit(f"devConfig.jsonc windows[{index}].name must be a non-empty string")
        if command is None:
            command = ""
        if not isinstance(command, str):
            raise SystemExit(f"devConfig.jsonc windows[{index}].command must be a string")

        print(f"{name}\t{command}")


if __name__ == "__main__":
    main()
