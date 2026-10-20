#!/usr/bin/env python3
"""Fake initial-input consumer; only synthetic prompts, never a real agent."""
import json
import os
from pathlib import Path
import subprocess
import sys

agent = sys.argv[1]
arguments = sys.argv[2:]
if agent == "pi":
    if len(arguments) != 1 or not arguments[0].startswith("@"):
        raise ValueError(f"Expected Pi @file initial input, received {arguments!r}")
    source = Path(arguments[0][1:])
    if not source.is_absolute():
        raise ValueError("Pi initial input must use a durable absolute path")
    prompt = source.read_text(encoding="utf-8")
elif agent == "claude":
    if len(arguments) != 2 or arguments[0] != "--":
        raise ValueError(f"Expected Claude positional -- prompt, received {arguments!r}")
    prompt = arguments[1]
else:
    raise ValueError(f"Unexpected fake agent executable: {agent}")
if os.environ.get("DEV_LIFECYCLE_LOCK_FD"):
    raise ValueError("Lifecycle lock marker leaked to fake agent")
identity = subprocess.check_output(
    ["tmux", "display-message", "-p", "-t", os.environ["TMUX_PANE"],
     "#{session_name}\t#{window_name}\t#{pane_id}"], text=True
).strip().split("\t")
record = {"agent": agent, "argv": arguments, "prompt": prompt,
          "cwd": os.getcwd(), "session": identity[0], "window": identity[1],
          "pane": identity[2]}
with open(os.environ["DEV_TEST_RECEIPTS"], "a", encoding="utf-8") as output:
    output.write(json.dumps(record, ensure_ascii=False) + "\n")
# A failed initial invocation must remain attempted, never retry/fallback.
raise SystemExit(17 if os.environ.get("DEV_TEST_AGENT_FAIL") == "true" else 0)
