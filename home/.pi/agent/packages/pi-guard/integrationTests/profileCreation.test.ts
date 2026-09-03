import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRawProfileConfig } from "../modules/profileConfig";
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
  it("creates and activates a profile with every rule section optional", async () => {
    const configPath = temporaryConfig();
    fs.writeFileSync(
      configPath,
      '// Keep user comments\n{\n  "profiles": {}\n}\n',
    );
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      confirm: true,
      inputResults: ["local-test-work", "Local test work", ""],
    });
    await harness.start();

    const run = harness.runCommand("profile-add");
    await choosePicker(harness, "builtin:default");
    await choosePicker(harness, "builtin:read-only");
    await choosePicker(harness, "Done");
    const overview = await harness.ui.waitForSelection();
    expect(overview.title).toContain("Create profile: local-test-work");
    expect(overview.title).toContain("Description: Local test work");
    expect(overview.title).toContain(
      "Extends (later wins ties): builtin:default, builtin:read-only",
    );
    expect(overview.title).toContain("Transform: none");
    expect(overview.title).toContain("Sandbox Bash: on · network denied");
    expect(overview.title).toContain("⚙️ Bash preview: none");
    expect(overview.title).toContain("📖 Read-path preview: none");
    expect(overview.title).toContain("✏️ Write-path preview: none");
    expect(overview.title).toContain("🛡️ Protected preview: none");
    expect(overview.title).toContain("Rules overview");
    expect(overview.options[0]).toBe("Create and activate profile");
    expect(overview.options).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Bash rules (0)"),
        expect.stringContaining("Read-path rules (0)"),
        expect.stringContaining("Write-path rules (0)"),
        expect.stringContaining("Protected safeguards (0)"),
      ]),
    );
    overview.choose("Create and activate profile");
    await run;

    expect(
      loadRawProfileConfig(configPath)?.profiles["local-test-work"],
    ).toMatchObject({
      description: "Local test work",
      extends: ["builtin:default", "builtin:read-only"],
      sandbox: { network: "deny" },
    });
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "// Keep user comments",
    );
    expect(harness.entries.at(-1)).toMatchObject({
      customType: "pi-guard-profile",
      data: { profile: "local-test-work" },
    });
  });

  it("authors all four optional rule layers through the shared section editor", async () => {
    const configPath = temporaryConfig();
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      confirm: false,
      inputResults: ["layered-work", "Every rule layer", "🧪"],
    });
    await harness.start();

    const run = harness.runCommand("profile-add");
    await choosePicker(harness, "builtin:default");
    await choosePicker(harness, "Done");

    (await harness.ui.waitForSelection()).choose("Transform (none) · Edit");
    const transformPicker = await harness.ui.waitForCustomModal();
    transformPicker.type("transform:deny-asks");
    transformPicker.press("Enter");

    (await harness.ui.waitForSelection()).choose("⚙️ Bash rules (0) · Edit");
    const bash = await harness.ui.waitForRuleForm();
    expect(bash.render().join("\n")).toContain("No rules in this section");
    bash.press("CtrlN");
    bash.type("echo created");
    bash.press("Tab"); // safe CREATE default deny → allow
    bash.press("Enter");

    (await harness.ui.waitForSelection()).choose(
      "📖 Read-path rules (0) · Edit",
    );
    const read = await harness.ui.waitForRuleForm();
    read.press("CtrlN");
    read.type("docs/**");
    read.press("CtrlX"); // scope the deny to direct read only
    read.press("Enter");

    (await harness.ui.waitForSelection()).choose(
      "✏️ Write-path rules (0) · Edit",
    );
    const write = await harness.ui.waitForRuleForm();
    write.press("CtrlN");
    write.type("generated/**");
    write.press("Tab");
    write.press("Enter");

    (await harness.ui.waitForSelection()).choose(
      "🛡️ Protected safeguards (0) · Edit",
    );
    const safeguard = await harness.ui.waitForRuleForm();
    expect(safeguard.render().join("\n")).toContain(
      "Protected denies block both reads and writes",
    );
    safeguard.press("CtrlN");
    safeguard.type("**/.env");
    safeguard.press("Enter");

    const overview = await harness.ui.waitForSelection();
    expect(overview.title).toContain("Create profile: layered-work");
    expect(overview.title).toContain("Description: Every rule layer");
    expect(overview.title).toContain(
      "Extends (later wins ties): builtin:default",
    );
    expect(overview.title).toContain("Transform: transform:deny-asks");
    expect(overview.title).toContain("Sandbox Bash: off");
    expect(overview.title).toContain("⚙️ Bash preview: echo created");
    expect(overview.title).toContain("📖 Read-path preview: docs/**");
    expect(overview.title).toContain("✏️ Write-path preview: generated/**");
    expect(overview.title).toContain("🛡️ Protected preview: **/.env");
    expect(overview.options).toEqual(
      expect.arrayContaining([
        "⚙️ Bash rules (1) · Edit",
        "📖 Read-path rules (1) · Edit",
        "✏️ Write-path rules (1) · Edit",
        "🛡️ Protected safeguards (1) · Edit",
      ]),
    );
    overview.choose("Create and activate profile");
    await run;

    expect(
      loadRawProfileConfig(configPath)?.profiles["layered-work"],
    ).toMatchObject({
      tools: { bash: [{ pattern: "echo created", decision: "allow" }] },
      readPaths: [{ pattern: "docs/**", decision: "deny", contexts: ["read"] }],
      writePaths: [{ pattern: "generated/**", decision: "allow" }],
      transforms: ["transform:deny-asks"],
      protectedPathRules: [{ pattern: "**/.env", decision: "deny" }],
    });

    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo created" },
    });
    expect(
      await harness.callTool({
        toolName: "read",
        input: { path: "docs/a.md" },
      }),
    ).toMatchObject({ block: true });
    await harness.callToolWithoutPrompt({
      toolName: "grep",
      input: { path: "docs/a.md", pattern: "needle" },
    });
    await harness.callToolWithoutPrompt({
      toolName: "write",
      input: { path: "generated/a.ts", content: "generated" },
    });
    expect(
      await harness.callTool({ toolName: "read", input: { path: ".env" } }),
    ).toMatchObject({ block: true });
  });

  it("retains a populated CREATE section on Back until creation", async () => {
    const configPath = temporaryConfig();
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      confirm: true,
      inputResults: ["back-work", "Back retention", ""],
    });
    await harness.start();

    const run = harness.runCommand("profile-add");
    await choosePicker(harness, "builtin:default");
    await choosePicker(harness, "Done");
    (await harness.ui.waitForSelection()).choose("⚙️ Bash rules (0) · Edit");
    const editor = await harness.ui.waitForRuleForm();
    editor.press("CtrlN");
    editor.type("echo retained");
    editor.press("Escape");

    const overview = await harness.ui.waitForSelection();
    expect(overview.options).toContain("⚙️ Bash rules (1) · Edit");
    overview.choose("⚙️ Bash rules (1) · Edit");
    const reopened = await harness.ui.waitForRuleForm();
    expect(reopened.render().join("\n")).toContain("cho retained");
    reopened.press("Escape");
    (await harness.ui.waitForSelection()).choose("Create and activate profile");
    await run;
    expect(
      loadRawProfileConfig(configPath)?.profiles["back-work"],
    ).toMatchObject({
      tools: { bash: [{ pattern: "echo retained", decision: "deny" }] },
    });
  });

  it("rejects overlapping CREATE rows before writing and retains the overview", async () => {
    const configPath = temporaryConfig();
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      confirm: false,
      inputResults: ["duplicate-work", "Duplicate validation", ""],
    });
    await harness.start();

    const run = harness.runCommand("profile-add");
    await choosePicker(harness, "builtin:default");
    await choosePicker(harness, "Done");
    (await harness.ui.waitForSelection()).choose("⚙️ Bash rules (0) · Edit");
    const editor = await harness.ui.waitForRuleForm();
    editor.press("CtrlN");
    editor.type("echo duplicate");
    editor.press("CtrlN");
    editor.type("echo duplicate");
    editor.press("Tab");
    editor.press("Enter");

    (await harness.ui.waitForSelection()).choose(
      "📖 Read-path rules (0) · Edit",
    );
    const readDraft = await harness.ui.waitForRuleForm();
    readDraft.press("CtrlN");
    readDraft.type("docs/retained/**");
    readDraft.press("Enter");

    (await harness.ui.waitForSelection()).choose("Create and activate profile");
    const retainedOverview = await harness.ui.waitForSelection();
    expect(retainedOverview.title).toContain("Create profile: duplicate-work");
    expect(retainedOverview.title).toContain(
      "Description: Duplicate validation",
    );
    expect(retainedOverview.title).toContain(
      "⚙️ Bash preview: echo duplicate, echo duplicate",
    );
    expect(retainedOverview.title).toContain(
      "📖 Read-path preview: docs/retained/**",
    );
    expect(retainedOverview.options).toContain("📖 Read-path rules (1) · Edit");
    expect(
      loadRawProfileConfig(configPath)?.profiles["duplicate-work"],
    ).toBeUndefined();
    expect(harness.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("overlapping rule changes"),
      "error",
    );
    retainedOverview.choose("⚙️ Bash rules (2) · Edit");
    const retainedEditor = await harness.ui.waitForRuleForm();
    retainedEditor.press("CtrlShiftR"); // explicit clear
    const finalOverview = await harness.ui.waitForSelection();
    expect(finalOverview.options).toContain("📖 Read-path rules (1) · Edit");
    finalOverview.choose("Create and activate profile");
    await run;
    expect(
      loadRawProfileConfig(configPath)?.profiles["duplicate-work"],
    ).toBeDefined();
  });

  it("saves an allowed ASK command in the prefilled custom child without a naming dialog", async () => {
    const configPath = temporaryConfig();
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo remembered-permission" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const editor = await harness.ui.waitForRuleForm();
    editor.press("Enter");
    await pending;

    expect(
      loadRawProfileConfig(configPath)?.profiles["default-custom"],
    ).toMatchObject({
      extends: ["builtin:default"],
      tools: {
        bash: [{ pattern: "echo remembered-permission", decision: "allow" }],
      },
    });
    expect(harness.entries.at(-1)).toMatchObject({
      customType: "pi-guard-profile",
      data: { profile: "default-custom" },
    });
    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo remembered-permission" },
    });
  });

  it("retains an edited child target after a collision and permits correction", async () => {
    const configPath = temporaryConfig();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        profiles: {
          "default-custom": {
            description: "Existing collision target",
            extends: ["builtin:default"],
          },
        },
      }),
    );
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo retain-target" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const first = await harness.ui.waitForRuleForm();
    for (let index = 0; index < 40; index++) first.press("ArrowRight");
    for (let index = 0; index < 40; index++) first.press("Backspace");
    first.type("default-custom"); // force a persistence collision
    expect(first.render().join("\n")).not.toContain("default-custom-2");
    first.press("Enter");

    const retry = await harness.ui.waitForRuleForm();
    expect(retry.render().join("\n")).toContain("default-custom");
    for (let index = 0; index < 40; index++) retry.press("ArrowRight");
    for (let index = 0; index < 40; index++) retry.press("Backspace");
    retry.type("recovered-custom");
    retry.press("Enter");
    await pending;

    expect(
      loadRawProfileConfig(configPath)?.profiles["recovered-custom"],
    ).toMatchObject({
      extends: ["builtin:default"],
      tools: {
        bash: [{ pattern: "echo retain-target", decision: "allow" }],
      },
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
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo never-again" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const editor = await harness.ui.waitForRuleForm();
    editor.press("Tab"); // allow → deny
    editor.press("ArrowDown");
    editor.type("Use the documented workflow instead.");
    editor.press("Enter");
    const result = await pending;

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
    await harness.callToolDecisivelyWithoutPrompt({
      toolName: "bash",
      input: { command: "echo never-again" },
    });
  });

  it("does not create a child when every authorable ASK row is skipped", async () => {
    const configPath = temporaryConfig();
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo hello > package.json" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const editor = await harness.ui.waitForRuleForm();
    editor.press("Tab"); // allow → deny
    editor.press("Tab"); // deny → skip
    expect(editor.render().join("\n")).toContain(
      "Save disabled: every row is skipped",
    );
    editor.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose("No (default)");
    const result = await pending;

    expect(result).toMatchObject({ block: true });
    // package.json is already allowed by the ordinary inherited path policy;
    // only the separately ASKed Bash rule is authorable in this request.
    expect(
      loadRawProfileConfig(configPath)?.profiles["path-only"],
    ).toBeUndefined();
  });

  it("saves a Bash-only ASK without inventing a protected safeguard", async () => {
    const configPath = temporaryConfig();
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo hello > package.json" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const editor = await harness.ui.waitForRuleForm();
    editor.press("Enter");
    const result = await pending;

    expect(result).toBeUndefined();
    expect(
      loadRawProfileConfig(configPath)?.profiles["default-custom"],
    ).toMatchObject({
      tools: {
        bash: [{ pattern: "echo hello > package.json", decision: "allow" }],
      },
    });
  });

  it("persists only non-skipped edited command choices from a multi-command ASK", async () => {
    const configPath = temporaryConfig();
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo first; echo second" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const editor = await harness.ui.waitForRuleForm();
    editor.press("Tab"); // first allow → deny
    editor.press("Tab"); // first deny → skip
    editor.press("ArrowDown");
    editor.press("Tab"); // second allow → deny
    editor.press("Enter");
    const result = await pending;

    expect(result).toMatchObject({ block: true });
    expect(
      loadRawProfileConfig(configPath)?.profiles["default-custom"],
    ).toMatchObject({
      tools: {
        bash: [{ pattern: "echo second", decision: "deny" }],
      },
    });
  });

  it("does not mutate a profile when every update choice is skipped", async () => {
    const configPath = temporaryConfig();
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo skipped" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const editor = await harness.ui.waitForRuleForm();
    editor.press("Tab"); // allow → deny
    editor.press("Tab"); // deny → skip
    expect(editor.render().join("\n")).toContain(
      "Save disabled: every row is skipped",
    );
    editor.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose("No (default)");
    const result = await pending;

    expect(result).toMatchObject({ block: true });
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  });

  it("discards an overview draft without changing bytes or the active profile", async () => {
    const configPath = temporaryConfig();
    fs.writeFileSync(
      configPath,
      `{
  "defaultProfile": "existing",
  "profiles": { "existing": { "description": "Existing profile" } }
}
`,
    );
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      confirm: true,
      inputResults: ["discarded", "Discarded draft", ""],
    });
    await harness.start();
    const entriesBefore = harness.entries.map((entry) => ({ ...entry }));

    const run = harness.runCommand("profile-add");
    await choosePicker(harness, "builtin:default");
    await choosePicker(harness, "Done");
    const overview = await harness.ui.waitForSelection();
    overview.cancel();
    await run;

    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(loadRawProfileConfig(configPath)?.defaultProfile).toBe("existing");
    expect(
      loadRawProfileConfig(configPath)?.profiles.discarded,
    ).toBeUndefined();
    expect(harness.entries).toEqual(entriesBefore);
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
