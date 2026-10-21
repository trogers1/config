#!/usr/bin/env node
// Real installed Pi lifecycle, no prompts, credentials, or network calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.DEV_LIFECYCLE_FIXTURE) {
  const fixture = mkdtempSync(join(tmpdir(), "dev-pi-lifecycle-"));
  try {
    mkdirSync(join(fixture, "bin"));
    writeFileSync(join(fixture, "bin/dev"), '#!/bin/sh\n[ "$1" = _record-agent ] && [ "$2" = pi ] || exit 1\nnode -e \'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>require("fs").appendFileSync(process.env.DEV_LIFECYCLE_FIXTURE+"/records",s+"\\n"))\'\n');
    chmodSync(join(fixture, "bin/dev"), 0o755);
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, HOME: fixture, PI_CODING_AGENT_DIR: join(fixture, "agent"), DEV_LIFECYCLE_FIXTURE: fixture, TMUX: "/fake/tmux,1,0", TMUX_PANE: "%1", PI_SUBAGENT_DEPTH: "0" },
      encoding: "utf8", timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    console.log("installed Pi dev-session lifecycle smoke passed");
  } finally { rmSync(fixture, { recursive: true, force: true }); }
} else {
  const fixture = process.env.DEV_LIFECYCLE_FIXTURE;
  // Match the extension typecheck's SDK, not an unrelated global Pi install.
  const sdk = await import(new URL("../home/.pi/agent/packages/pi-guard-subagents/node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url).href);
  const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = sdk;
  const cwd = join(fixture, "workspace");
  mkdirSync(cwd);
  const agentDir = join(fixture, "agent");
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    additionalExtensionPaths: [resolve(dirname(fileURLToPath(import.meta.url)), "../home/.pi/agent/extensions/dev-session.ts")],
  });
  await resourceLoader.reload();
  const manager = SessionManager.create(cwd, join(fixture, "sessions"));
  const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, sessionManager: manager, tools: [] });
  assert.deepEqual(extensionsResult.errors, []);
  const errors = [];
  try {
    await session.bindExtensions({ mode: "json", onError: (error) => errors.push(error) });
    assert.equal(existsSync(join(fixture, "records")), false, "non-TUI must not record");
    await session.bindExtensions({ mode: "tui", onError: (error) => errors.push(error) });
    assert.deepEqual(errors, []);
    const records = readFileSync(join(fixture, "records"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records, [{ agent: "pi", session_id: manager.getSessionId(), transcript_path: manager.getSessionFile() ?? null }]);
  } finally { session.dispose(); }
}
