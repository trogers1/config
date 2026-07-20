import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createExtensionHarness,
  lastCallArgument,
} from "./support/extension-harness";

describe("permissions extension", () => {
  it("starts in the configured default profile and clears its status on shutdown", async () => {
    const harness = createExtensionHarness();

    await harness.start();

    expect(lastCallArgument(harness.ui.setStatus, 0)).toBe("permissions");
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("default");

    await harness.shutdown();
    expect(harness.ui.setStatus).toHaveBeenLastCalledWith(
      "permissions",
      undefined,
    );
  });

  it("shows, validates, autocompletes, and switches profiles through /profile", async () => {
    const harness = createExtensionHarness();

    await harness.runCommand("profile");
    expect(harness.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Active profile: default"),
      "info",
    );

    await harness.runCommand("profile", "missing");
    expect(harness.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Unknown profile 'missing'"),
      "error",
    );

    await harness.runCommand("profile", "socrates");
    expect(harness.entries.at(-1)).toMatchObject({
      customType: "pi-permissions-profile",
      data: { profile: "socrates" },
    });
    expect(
      harness
        .command("profile")
        .getArgumentCompletions?.("soc")
        ?.map((completion) => completion.value),
    ).toEqual(["socrates"]);
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("🧠");
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("socrates");
  });

  it("restores the persisted profile and applies its prompt and read-only policy", async () => {
    const firstSession = createExtensionHarness();
    await firstSession.runCommand("socrates");

    const resumedSession = createExtensionHarness({
      entries: firstSession.entries,
    });
    await resumedSession.start("resume");

    const prompt = await resumedSession.beforeAgent();
    expect(prompt?.systemPrompt).toContain("# Active profile: socrates");
    expect(prompt?.systemPrompt).toContain("Base system prompt");

    const write = await resumedSession.callTool({
      toolName: "write",
      input: { path: "notes.md", content: "not allowed" },
    });
    expect(write).toMatchObject({ block: true });
  });

  it("allows and denies real default-profile bash rules through tool_call", async () => {
    const harness = createExtensionHarness();

    await expect(
      harness.callTool({
        toolName: "bash",
        input: { command: "git status --short" },
      }),
    ).resolves.toBeUndefined();

    const denied = await harness.callTool({
      toolName: "bash",
      input: { command: "git checkout main" },
    });
    expect(denied).toMatchObject({ block: true });
    expect(denied?.reason).toContain("Command denied by explicit rule");
  });

  it("applies profile-specific production overrides", async () => {
    const harness = createExtensionHarness();

    const defaultCommit = await harness.callTool({
      toolName: "bash",
      input: { command: "git commit -m test" },
    });
    expect(defaultCommit).toMatchObject({ block: true });

    await harness.runCommand("profile", "address-comments");
    await expect(
      harness.callTool({
        toolName: "bash",
        input: { command: "git commit -m test" },
      }),
    ).resolves.toBeUndefined();

    await harness.runCommand("profile", "performance-review");
    await expect(
      harness.callTool({
        toolName: "bash",
        input: { command: "glab mr view 123" },
      }),
    ).resolves.toBeUndefined();
  });

  it("provides a read-only profile for non-destructive git history inspection", async () => {
    const harness = createExtensionHarness();

    await harness.runCommand("read-only");
    expect(harness.entries.at(-1)).toMatchObject({
      customType: "pi-permissions-profile",
      data: { profile: "read-only" },
    });
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("🔎");
    expect(lastCallArgument(harness.ui.setStatus, 1)).toContain("read-only");

    await expect(
      harness.callTool({
        toolName: "bash",
        input: { command: "git log --all --graph --oneline" },
      }),
    ).resolves.toBeUndefined();

    await expect(
      harness.callTool({
        toolName: "bash",
        input: { command: "git show HEAD~3:src/example.ts" },
      }),
    ).resolves.toBeUndefined();

    for (const command of [
      "git pull",
      "git checkout main",
      "git bisect start",
      "git log --oneline > history.txt",
    ]) {
      const denied = await harness.callTool({
        toolName: "bash",
        input: { command },
      });
      expect(denied).toMatchObject({ block: true });
    }

    for (const toolName of ["edit", "write"]) {
      const denied = await harness.callTool({
        toolName,
        input: { path: "notes.md", content: "not allowed" },
      });
      expect(denied).toMatchObject({ block: true });
    }
  });

  it("asks for unspecified commands and fails closed without a UI", async () => {
    const interactive = createExtensionHarness({ confirm: true });
    await expect(
      interactive.callTool({
        toolName: "bash",
        input: { command: "python scripts/build.py" },
      }),
    ).resolves.toBeUndefined();
    expect(interactive.ui.confirm).toHaveBeenCalledOnce();

    const nonInteractive = createExtensionHarness({ hasUI: false });
    const blocked = await nonInteractive.callTool({
      toolName: "bash",
      input: { command: "python scripts/build.py" },
    });
    expect(blocked).toMatchObject({ block: true });
    expect(nonInteractive.ui.confirm).not.toHaveBeenCalled();
  });

  it("gates outside paths and denies protected paths through path tools", async () => {
    const harness = createExtensionHarness({ confirm: false });

    const outside = await harness.callTool({
      toolName: "read",
      input: { path: path.resolve(process.cwd(), "../outside.txt") },
    });
    expect(outside).toMatchObject({ block: true });
    expect(harness.ui.confirm).toHaveBeenCalledOnce();

    harness.ui.confirm.mockClear();
    const protectedPath = await harness.callTool({
      toolName: "read",
      input: { path: ".env" },
    });
    expect(protectedPath).toMatchObject({ block: true });
    expect(protectedPath?.reason).toContain("denied by policy");
    expect(harness.ui.confirm).not.toHaveBeenCalled();
  });

  it("returns configured steering from production deny rules", async () => {
    const harness = createExtensionHarness();

    const denied = await harness.callTool({
      toolName: "bash",
      input: { command: "npx vitest src/example.test.ts" },
    });

    expect(denied?.reason).toContain("Policy guidance:");
    expect(denied?.reason).toContain("npm test -- <requested test filters>");
  });
});
