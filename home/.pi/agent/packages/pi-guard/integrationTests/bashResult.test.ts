import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createExtensionHarness } from "./support/extensionHarness";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-bash-result-"));
  const configPath = path.join(root, "profiles.jsonc");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      defaultProfile: "execution",
      profiles: {
        execution: {
          description: "Real Bash result compatibility",
          extends: ["builtin:default"],
          transforms: ["transform:allow-asks"],
          sandbox: false,
        },
      },
    }),
  );
  vi.stubEnv("PI_GUARD_PROFILE_CONFIG", configPath);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it.each([0, 7])(
  "preserves host structured results and exit status %s",
  async (exitCode) => {
    const harness = createExtensionHarness({ contextCwd: root, hasUI: false });
    await harness.start();
    const command = `printf result-output; exit ${exitCode}`;
    expect(
      (await harness.callTool({ toolName: "bash", input: { command } }))?.block,
    ).not.toBe(true);
    const result = await harness.executeTool({
      name: "bash",
      params: { command },
    });
    const schema = createBashToolDefinition(root).outputSchema;
    if (!schema) throw new Error("Host Bash output schema missing");
    expect(Value.Check(schema, result.structuredContent)).toBe(true);
    expect(result).toMatchObject({
      structuredContent: {
        output: "result-output",
        exit_code: exitCode,
        truncated: false,
      },
      details: { exitCode },
    });
    expect(result.isError ?? false).toBe(exitCode !== 0);
  },
);

it("forwards the tool context to Pi's Bash session environment", async () => {
  const harness = createExtensionHarness({ contextCwd: root, hasUI: false });
  await harness.start();
  const result = await harness.executeTool({
    name: "bash",
    params: { command: 'printf "%s" "$PI_SESSION_ID"' },
  });
  expect(result).toMatchObject({
    structuredContent: { output: "guard-harness-session", exit_code: 0 },
  });
});

it.each(["timeout", "abort"] as const)(
  "returns schema-compatible error data on %s",
  async (interruption) => {
    const harness = createExtensionHarness({ contextCwd: root, hasUI: false });
    await harness.start();
    const controller = new AbortController();
    const command = "sleep 10";
    const pending = harness.executeTool({
      name: "bash",
      params: { command, timeout: interruption === "timeout" ? 0.05 : 10 },
      options: { signal: controller.signal },
    });
    if (interruption === "abort") controller.abort();
    const result = await pending;
    const schema = createBashToolDefinition(root).outputSchema;
    if (!schema) throw new Error("Host Bash output schema missing");
    expect(Value.Check(schema, result.structuredContent)).toBe(true);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { exit_code: 124 },
      details: { exitCode: 124 },
    });
  },
);

it("returns schema-compatible unavailable data without running the command", async () => {
  const harness = createExtensionHarness({ contextCwd: root, hasUI: false });
  await harness.start();
  fs.writeFileSync(path.join(root, "profiles.jsonc"), "invalid configuration");
  const result = await harness.executeTool({
    name: "bash",
    params: { command: "touch should-not-exist" },
  });
  const schema = createBashToolDefinition(root).outputSchema;
  if (!schema) throw new Error("Host Bash output schema missing");
  expect(Value.Check(schema, result.structuredContent)).toBe(true);
  expect(result).toMatchObject({
    isError: true,
    structuredContent: { exit_code: 126 },
    details: { exitCode: 126 },
  });
  expect(fs.existsSync(path.join(root, "should-not-exist"))).toBe(false);
});
