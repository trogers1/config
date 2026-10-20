#!/usr/bin/env python3
"""Assertions sharing the production registry and durable-input validators."""
import argparse
import json
from pathlib import Path
import stat
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tmux_and_worktrees/bin/lib"))
import dev_launch
import dev_registry

parser = argparse.ArgumentParser(description=__doc__)
commands = parser.add_subparsers(dest="operation", required=True)
manifest = commands.add_parser("manifest")
manifest.add_argument("registry")
manifest.add_argument("checkout")
manifest.add_argument("expected")
receipts = commands.add_parser("receipts")
receipts.add_argument("file")
receipts.add_argument("expected")
receipts.add_argument("agent")
receipts.add_argument("session")
receipts.add_argument("window")
args = parser.parse_args()
if args.operation == "manifest":
    data = json.loads(Path(args.registry).read_text(encoding="utf-8"))
    dev_registry.validate(data=data)
    record = data["sessions"][args.checkout]
    path, agent, prompt_path, prompt, profile = dev_launch.read_manifest(manifest_path=record["launch_manifest"])
    assert agent == record["agent"]
    assert prompt_path.name == dev_launch.PROMPT_NAME
    assert prompt == Path(args.expected).read_text(encoding="utf-8")
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    print(path)
else:
    records = [json.loads(line) for line in Path(args.file).read_text(encoding="utf-8").splitlines()]
    matching = [record for record in records if record["session"] == args.session]
    assert len(matching) == 1, matching
    record = matching[0]
    assert record["agent"] == args.agent, record
    assert record["window"] == args.window, record
    assert record["prompt"] == Path(args.expected).read_text(encoding="utf-8"), record
    if args.agent == "pi":
        assert len(record["argv"]) == 1 and record["argv"][0].startswith("@"), record
        assert Path(record["argv"][0][1:]).is_file(), record
    else:
        assert record["argv"] == ["--", record["prompt"]], record
