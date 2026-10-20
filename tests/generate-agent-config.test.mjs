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
  const result = spawnSync(process.execPath, [join(fixture, "scripts/generate-agent-config.mjs"), ...args], {
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

  const unrelated = join(generated, "synced/external");
  mkdirSync(unrelated, { recursive: true });
  writeFileSync(join(unrelated, "SKILL.md"), opaqueContent);
  const before = snapshot({ root: generated });
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

  // Scoped and full generation must enforce the same namespace contract.
  const [snippet] = loadSnippets(join(repo, "home/.agents/snippets"));
  assert.ok(snippet, "collision coverage requires a canonical snippet");
  cpSync(join(repo, "home/.agents/snippets", `${snippet.id}.md`), join(fixture, "home/.agents/snippets", `${snippet.id}.md`));
  mkdirSync(join(shared, snippet.id));
  writeFileSync(join(shared, snippet.id, "SKILL.md"), opaqueContent);
  const collision = generate({ args: ["--skill", snippet.id], success: false });
  assert.ok(collision.stderr.includes("collides with the shared skill"));
  assert.deepEqual(snapshot({ root: generated }), complete, "collision must fail before publication");
  console.log("agent config generator CLI tests passed");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
