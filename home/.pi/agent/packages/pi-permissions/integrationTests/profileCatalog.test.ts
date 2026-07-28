import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { policyConfig } from "../modules/policy";
import type { ProfilePolicy } from "../modules/policyHelpers";
import { createExtensionHarness } from "./support/extensionHarness";

const missingProfileConfigPath = path.resolve(
  "integrationTests/fixtures/does-not-exist.jsonc",
);

describe("shipped profile catalog", () => {
  beforeEach(() => {
    process.env.PI_PERMISSIONS_PROFILE_CONFIG = missingProfileConfigPath;
    delete process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;
  });

  afterEach(() => {
    delete process.env.PI_PERMISSIONS_PROFILE_CONFIG;
    delete process.env.PI_SUBAGENT_PROFILE;
  });

  async function harnessFor(
    profile: string,
  ): Promise<ReturnType<typeof createExtensionHarness>> {
    process.env.PI_SUBAGENT_PROFILE = profile;
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();
    return harness;
  }

  it.fails("builtin:committer allows git commit", async () => {
    const harness = await harnessFor("builtin:committer");
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "git commit -m test" },
      }),
    ).resolves.toBeUndefined();
  });

  it.fails("builtin:reviewer denies edit but allows npm test", async () => {
    const harness = await harnessFor("builtin:reviewer");

    const edit = await harness.callTool({
      toolName: "edit",
      input: { path: "src/example.ts", edits: [] },
    });
    expect(edit).toMatchObject({ block: true });

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "npm test" },
      }),
    ).resolves.toBeUndefined();
  });

  it.fails(
    "builtin:scribe-only denies writes outside docs but allows README.md",
    async () => {
      const harness = await harnessFor("builtin:scribe-only");

      const sourceWrite = await harness.callTool({
        toolName: "write",
        input: { path: "src/x.ts", content: "blocked" },
      });
      expect(sourceWrite).toMatchObject({ block: true });

      await expect(
        harness.callToolWithoutPrompt({
          toolName: "write",
          input: { path: "README.md", content: "allowed" },
        }),
      ).resolves.toBeUndefined();
    },
  );

  it.fails(
    "builtin:deps-mutator allows npm install but denies npm publish",
    async () => {
      const harness = await harnessFor("builtin:deps-mutator");

      await expect(
        harness.callToolWithoutPrompt({
          toolName: "bash",
          input: { command: "npm install lodash" },
        }),
      ).resolves.toBeUndefined();

      const publish = await harness.callTool({
        toolName: "bash",
        input: { command: "npm publish" },
      });
      expect(publish).toMatchObject({ block: true });
    },
  );

  it.fails("builtin:no-shell denies git status but allows edit", async () => {
    const harness = await harnessFor("builtin:no-shell");

    const bash = await harness.callTool({
      toolName: "bash",
      input: { command: "git status --short" },
    });
    expect(bash).toMatchObject({ block: true });

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "edit",
        input: { path: "src/example.ts", edits: [] },
      }),
    ).resolves.toBeUndefined();
  });

  it.fails(
    "builtin:implementation-only denies test writes but reads tests",
    async () => {
      const harness = await harnessFor("builtin:implementation-only");

      await expect(
        harness.callToolWithoutPrompt({
          toolName: "read",
          input: { path: "src/example.test.ts" },
        }),
      ).resolves.toBeUndefined();

      const testWrite = await harness.callTool({
        toolName: "write",
        input: { path: "src/example.test.ts", content: "blocked" },
      });
      expect(testWrite).toMatchObject({ block: true });
    },
  );

  it.fails("builtin:git-full allows git push", async () => {
    const harness = await harnessFor("builtin:git-full");
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "git push origin main" },
      }),
    ).resolves.toBeUndefined();
  });

  // Un-mark in Phase 3 (the rename lands there), not Phase 7 like the rest of this file.
  it.fails("tests-disallowed is renamed to builtin:tests-hidden", () => {
    const profiles = policyConfig.profiles as Record<string, ProfilePolicy>;
    expect(profiles["builtin:tests-hidden"]).toBeDefined();
    expect(profiles["builtin:tests-disallowed"]).toBeUndefined();
  });

  it.fails("builtin:tests-hidden hides test files", async () => {
    const harness = await harnessFor("builtin:tests-hidden");
    const result = await harness.callTool({
      toolName: "read",
      input: { path: "src/example.test.ts" },
    });
    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toMatch(/test files/i);
  });
});
