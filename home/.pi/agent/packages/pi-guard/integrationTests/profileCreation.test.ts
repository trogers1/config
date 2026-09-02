import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideBash } from "../extensions/guard";
import {
  loadRawProfileConfig,
  loadProfileConfig,
} from "../modules/profileConfig";
import { policyConfig } from "../modules/policy";
import { createExtensionHarness } from "./support/extensionHarness";

const originalConfigPath = process.env.PI_GUARD_PROFILE_CONFIG;
const files: string[] = [];

afterEach(() => {
  if (originalConfigPath === undefined) {
    delete process.env.PI_GUARD_PROFILE_CONFIG;
  } else {
    process.env.PI_GUARD_PROFILE_CONFIG = originalConfigPath;
  }
  for (const file of files.splice(0)) fs.rmSync(file, { force: true });
});

async function choosePicker(
  harness: ReturnType<typeof createExtensionHarness>,
  value: string,
): Promise<void> {
  const picker = await harness.ui.waitForCustomModal();
  picker.type(value);
  picker.press("Enter");
}

function temporaryConfig(): string {
  const file = path.join(
    tmpdir(),
    `pi-guard-profile-add-${crypto.randomUUID()}.jsonc`,
  );
  files.push(file);
  fs.writeFileSync(file, '// Keep user comments\n{\n  "profiles": {}\n}\n');
  return file;
}

