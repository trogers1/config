const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createRequire } = require("node:module");

const piRequire = createRequire(
  require("path").join(require("path").dirname(process.execPath), "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
);
const { createJiti } = piRequire("jiti");
const jiti = createJiti(__dirname + "/");
const permissions = jiti("../extensions/permissions.ts");

function loadExtension() {
  const commands = new Map();
  const handlers = new Map();
  const entries = [];
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, options) => commands.set(name, options),
    appendEntry: (customType, data) => entries.push({ customType, data }),
  };

  permissions.default(pi);
  return { commands, handlers, entries };
}

function commandContext() {
  const notifications = [];
  const statuses = [];
  return {
    notifications,
    statuses,
    ctx: {
      ui: {
        notify: (message, level) => notifications.push({ message, level }),
        setStatus: (name, value) => statuses.push({ name, value }),
      },
    },
  };
}

test("/profile autocompletes all profiles and marks default active", () => {
  const { commands } = loadExtension();
  const profile = commands.get("profile");

  const completions = profile.getArgumentCompletions("");

  const byValue = new Map(completions.map((item) => [item.value, item.description]));

  assert.equal(byValue.get("default"), "active");
  assert.equal(byValue.get("socrates"), undefined);
  assert.ok(completions.length >= 2);
});

test("/profile autocomplete filters by prefix", () => {
  const { commands } = loadExtension();
  const profile = commands.get("profile");

  assert.deepEqual(profile.getArgumentCompletions("soc").map((item) => item.value), ["socrates"]);
});

test("/profile switching updates the active autocomplete marker", async () => {
  const { commands, entries } = loadExtension();
  const profile = commands.get("profile");
  const { ctx } = commandContext();

  await profile.handler("socrates", ctx);
  const completions = profile.getArgumentCompletions("");

  assert.equal(entries.at(-1).customType, "pi-permissions-profile");
  assert.equal(entries.at(-1).data.profile, "socrates");
  const byValue = new Map(completions.map((item) => [item.value, item.description]));

  assert.equal(byValue.get("default"), undefined);
  assert.equal(byValue.get("socrates"), "active");
  assert.deepEqual(
    completions.filter((item) => item.description === "active").map((item) => item.value),
    ["socrates"],
  );
});

test("/socrates and /socrates-off switch profiles", async () => {
  const { commands } = loadExtension();
  const profile = commands.get("profile");
  const { ctx } = commandContext();

  await commands.get("socrates").handler("", ctx);
  assert.equal(profile.getArgumentCompletions("").find((item) => item.value === "socrates").description, "active");

  await commands.get("socrates-off").handler("", ctx);
  assert.equal(profile.getArgumentCompletions("").find((item) => item.value === "default").description, "active");
});

test("profile status includes emoji, bold profile name, and configured color", async () => {
  const { commands } = loadExtension();
  const { ctx, statuses } = commandContext();

  await commands.get("socrates").handler("", ctx);

  assert.equal(statuses.at(-1).name, "permissions");
  assert.equal(statuses.at(-1).value, "profile: 🧠 \x1b[36m\x1b[1msocrates\x1b[0m\x1b[0m");
});
