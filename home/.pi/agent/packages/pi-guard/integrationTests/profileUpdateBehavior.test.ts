import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtensionHarness } from "./support/extensionHarness";

const originalConfigPath = process.env.PI_GUARD_PROFILE_CONFIG;
const temporaryDirectories: string[] = [];

function writeConfig(config: object): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-guard-profile-update-"),
  );
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "profiles.jsonc");
  fs.writeFileSync(
    configPath,
    `// Behavioral profile-update fixture\n${JSON.stringify(config, null, 2)}\n`,
  );
  return configPath;
}

function restoreEnvironment(): void {
  if (originalConfigPath === undefined)
    delete process.env.PI_GUARD_PROFILE_CONFIG;
  else process.env.PI_GUARD_PROFILE_CONFIG = originalConfigPath;
}

afterEach(() => {
  restoreEnvironment();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("profile updates through the public extension surface", () => {
  it("persists Bash deny guidance and allow decisions, including exact repeats", async () => {
    const configPath = writeConfig({
      defaultProfile: "custom-work",
      profiles: {
        "custom-work": {
          description: "Custom profile whose Bash decisions can be updated.",
          extends: ["builtin:default"],
          tools: {
            bash: [
              { pattern: "echo remember-deny", decision: "ask" },
              { pattern: "echo remember-allow", decision: "ask" },
            ],
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    await harness.runCommand("profile", "custom-work");

    const deniedPending = harness.callTool({
      toolName: "bash",
      input: { command: "echo remember-deny" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Update profile with choice",
    );
    const deniedForm = await harness.ui.waitForRuleForm();
    deniedForm.press("Tab");
    deniedForm.press("ArrowDown");
    deniedForm.type("Use the documented workflow instead.");
    deniedForm.press("Enter");
    const denied = await deniedPending;
    expect(denied).toMatchObject({ block: true });
    expect(denied?.reason).toContain("Use the documented workflow instead.");

    const repeatedDeny = await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo remember-deny" },
    });
    expect(repeatedDeny).toMatchObject({ block: true });
    expect(repeatedDeny?.reason).toContain(
      "Use the documented workflow instead.",
    );

    const allowedPending = harness.callTool({
      toolName: "bash",
      input: { command: "echo remember-allow" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Update profile with choice",
    );
    const allowedForm = await harness.ui.waitForRuleForm();
    allowedForm.press("Tab");
    allowedForm.press("Tab");
    allowedForm.press("Enter");
    await allowedPending;
    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo remember-allow" },
    });
  });

  it("returns an ASK row to skip after three Tab presses without adding a rule", async () => {
    const configPath = writeConfig({
      defaultProfile: "three-tabs-work",
      profiles: {
        "three-tabs-work": {
          description: "Profile for checking the ASK decision cycle.",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: "echo cycle-me", decision: "ask" }] },
        },
      },
    });
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    await harness.runCommand("profile", "three-tabs-work");

    const request = harness.callTool({
      toolName: "bash",
      input: { command: "echo cycle-me" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Update profile with choice",
    );
    const form = await harness.ui.waitForRuleForm();
    form.press("Tab"); // ⏭️ → ⛔️
    form.press("Tab"); // ⛔️ → ✅
    form.press("Tab"); // ✅ → ⏭️
    form.press("Enter");

    expect(await request).toMatchObject({ block: true });
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  });

  it("resets an interactive profile update before saving", async () => {
    const configPath = writeConfig({
      defaultProfile: "reset-work",
      profiles: {
        "reset-work": {
          description: "Profile for exercising the interactive reset flow.",
          extends: ["builtin:default"],
          tools: {
            bash: [{ pattern: "echo reset-me", decision: "ask" }],
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    await harness.runCommand("profile", "reset-work");

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo reset-me" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Update profile with choice",
    );
    const form = await harness.ui.waitForRuleForm();
    form.type(" changed");
    form.press("Tab");
    form.press("ArrowDown");
    form.type("Do not save this guidance.");
    form.press("CtrlShiftR");
    form.press("Enter");

    const resetResult = await pending;
    expect(resetResult).toMatchObject({ block: true });

    // Reset skips every row, so the next public tool event must still prompt.
    const nextPending = harness.callTool({
      toolName: "bash",
      input: { command: "echo reset-me" },
    });
    (await harness.ui.waitForPermissionChoice()).choose("Yes");
    const nextResult = await nextPending;
    expect(nextResult?.block ?? false).toBe(false);
  });

  it("persists protected write-path deny and allow decisions through ASK flows", async () => {
    const configPath = writeConfig({
      defaultProfile: "path-work",
      profiles: {
        "path-work": {
          description: "Custom profile whose protected paths can be updated.",
          extends: ["builtin:default"],
          writePaths: [
            { pattern: "remember-deny.txt", decision: "ask" },
            { pattern: "remember-allow.txt", decision: "ask" },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    await harness.runCommand("profile", "path-work");

    const deniedPending = harness.callTool({
      toolName: "write",
      input: { path: "remember-deny.txt", content: "no" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Update profile with choice",
    );
    const deniedForm = await harness.ui.waitForRuleForm();
    deniedForm.press("Tab");
    deniedForm.press("Enter");
    const denied = await deniedPending;
    expect(denied).toMatchObject({ block: true });
    const repeatedDeny = await harness.callToolWithoutPrompt({
      toolName: "write",
      input: { path: "remember-deny.txt", content: "no" },
    });
    expect(repeatedDeny).toMatchObject({ block: true });

    const allowedPending = harness.callTool({
      toolName: "write",
      input: { path: "remember-allow.txt", content: "yes" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Update profile with choice",
    );
    const allowedForm = await harness.ui.waitForRuleForm();
    allowedForm.press("Enter");
    await allowedPending;
    await harness.callToolWithoutPrompt({
      toolName: "write",
      input: { path: "remember-allow.txt", content: "yes" },
    });
  });

  it("updates both command and path rules, then stops enforcing them after /profile switches", async () => {
    const bothPath = path.join(process.cwd(), "both.txt");
    const configPath = writeConfig({
      defaultProfile: "both-work",
      profiles: {
        "both-work": {
          description: "Profile for exercising the combined ASK update flow.",
          extends: ["builtin:default"],
          tools: {
            bash: [{ pattern: "echo both > both.txt", decision: "ask" }],
          },
          readPaths: [{ pattern: bothPath, decision: "allow" }],
          writePaths: [{ pattern: bothPath, decision: "ask" }],
        },
        "unrestricted-work": {
          description: "Distinct profile without the remembered restrictions.",
          extends: ["builtin:default"],
          tools: {
            bash: [{ pattern: "echo both > both.txt", decision: "allow" }],
          },
          writePaths: [{ pattern: bothPath, decision: "allow" }],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const deniedPending = harness.callTool({
      toolName: "bash",
      input: { command: "echo both > both.txt" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Update profile with choice",
    );
    const commandForm = await harness.ui.waitForRuleForm();
    commandForm.press("Tab");
    commandForm.press("ArrowDown");
    commandForm.type("Use the approved project workflow.");
    commandForm.press("Enter");
    const pathForm = await harness.ui.waitForRuleForm();
    pathForm.press("Enter");
    const denied = await deniedPending;
    expect(denied).toMatchObject({ block: true });
    expect(denied?.reason).toContain("Use the approved project workflow.");

    const repeated = await harness.callTool({
      toolName: "bash",
      input: { command: "echo both > both.txt" },
    });
    expect(repeated).toMatchObject({ block: true });
    expect(repeated?.reason).toContain("Use the approved project workflow.");

    await harness.callToolWithoutPrompt({
      toolName: "read",
      input: { path: "both.txt" },
    });

    await harness.runCommand("profile", "unrestricted-work");
    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo both > both.txt" },
    });
    await harness.callToolWithoutPrompt({
      toolName: "write",
      input: { path: "both.txt", content: "now allowed" },
    });
  });
});