describe("/profile-add", () => {
  it("preserves wizard flow and final-selection stacking through creation, persistence, and activation", async () => {
    const configPath = temporaryConfig();
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      confirm: true,
      // A blank optional emoji uses the custom profile default.
      inputResults: ["local-test-work", "Local test work", ""],
    });
    await harness.start();

    const run = harness.runCommand("profile-add");
    // Drive the real fuzzy pickers rather than injecting their final values.
    await choosePicker(harness, "ruleset:deps-mutations-allow");
    await choosePicker(harness, "ruleset:deps-mutations-guard");
    await choosePicker(harness, "builtin:default");
    await choosePicker(harness, "Done");
    await choosePicker(harness, "transform:deny-asks");

    const bashEditor = await harness.ui.waitForRuleForm();
    bashEditor.type("echo profile-created-command");
    bashEditor.press("ArrowDown");
    expect(bashEditor.render().join("\\n")).toContain("Add steering…");
    bashEditor.type("Use the approved workflow.");
    bashEditor.press("Enter");
    const firstProtected = await harness.ui.waitForRuleForm();
    firstProtected.type(".env");
    firstProtected.press("Enter");
    const addProtected = await harness.ui.waitForSelection();
    addProtected.choose("Add another protected path");
    const secondProtected = await harness.ui.waitForRuleForm();
    secondProtected.type("**/credentials/**");
    secondProtected.press("Tab");
    secondProtected.press("Enter");
    const continueProtected = await harness.ui.waitForSelection();
    continueProtected.choose("Continue");
    await run;

    const raw = loadRawProfileConfig(configPath);
    expect(raw?.profiles["local-test-work"]).toMatchObject({
      description: "Local test work",
      emoji: "💅",
      color: "magenta",
      // The persisted order is the wizard selection order; later entries win
      // equal-specificity composition ties.
      extends: [
        "ruleset:deps-mutations-allow",
        "ruleset:deps-mutations-guard",
        "builtin:default",
      ],
      transforms: ["transform:deny-asks"],
      tools: {
        bash: [
          {
            pattern: "echo profile-created-command",
            decision: "deny",
            guidance: "Use the approved workflow.",
          },
        ],
      },
      sandbox: { network: "deny" },
      protectedPathRules: [
        { pattern: ".env", decision: "deny" },
        { pattern: "**/credentials/**", decision: "allow" },
      ],
    });
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "// Keep user comments",
    );

    const resolved = loadProfileConfig(policyConfig, configPath);
    expect(
      decideBash("npm install example", resolved.profiles["local-test-work"]),
    ).toBe("deny");
    const compositionPreview = harness.customComponents[3]
      ?.render(80)
      .join("\n");
    expect(compositionPreview).toMatch(/1\. .*builtin:default/);
    expect(compositionPreview).toMatch(/2\. .*ruleset:deps-mutations-guard/);
    expect(compositionPreview).toContain(
      "Default general-purpose main session",
    );
    // The rendered stack, persisted extends order, and effective rule winner
    // above are deliberately all checked: reversing one cannot silently drift
    // from the UI contract.
    expect(compositionPreview.indexOf("builtin:default")).toBeLessThan(
      compositionPreview.indexOf("ruleset:deps-mutations-guard"),
    );
    expect(
      compositionPreview.indexOf("ruleset:deps-mutations-guard"),
    ).toBeLessThan(compositionPreview.indexOf("ruleset:deps-mutations-allow"));
    const transformPicker = harness.customComponents[4]?.render(80).join("\n");
    expect(transformPicker).toContain("Turn every ask decision into deny.");
    const secondProtectedPathModal = harness.customComponents[6]
      ?.render(80)
      .join("\n");
    expect(secondProtectedPathModal).toContain("Rules added so far:");
    expect(secondProtectedPathModal).toContain("1. ✅ **/credentials/**");
    expect(secondProtectedPathModal).toContain("2. ⛔️ .env");
    const protectedRuleLines = secondProtectedPathModal.split("\n");
    expect(
      protectedRuleLines.findIndex((line) =>
        line.includes("1. ✅ **/credentials/**"),
      ),
    ).toBeLessThan(
      protectedRuleLines.findIndex((line) => line.includes("2. ⛔️ .env")),
    );

    expect(harness.entries.at(-1)).toMatchObject({
      customType: "pi-guard-profile",
      data: { profile: "local-test-work" },
    });
    expect(harness.ui.notify).toHaveBeenLastCalledWith(
      "Created and activated profile: local-test-work",
      "info",
    );
  });

  it("remembers an allowed ASK command in a new custom child of the active built-in profile", async () => {
    const configPath = temporaryConfig();
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      confirm: true,
      selectResults: ["Update profile with choice", "⚙️ Bash patterns"],
      customResults: [
        [{ decision: "allow", pattern: "echo remembered-permission" }],
      ],
      inputResults: ["remembered-default"],
    });
    await harness.start();

    await harness.callTool({
      toolName: "bash",
      input: { command: "echo remembered-permission" },
    });

    expect(
      loadRawProfileConfig(configPath)?.profiles["remembered-default"],
    ).toMatchObject({
      extends: ["builtin:default"],
      tools: {
        bash: [{ pattern: "echo remembered-permission", decision: "allow" }],
      },
    });
    expect(harness.entries.at(-1)).toMatchObject({
      customType: "pi-guard-profile",
      data: { profile: "remembered-default" },
    });
    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo remembered-permission" },
    });
  });

  it("remembers a denied ASK command and optional steering in the active custom profile", async () => {
    const configPath = temporaryConfig();
    fs.writeFileSync(
      configPath,
      `{
  "defaultProfile": "my-profile",
  "profiles": {
    "my-profile": {
      "description": "A mutable profile",
      "extends": ["builtin:default"]
    }
  }
}
`,
    );
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      confirm: false,
      editorResult: "Use the documented workflow instead.",
      selectResults: ["Update profile with choice", "⚙️ Bash patterns"],
      customResults: [[{ decision: "deny", pattern: "echo never-again" }]],
    });
    await harness.start();

    const result = await harness.callTool({
      toolName: "bash",
      input: { command: "echo never-again" },
    });

    expect(result).toMatchObject({ block: true });
    expect(
      loadRawProfileConfig(configPath)?.profiles["my-profile"],
    ).toMatchObject({
      tools: {
        bash: [
          {
            pattern: "echo never-again",
            decision: "deny",
          },
        ],
      },
    });
    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo never-again" },
    });
  });

  it("saves a prefilled protected-path rule without allowing a separately ASKed Bash command", async () => {
    const configPath = temporaryConfig();
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      selectResults: ["Update profile with choice"],
      customResults: [
        [{ decision: "skip", pattern: "echo hello > package.json" }],
        { pattern: "package.json", decision: "allow" },
      ],
      inputResults: ["path-only"],
    });
    await harness.start();

    const result = await harness.callTool({
      toolName: "bash",
      input: { command: "echo hello > package.json" },
    });

    expect(result).toMatchObject({ block: true });
    expect(
      loadRawProfileConfig(configPath)?.profiles["path-only"],
    ).toMatchObject({
      extends: ["builtin:default"],
      protectedPathRules: [{ pattern: "package.json", decision: "allow" }],
    });
  });

  it("steps through command and protected-path editors when saving both rule types", async () => {
    const configPath = temporaryConfig();
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      selectResults: ["Update profile with choice"],
      customResults: [
        [{ decision: "allow", pattern: "echo hello > package.json" }],
        { pattern: "package.json", decision: "allow" },
      ],
      inputResults: ["command-and-path"],
    });
    await harness.start();

    const result = await harness.callTool({
      toolName: "bash",
      input: { command: "echo hello > package.json" },
    });

    expect(result).toBeUndefined();
    expect(
      loadRawProfileConfig(configPath)?.profiles["command-and-path"],
    ).toMatchObject({
      tools: {
        bash: [{ pattern: "echo hello > package.json", decision: "allow" }],
      },
      protectedPathRules: [{ pattern: "package.json", decision: "allow" }],
    });
  });

  it("persists only non-skipped edited command choices from a multi-command ASK", async () => {
    const configPath = temporaryConfig();
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      selectResults: ["Update profile with choice", "⚙️ Bash patterns"],
      customResults: [
        [
          { decision: "skip", pattern: "echo first" },
          { decision: "deny", pattern: "echo edited-second" },
        ],
      ],
      inputResults: ["mixed-choices"],
    });
    await harness.start();

    const result = await harness.callTool({
      toolName: "bash",
      input: { command: "echo first; echo second" },
    });

    expect(result).toMatchObject({ block: true });
    expect(
      loadRawProfileConfig(configPath)?.profiles["mixed-choices"],
    ).toMatchObject({
      tools: {
        bash: [{ pattern: "echo edited-second", decision: "deny" }],
      },
    });
  });

  it("does not mutate a profile when every update choice is skipped", async () => {
    const configPath = temporaryConfig();
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      selectResults: ["Update profile with choice", "⚙️ Bash patterns"],
      customResults: [[{ decision: "skip", pattern: "echo skipped" }]],
    });
    await harness.start();

    const result = await harness.callTool({
      toolName: "bash",
      input: { command: "echo skipped" },
    });

    expect(result).toMatchObject({ block: true });
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  });

  it("does not modify configuration when composition is cancelled", async () => {
    const configPath = temporaryConfig();
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const run = harness.runCommand("profile-add");
    const composition = await harness.ui.waitForCustomModal();
    composition.press("Escape");
    await run;

    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(harness.ui.notify).toHaveBeenLastCalledWith(
      "Profile creation cancelled: choose at least one base.",
      "warning",
    );
  });
});
