// Exercise the installed Pi extension factory/event boundary without an LLM.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../home/.pi/agent/packages/pi-guard-subagents/package.json", import.meta.url));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url);
const { default: extension } = await jiti.import(fileURLToPath(new URL("../home/.pi/agent/extensions/dev-session.ts", import.meta.url)));
let start;
extension({
  on(event, handler) {
    assert.equal(event, "session_start");
    start = handler;
  },
});
assert.equal(typeof start, "function");
const files = process.argv.slice(2);
for (const [index, file] of files.entries()) {
  const ctx = {
    mode: process.env.TEST_PI_MODE ?? "tui",
    sessionManager: {
      getSessionId: () => `pi-test-${index}`,
      getSessionFile: () => file === "ephemeral" ? undefined : file,
    },
  };
  // The documented lifecycle covers startup, /new, /resume and /fork.
  await start({ type: "session_start", reason: ["startup", "new", "resume", "fork"][index % 4] }, ctx);
}
