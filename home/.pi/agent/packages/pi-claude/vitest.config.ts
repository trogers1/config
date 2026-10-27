import { readFileSync } from "node:fs";
import { createRequire, findPackageJSON } from "node:module";
import { dirname, join, resolve } from "node:path";

const agent = process.env.PI_TEST_AGENT_PACKAGE;
if (!agent) throw new Error("Set PI_TEST_AGENT_PACKAGE to the installed Pi package directory");
const hostManifest = join(resolve(agent), "package.json");
const host = createRequire(hostManifest);
// Pi AI exposes import-only exports. Resolve the selected host's package graph
// without imposing require conditions when Knip loads this config as CommonJS.
function hostEntry({ name }: { name: string }) {
  const manifestPath = findPackageJSON(name, hostManifest);
  if (!manifestPath) throw new Error(`Cannot locate selected Pi host peer: ${name}`);
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("main" in manifest) ||
    typeof manifest.main !== "string"
  ) {
    throw new Error(`Selected Pi host peer has no declared main entry: ${name}`);
  }
  return resolve(dirname(manifestPath), manifest.main);
}
const guard = createRequire(new URL("../pi-guard/package.json", import.meta.url));
const tools = createRequire(
  join(resolve(process.env.PI_TEST_TOOLCHAIN ?? process.cwd()), "package.json"),
);

export default {
  resolve: {
    alias: [
      {
        find: /^@earendil-works\/pi-ai\/providers\/(.+)$/,
        replacement: join(dirname(hostEntry({ name: "@earendil-works/pi-ai" })), "providers/$1.js"),
      },
      ...["@earendil-works/pi-ai", "@earendil-works/pi-tui"].map((name) => ({
        find: new RegExp(`^${name}$`),
        replacement: hostEntry({ name }),
      })),
      ...["jsonc-parser", "unbash", "@anthropic-ai/sandbox-runtime"].map((name) => ({
        find: name,
        replacement: guard.resolve(name),
      })),
      { find: /^typebox$/, replacement: host.resolve("typebox") },
      { find: /^typebox\/value$/, replacement: host.resolve("typebox/value") },
      {
        find: /^@earendil-works\/pi-coding-agent$/,
        replacement: join(resolve(agent), "dist/index.js"),
      },
      {
        find: /^vitest$/,
        replacement: join(dirname(tools.resolve("vitest/package.json")), "dist/index.js"),
      },
    ],
  },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30_000, fileParallelism: false },
};
