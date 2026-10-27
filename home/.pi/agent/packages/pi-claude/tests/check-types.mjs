// Check our adapter against the selected installed Pi, not a second runtime in
// devDependencies. Compiler and host paths are explicit so this check cannot
// accidentally certify a different Pi version from a sibling package.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const compilerPath = process.env.PI_TEST_TYPESCRIPT ?? "typescript";
const agentPath = process.env.PI_TEST_AGENT_PACKAGE;
if (!agentPath) {
  throw new Error(
    "Set PI_TEST_AGENT_PACKAGE to the installed Pi package directory. PI_TEST_TYPESCRIPT may select an existing compiler; no packages are installed by this check.",
  );
}
const ts = require(compilerPath);
const agent = resolve(agentPath);
const agentRequire = createRequire(join(agent, "package.json"));
const version = JSON.parse(readFileSync(join(agent, "package.json"), "utf8")).version;
assert.match(version, /^\d+\.\d+\.\d+$/, "Select an installed Pi package");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The official SDK declares its message types through a peer. Without that
// peer, skipLibCheck can conceal missing declarations and leak `any` into the
// provider. Require its real installed graph, never a host-resolution shim.
const sdkRequire = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
try {
  require.resolve("@anthropic-ai/sdk/resources/beta/messages/messages.mjs");
  sdkRequire.resolve("zod/v4");
} catch (cause) {
  throw new Error(
    "Install pi-claude's declared SDK type peers before typechecking; no vendor or host type fallback is permitted",
    { cause },
  );
}
const configFile = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
if (configFile.error)
  throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
if (config.errors.length) throw new Error("Invalid pi-claude tsconfig.json");
const options = {
  ...config.options,
  types: ["node"],
  typeRoots: [dirname(dirname(agentRequire.resolve("@types/node/package.json")))],
};
const host = ts.createCompilerHost(options);
host.resolveModuleNames = (names, containingFile) =>
  names.map((name) => {
    if (
      name.startsWith("@earendil-works/pi-") ||
      name === "typebox" ||
      name.startsWith("typebox/")
    ) {
      const resolved = ts.resolveModuleName(
        name,
        join(agent, "dist/index.ts"),
        options,
        host,
      ).resolvedModule;
      if (!resolved) throw new Error(`Cannot resolve installed Pi host peer: ${name}`);
      return resolved;
    }
    if (name === "vitest" || name.startsWith("vitest/")) {
      const toolchain = resolve(process.env.PI_TEST_TOOLCHAIN ?? root);
      return ts.resolveModuleName(name, join(toolchain, "tests/index.ts"), options, host)
        .resolvedModule;
    }
    return ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
  });
const program = ts.createProgram(config.fileNames, options, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (name) => name,
      getNewLine: () => "\n",
    }),
  );
  process.exitCode = 1;
} else {
  console.log(`Owned provider typecheck passed against installed Pi ${version}`);
}
