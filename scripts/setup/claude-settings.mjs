#!/usr/bin/env node
// Shared setup's additive view of ~/.claude/settings.json. The hooks it owns
// are exactly those in the repo's home/.claude/settings.json (which personal
// setup links whole); every other key in the target is user-owned.
//
//   claude-settings.mjs status|install|uninstall <target settings.json> <repo settings.json>
//
// `status` prints `owned` (every hook present), `partial`, or `absent`.
// A hook is identified by its event, type, and exact command.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const OPERATIONS = ["status", "install", "uninstall"];

function readSettings({ path }) {
  if (!existsSync(path)) return {};
  const settings = JSON.parse(readFileSync(path, "utf8"));
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`${path}: settings must be a JSON object`);
  }
  return settings;
}

/** Every hook the repo settings define, flattened to { event, matcher, hook }. */
function ownedHooks({ repoSettings, path }) {
  const owned = Object.entries(repoSettings.hooks ?? {}).flatMap(([event, groups]) =>
    groups.flatMap((group) => group.hooks.map((hook) => ({ event, matcher: group.matcher, hook }))),
  );
  if (owned.length === 0) throw new Error(`${path}: defines no hooks to install`);
  return owned;
}

const sameHook = ({ a, b }) => a.type === b.type && a.command === b.command;

function isInstalled({ settings, owned }) {
  return (settings.hooks?.[owned.event] ?? []).some((group) => group.hooks?.some((hook) => sameHook({ a: hook, b: owned.hook })));
}

function install({ settings, owned }) {
  const hooks = { ...settings.hooks };
  for (const entry of owned.filter((o) => !isInstalled({ settings, owned: o }))) {
    const group = entry.matcher === undefined ? { hooks: [entry.hook] } : { matcher: entry.matcher, hooks: [entry.hook] };
    hooks[entry.event] = [...(hooks[entry.event] ?? []), group];
  }
  return { ...settings, hooks };
}

function uninstall({ settings, owned }) {
  const hooks = {};
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const remaining = groups
      .map((group) => ({
        ...group,
        hooks: group.hooks.filter((hook) => !owned.some((o) => o.event === event && sameHook({ a: hook, b: o.hook }))),
      }))
      .filter((group) => group.hooks.length > 0);
    if (remaining.length > 0) hooks[event] = remaining;
  }
  const { hooks: _removed, ...rest } = settings;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

const [operation, targetPath, repoPath] = process.argv.slice(2);
if (!OPERATIONS.includes(operation) || !targetPath || !repoPath) {
  throw new Error(`Usage: claude-settings.mjs ${OPERATIONS.join("|")} <target settings.json> <repo settings.json>`);
}
const settings = readSettings({ path: targetPath });
const owned = ownedHooks({ repoSettings: readSettings({ path: repoPath }), path: repoPath });
const installedCount = owned.filter((o) => isInstalled({ settings, owned: o })).length;

if (operation === "status") {
  process.stdout.write(`${installedCount === owned.length ? "owned" : installedCount === 0 ? "absent" : "partial"}\n`);
} else {
  const next = operation === "install" ? install({ settings, owned }) : uninstall({ settings, owned });
  writeFileSync(targetPath, `${JSON.stringify(next, null, 2)}\n`);
}
