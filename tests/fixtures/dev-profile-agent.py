#!/usr/bin/env python3
"""An isolated Pi argv boundary; no model, credentials, or tmux interaction."""
import json
import os
from pathlib import Path
import sys

arguments = sys.argv[1:]
assert arguments and arguments[0].startswith("--guard-profile="), arguments
assert len(arguments) in (1, 2), arguments
profile = arguments[0].split("=", 1)[1]
assert profile, arguments
prompt = None
if len(arguments) == 2:
    assert arguments[1].startswith("@"), arguments
    prompt = Path(arguments[1][1:]).read_text(encoding="utf-8")
Path(os.environ["DEV_TEST_AGENT_RECEIPT"]).write_text(json.dumps({
    "argv": arguments, "profile": profile, "prompt": prompt,
    "subagent_profile": os.environ.get("PI_SUBAGENT_PROFILE"),
}))
