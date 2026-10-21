#!/usr/bin/env node
// Exercise the generator CLI with generic inputs, not skill-document semantics.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSnippets } from "../home/.claude/hooks/snippets.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const names = ["fixture-first", "fixture-second"];
const temp = mkdtempSync(join(tmpdir(), "agent-config-generator-"));
const fixture = join(temp, "config");
const shared = join(fixture, "home/.agents/skills");
const generated = join(fixture, "home/.claude/skills");
const env = { PATH: process.env.PATH, HOME: join(temp, "home"), XDG_STATE_HOME: join(temp, "state"), XDG_CONFIG_HOME: join(temp, "xdg") };
const scoped = names.flatMap((name) => ["--skill", name]);
const opaqueContent = "opaque generator fixture\n";

function generate({ args, success = true }) {
  const pathAdapter = process.env.TEST_GENERATOR_WINDOWS_PATHS === "1"
    ? ["--import", join(repo, "tests/support/windows-path-facade.mjs")]
    : [];
  const result = spawnSync(process.execPath, [...pathAdapter, join(fixture, "scripts/generate-agent-config.mjs"), ...args], {
    cwd: fixture, env, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status === 0, success, result.stderr);
  return result;
}

function snapshot({ root }) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => !entry.isDirectory()).map((entry) => {
    const path = join(entry.parentPath, entry.name);
    return [path, entry.isSymbolicLink() ? readlinkSync(path) : readFileSync(path, "utf8")];
  }).sort(([left], [right]) => left.localeCompare(right));
}

