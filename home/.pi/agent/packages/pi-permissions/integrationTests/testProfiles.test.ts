import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionHarness } from "./support/extensionHarness";

const missingProfileConfigPath = path.resolve(
  "integrationTests/fixtures/does-not-exist.jsonc",
);

describe("built-in test profiles", () => {
  beforeEach(() => {
    vi.stubEnv("PI_PERMISSIONS_PROFILE_CONFIG", missingProfileConfigPath);
    delete process.env.PI_SUBAGENT_PROFILE;
    delete process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps tests inaccessible in tests-hidden while allowing implementation edits", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "builtin:tests-hidden");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    for (const event of [
      { toolName: "read", input: { path: "src/example.test.ts" } },
      { toolName: "read", input: { path: "tests/example.ts" } },
      {
        toolName: "edit",
        input: { path: "src/example.spec.ts", edits: [] },
      },
      {
        toolName: "write",
        input: { path: "integrationTests/example.ts", content: "" },
      },
    ]) {
      const denied = await harness.callTool(event);
      expect(denied, JSON.stringify(event)).toMatchObject({ block: true });
      expect(denied?.reason).toContain("Do not inspect test files");
    }

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "edit",
        input: { path: "src/example.ts", edits: [] },
      }),
    ).resolves.toBeUndefined();

    const prompt = await harness.beforeAgent();
    expect(prompt?.systemPrompt).toContain("You are implementing only");
    expect(prompt?.systemPrompt).toContain(
      "list of every test you believe is bad",
    );
  });

  it("allows tests-only to read implementation files but only edit tests", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "builtin:tests-only");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "read",
        input: { path: "src/example.ts" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "write",
        input: { path: "tests/example.ts", content: "" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "edit",
        input: { path: "src/example.test.ts", edits: [] },
      }),
    ).resolves.toBeUndefined();

    const implementationEdit = await harness.callTool({
      toolName: "edit",
      input: { path: "src/example.ts", edits: [] },
    });
    expect(implementationEdit).toMatchObject({ block: true });
    expect(implementationEdit?.reason).toContain("only edit test files");

    const prompt = await harness.beforeAgent();
    expect(prompt?.systemPrompt).toContain("You are writing tests only");
    expect(prompt?.systemPrompt).toContain("Only create or modify test files");
    expect(prompt?.systemPrompt).toContain("Tooling constraints");
    expect(prompt?.systemPrompt).toContain("read`, `grep`, `find`, and `ls`");
  });

  it("steers tests-only bash inspection denials toward the dedicated read tools", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "builtin:tests-only");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    const inspection = await harness.callTool({
      toolName: "bash",
      input: { command: "cat src/example.ts" },
    });
    expect(inspection).toMatchObject({ block: true });
    expect(inspection?.reason).toContain("gated as writes");
    expect(inspection?.reason).toContain("read, grep, find, and ls tools");
    expect(inspection?.reason).toContain("read tool");

    // The edit/write denial keeps its own guidance rather than the bash text.
    const implementationEdit = await harness.callTool({
      toolName: "edit",
      input: { path: "src/example.ts", edits: [] },
    });
    expect(implementationEdit).toMatchObject({ block: true });
    expect(implementationEdit?.reason).toContain("only edit test files");
    expect(implementationEdit?.reason).not.toContain("gated as writes");
  });

  it("lets tests-only bash target test files and /tmp but not implementation files", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "builtin:tests-only");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "npm test > tests/output.txt" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "npm test > /tmp/scratch.txt" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      harness.callToolWithoutPrompt({
        toolName: "write",
        input: { path: "/tmp/scratch.md", content: "" },
      }),
    ).resolves.toBeUndefined();

    const implementationRedirect = await harness.callTool({
      toolName: "bash",
      input: { command: "npm test > src/example.ts" },
    });
    expect(implementationRedirect).toMatchObject({ block: true });
  });

  it("lets tests-only cd into implementation directories to run package scripts", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "builtin:tests-only");
    const harness = createExtensionHarness({ hasUI: false });
    await harness.start();

    await expect(
      harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command: "cd src && npm run check:types" },
      }),
    ).resolves.toBeUndefined();
  });
});
