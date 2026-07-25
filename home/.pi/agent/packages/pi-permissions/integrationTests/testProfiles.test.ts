import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExtensionHarness } from "./support/extensionHarness";

const missingProfileConfigPath = path.resolve(
  "integrationTests/fixtures/does-not-exist.jsonc",
);

describe("built-in test profiles", () => {
  beforeEach(() => {
    vi.stubEnv("PI_PERMISSIONS_PROFILE_CONFIG", missingProfileConfigPath);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps tests inaccessible in tests-disallowed while allowing implementation edits", async () => {
    vi.stubEnv("PI_SUBAGENT_PROFILE", "tests-disallowed");
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
      expect(denied?.reason).toContain(
        "protected from disclosure and mutation",
      );
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
    vi.stubEnv("PI_SUBAGENT_PROFILE", "tests-only");
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
  });
});