try {
  for (const path of [shared, generated, join(fixture, "home/.agents/agents"), join(fixture, "home/.agents/snippets"), dirname(env.HOME)]) mkdirSync(path, { recursive: true });
  for (const path of ["scripts/generate-agent-config.mjs", "home/.claude/hooks/snippets.mjs"]) {
    mkdirSync(dirname(join(fixture, path)), { recursive: true });
    cpSync(join(repo, path), join(fixture, path));
  }
  generate({ args: [] });
  generate({ args: ["--check"] });

  const externalAgents = ["home/.claude/agents", "home/.pi/agent/packages/pi-guard-subagents/agents"].map((root) => join(fixture, root, "synced.md"));
  for (const path of externalAgents) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, opaqueContent);
  }
  const unrelated = join(generated, "synced/external");
  mkdirSync(unrelated, { recursive: true });
  writeFileSync(join(unrelated, "SKILL.md"), opaqueContent);
  const before = snapshot({ root: generated });
  generate({ args: ["--check"] });
  generate({ args: [] });
  assert.deepEqual(snapshot({ root: generated }), before, "full generation must preserve external resources");
  for (const path of externalAgents) assert.equal(readFileSync(path, "utf8"), opaqueContent);
  // Ownership follows newly generated names, even after their source is gone.
  const retiredName = "fixture-retired";
  mkdirSync(join(shared, retiredName));
  writeFileSync(join(shared, retiredName, "SKILL.md"), opaqueContent);
  generate({ args: [] });
  generate({ args: ["--check"] });
  rmSync(join(shared, retiredName), { recursive: true });
  const orphanCheck = generate({ args: ["--check"], success: false });
  assert.ok(orphanCheck.stderr.includes(`home/.claude/skills/${retiredName}`));
  generate({ args: [] });
  generate({ args: ["--check"] });
  assert.deepEqual(snapshot({ root: generated }), before, "only previously generated entries may be removed");
  for (const name of names) {
    mkdirSync(join(shared, name));
    writeFileSync(join(shared, name, "SKILL.md"), opaqueContent);
  }
  const stale = generate({ args: ["--check", ...scoped], success: false });
  for (const name of names) assert.ok(stale.stderr.includes(`home/.claude/skills/${name}`));
  assert.deepEqual(snapshot({ root: generated }), before, "check must not publish anything");

  generate({ args: scoped });
  generate({ args: ["--check", ...scoped] });
  for (const [path, content] of before) assert.equal(readFileSync(path, "utf8"), content);
  for (const name of names) {
    const target = join(generated, name);
    assert.ok(lstatSync(target).isSymbolicLink());
    assert.equal(resolve(dirname(target), readlinkSync(target)), join(shared, name));
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), opaqueContent);
  }

  generate({ args: ["--check"] });
  writeFileSync(join(shared, names[0], "SKILL.md"), opaqueContent + "updated\n");
  // Shared skill content is linked, not copied; a broken generated link is stale.
  rmSync(join(generated, names[0]));
  symlinkSync("missing", join(generated, names[0]));
  generate({ args: ["--check"], success: false });
  generate({ args: [] });
  generate({ args: ["--check"] });
  assert.equal(readFileSync(join(unrelated, "SKILL.md"), "utf8"), opaqueContent);
  const complete = snapshot({ root: generated });
  for (const args of [["--skill"], ["--skill", `../${names[0]}`], ["--skill", names[0], "--skill", "unknown"], ["--typo"]]) {
    generate({ args, success: false });
    assert.deepEqual(snapshot({ root: generated }), complete);
  }
  rmSync(join(generated, names[0]));
  symlinkSync("missing", join(generated, names[0]));
  generate({ args: ["--check", ...scoped], success: false });
  generate({ args: scoped });
  generate({ args: ["--check", ...scoped] });
  assert.deepEqual(snapshot({ root: generated }), complete);

  const ownershipPath = join(fixture, "scripts/generated-agent-config-ownership.json");
  const ownership = readFileSync(ownershipPath, "utf8");
  for (const invalid of [["home/.claude/skills"], ["home/.claude/skills/../../external"], ["home/.claude/skills/synced/external"]]) {
    writeFileSync(ownershipPath, JSON.stringify(invalid));
    generate({ args: [], success: false });
    assert.deepEqual(snapshot({ root: generated }), complete, "invalid ownership must fail before deletion");
  }
  writeFileSync(ownershipPath, ownership);

  // Copied agent/snippet outputs also retain ownership after source removal.
  const agentSource = join(fixture, "home/.agents/agents/fixture-agent.md");
  writeFileSync(agentSource, "---\nname: fixture-agent\ndescription: Fixture agent\ntier: default\n---\nOpaque agent instructions.\n");
  const [snippet] = loadSnippets(join(repo, "home/.agents/snippets"));
  assert.ok(snippet, "coverage requires a canonical snippet");
  const snippetSource = join(fixture, "home/.agents/snippets", `${snippet.id}.md`);
  cpSync(join(repo, "home/.agents/snippets", `${snippet.id}.md`), snippetSource);
  generate({ args: [] });
  generate({ args: ["--check"] });
  const generatedOwnership = JSON.parse(readFileSync(ownershipPath, "utf8"));
  assert.ok(generatedOwnership.every((path) => !path.includes("\\")), "persisted ownership must use POSIX separators");
  assert.ok(generatedOwnership.includes(`home/.claude/skills/${snippet.id}`), "snippet ownership must identify its directory on every platform");
  rmSync(agentSource);
  rmSync(snippetSource);
  const removed = generate({ args: ["--check"], success: false });
  assert.ok(removed.stderr.includes("agents/fixture-agent.md"));
  assert.ok(removed.stderr.includes(`skills/${snippet.id}/SKILL.md`));
  generate({ args: [] });
  generate({ args: ["--check"] });
  assert.deepEqual(snapshot({ root: generated }), complete);
  for (const path of externalAgents) assert.equal(readFileSync(path, "utf8"), opaqueContent);

  // Scoped and full generation must enforce the same namespace contract.
  cpSync(join(repo, "home/.agents/snippets", `${snippet.id}.md`), snippetSource);
  mkdirSync(join(shared, snippet.id));
  writeFileSync(join(shared, snippet.id, "SKILL.md"), opaqueContent);
  const collision = generate({ args: ["--skill", snippet.id], success: false });
  assert.ok(collision.stderr.includes("collides with the shared skill"));
  assert.deepEqual(snapshot({ root: generated }), complete, "collision must fail before publication");
  console.log(`agent config generator CLI tests passed (${process.env.TEST_GENERATOR_WINDOWS_PATHS === "1" ? "win32 path facade" : process.platform})`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

// Repeat the public CLI flows with win32 paths rather than testing private
// normalization helpers. Native Windows runs the same suite without an adapter.
if (process.platform !== "win32" && process.env.TEST_GENERATOR_WINDOWS_PATHS !== "1") {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, TEST_GENERATOR_WINDOWS_PATHS: "1" }, encoding: "utf8", timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  process.stdout.write(result.stdout);
}
