import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultCustomProfileEmoji,
  suggestedProfileName,
} from "../modules/profileAuthoringModel";
import { loadRawProfileConfig } from "../modules/profileConfig";
import {
  compositionSectionLabel,
  localProfileDeclarationCount,
  metadataConfirmationTitle,
  metadataSectionPresentation,
  profileAuthoringAction,
  profileAuthoringInvalidMarker,
  profileAuthoringSectionOption,
  profileDraftDiscardTitle,
  profileSettingsHeading,
  renderPurposePresentation,
  ruleSectionOption,
  ruleSectionPresentation,
  transformsSectionLabel,
} from "../modules/profileAuthoringPresentation";
import type {
  ProfileAuthoringOverviewSectionId,
  ProfileAuthoringOverviewSelection,
} from "../modules/profileAuthoringOverview";
import { createExtensionHarness } from "./support/extensionHarness";

const submitOverviewSelection = {
  kind: "action",
  id: "submit",
} as const satisfies ProfileAuthoringOverviewSelection;
function overviewSectionSelection({
  id,
}: {
  readonly id: ProfileAuthoringOverviewSectionId;
}): ProfileAuthoringOverviewSelection {
  return { kind: "section", id };
}
async function chooseOverview({
  harness,
  selection,
}: {
  readonly harness: ReturnType<typeof createExtensionHarness>;
  readonly selection: ProfileAuthoringOverviewSelection;
}): Promise<void> {
  (await harness.ui.waitForProfileAuthoringOverview()).choose({ selection });
}

const originalConfigPath = process.env.PI_GUARD_PROFILE_CONFIG;
const originalActiveProfile = process.env.PI_GUARD_ACTIVE_PROFILE;
const files: string[] = [];

afterEach(() => {
  if (originalConfigPath === undefined) {
    delete process.env.PI_GUARD_PROFILE_CONFIG;
  } else {
    process.env.PI_GUARD_PROFILE_CONFIG = originalConfigPath;
  }
  if (originalActiveProfile === undefined) {
    delete process.env.PI_GUARD_ACTIVE_PROFILE;
  } else {
    process.env.PI_GUARD_ACTIVE_PROFILE = originalActiveProfile;
  }
  for (const file of files.splice(0)) fs.rmSync(file, { force: true });
});

async function completeGeneral({
  harness,
  name,
  description,
  emoji,
}: {
  readonly harness: ReturnType<typeof createExtensionHarness>;
  readonly name: string;
  readonly description: string;
  readonly emoji?: string;
}): Promise<void> {
  const general = await harness.ui.waitForProfileGeneralForm();
  general.press("CtrlU");
  general.type(name);
  general.press("ArrowDown");
  general.press("CtrlU");
  general.type(description);
  if (emoji !== undefined) {
    general.press("ArrowDown");
    general.press("CtrlU");
    general.type(emoji);
  }
  general.press("Enter");
}

async function choosePicker(
  harness: ReturnType<typeof createExtensionHarness>,
  value: string,
): Promise<void> {
  const picker = await harness.ui.waitForCustomModal();
  picker.type(value);
  picker.press("Enter");
}

async function editGeneralFromOverview({
  harness,
  name,
  description,
  emoji,
}: {
  readonly harness: ReturnType<typeof createExtensionHarness>;
  readonly name: string;
  readonly description: string;
  readonly emoji?: string;
}): Promise<void> {
  await chooseOverview({
    harness,
    selection: overviewSectionSelection({ id: "general" }),
  });
  await completeGeneral({ harness, name, description, emoji });
}

async function addOrderedEntry({
  harness,
  section,
  value,
}: {
  readonly harness: ReturnType<typeof createExtensionHarness>;
  readonly section: "composition" | "transforms";
  readonly value: string;
}): Promise<void> {
  await chooseOverview({
    harness,
    selection: overviewSectionSelection({ id: section }),
  });
  const editor = await harness.ui.waitForCustomModal();
  editor.press("CtrlN");
  await choosePicker(harness, value);
  const resumed = await harness.ui.waitForCustomModal();
  resumed.press("Enter");
}

function expectedInlineChildName({
  existingNames = new Set<string>(),
}: {
  readonly existingNames?: ReadonlySet<string>;
} = {}): string {
  return suggestedProfileName({
    profile: "builtin:default",
    cwd: process.cwd(),
    existingNames,
  });
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
    });
    await harness.start();

    const run = harness.runCommand("profile-add");
    await addOrderedEntry({
      harness,
      section: "composition",
      value: "builtin:read-only",
    });
    await editGeneralFromOverview({
      harness,
      name: "local-test-work",
      description: "Local test work",
    });
    const overview = await harness.ui.waitForProfileAuthoringOverview();
    const renderedOverview = overview.render().join("\n");
    expect(renderedOverview).toContain("Create profile: 💅 local-test-work");
    expect(renderedOverview).toContain("Description: Local test work");
    expect(renderedOverview).toContain(
      profileAuthoringSectionOption({
        label: compositionSectionLabel,
        summary: "builtin:default, builtin:read-only",
      }),
    );
    expect(renderedOverview).toContain(
      profileAuthoringSectionOption({
        label: transformsSectionLabel,
        summary: "omitted",
      }),
    );
    expect(renderedOverview).toContain(
      profileAuthoringSectionOption({
        label: metadataSectionPresentation.sandbox.label,
        summary: "inherit",
      }),
    );
    expect(renderedOverview).toContain(
      profileAuthoringSectionOption({
        label: metadataSectionPresentation.directoryGlobs.label,
        summary: localProfileDeclarationCount({ count: 1 }),
      }),
    );
    for (const kind of ["bash", "read", "write", "protected"] as const)
      expect(renderedOverview).toContain(ruleSectionOption({ kind, count: 0 }));
    expect(renderedOverview).toContain(profileSettingsHeading);
    expect(renderedOverview).toContain(
      profileAuthoringAction({ action: "create" }),
    );
    overview.choose({ selection: submitOverviewSelection });
    await run;

    expect(
      loadRawProfileConfig(configPath)?.profiles["local-test-work"],
    ).toMatchObject({
      description: "Local test work",
      extends: ["builtin:default", "builtin:read-only"],
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
      confirm: true,
    });
    await harness.start();

    const run = harness.runCommand("profile-add");
    await editGeneralFromOverview({
      harness,
      name: "layered-work",
      description: "Every rule layer",
      emoji: "🧪",
    });

    await addOrderedEntry({
      harness,
      section: "transforms",
      value: "transform:deny-asks",
    });

    await chooseOverview({
      harness,
      selection: overviewSectionSelection({ id: "bash" }),
    });
    const bash = await harness.ui.waitForRuleForm();
    expect(bash.render().join("\n")).toContain("No rules in this section");
    bash.press("CtrlN");
    bash.type("echo created");
    bash.press("Tab"); // safe CREATE default deny → allow
    bash.press("Enter");

    await chooseOverview({
      harness,
      selection: overviewSectionSelection({ id: "read" }),
    });
    const read = await harness.ui.waitForRuleForm();
    read.press("CtrlN");
    read.type("docs/**");
    read.press("CtrlX"); // scope the deny to direct read only
    read.press("Enter");

    await chooseOverview({
      harness,
      selection: overviewSectionSelection({ id: "write" }),
    });
    const write = await harness.ui.waitForRuleForm();
    write.press("CtrlN");
    write.type("generated/**");
    write.press("Tab");
    write.press("Enter");

    await chooseOverview({
      harness,
      selection: overviewSectionSelection({ id: "protected" }),
    });
    const safeguard = await harness.ui.waitForRuleForm();
    const protectedPurpose = renderPurposePresentation({
      purpose: ruleSectionPresentation.protected.purposePresentation,
      styles: {
        normal: (text) => text,
        deny: (text) => text,
        allow: (text) => text,
      },
    });
    expect(safeguard.render().join("\n").replace(/\s+/g, " ")).toContain(
      protectedPurpose,
    );
    safeguard.press("CtrlN");
    safeguard.type("**/.env");
    safeguard.press("Enter");

    const overview = await harness.ui.waitForProfileAuthoringOverview();
    const renderedOverview = overview.render().join("\n");
    expect(renderedOverview).toContain("Create profile: 🧪 layered-work");
    expect(renderedOverview).toContain("Description: Every rule layer");
    expect(renderedOverview).toContain(
      profileAuthoringSectionOption({
        label: compositionSectionLabel,
        summary: "builtin:default",
      }),
    );
    expect(renderedOverview).toContain(
      profileAuthoringSectionOption({
        label: transformsSectionLabel,
        summary: localProfileDeclarationCount({ count: 1 }),
      }),
    );
    expect(renderedOverview).toContain(
      profileAuthoringSectionOption({
        label: metadataSectionPresentation.sandbox.label,
        summary: "inherit",
      }),
    );
    expect(renderedOverview).toContain(
      profileAuthoringSectionOption({
        label: metadataSectionPresentation.directoryGlobs.label,
        summary: localProfileDeclarationCount({ count: 1 }),
      }),
    );
    for (const kind of ["bash", "read", "write", "protected"] as const)
      expect(renderedOverview).toContain(ruleSectionOption({ kind, count: 1 }));
    overview.choose({ selection: submitOverviewSelection });
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
    });
    await harness.start();

    const run = harness.runCommand("profile-add");
    await editGeneralFromOverview({
      harness,
      name: "back-work",
      description: "Back retention",
    });
    await chooseOverview({
      harness,
      selection: overviewSectionSelection({ id: "bash" }),
    });
    const editor = await harness.ui.waitForRuleForm();
    editor.press("CtrlN");
    editor.type("echo retained");
    editor.press("Escape");

    const overview = await harness.ui.waitForProfileAuthoringOverview();
    expect(overview.render().join("\n")).toContain(
      ruleSectionOption({ kind: "bash", count: 1 }),
    );
    overview.choose({ selection: overviewSectionSelection({ id: "bash" }) });
    const reopened = await harness.ui.waitForRuleForm();
    expect(reopened.render().join("\n")).toContain("cho retained");
    reopened.press("Escape");
    await chooseOverview({ harness, selection: submitOverviewSelection });
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
      confirm: true,
    });
    await harness.start();

    const run = harness.runCommand("profile-add");
    await editGeneralFromOverview({
      harness,
      name: "duplicate-work",
      description: "Duplicate validation",
    });
    await chooseOverview({
      harness,
      selection: overviewSectionSelection({ id: "bash" }),
    });
    const editor = await harness.ui.waitForRuleForm();
    editor.press("CtrlN");
    editor.type("echo duplicate");
    editor.press("CtrlN");
    editor.type("echo duplicate");
    editor.press("Tab");
    editor.press("Enter");

    await chooseOverview({
      harness,
      selection: overviewSectionSelection({ id: "read" }),
    });
    const readDraft = await harness.ui.waitForRuleForm();
    readDraft.press("CtrlN");
    readDraft.type("docs/retained/**");
    readDraft.press("CtrlN");
    readDraft.type("docs/retained/**");
    readDraft.press("Tab");
    readDraft.press("Enter");

    await chooseOverview({ harness, selection: submitOverviewSelection });
    const invalidEditor = await harness.ui.waitForRuleForm();
    const renderedInvalidEditor = invalidEditor.render().join("\n");
    expect(renderedInvalidEditor).toContain(profileAuthoringInvalidMarker);
    invalidEditor.press("Escape");

    const retainedOverview = await harness.ui.waitForProfileAuthoringOverview();
    const retainedRenderedOverview = retainedOverview.render().join("\n");
    expect(retainedRenderedOverview).toContain("Create profile:");
    expect(retainedRenderedOverview).toContain("duplicate-work");
    expect(retainedRenderedOverview).toContain(
      "Description: Duplicate validation",
    );
    expect(retainedRenderedOverview).toContain(
      ruleSectionOption({ kind: "bash", count: 2 }),
    );
    expect(retainedRenderedOverview).toContain(
      ruleSectionOption({ kind: "read", count: 2 }),
    );
    expect(retainedRenderedOverview).toContain(profileAuthoringInvalidMarker);
    expect(
      loadRawProfileConfig(configPath)?.profiles["duplicate-work"],
    ).toBeUndefined();
    retainedOverview.choose({
      selection: overviewSectionSelection({ id: "bash" }),
    });
    const retainedEditor = await harness.ui.waitForRuleForm();
    retainedEditor.press("CtrlShiftR"); // explicit clear
    const overviewWithReadIssue =
      await harness.ui.waitForProfileAuthoringOverview();
    expect(overviewWithReadIssue.render().join("\n")).toContain(
      profileAuthoringInvalidMarker,
    );
    overviewWithReadIssue.choose({ selection: submitOverviewSelection });
    const invalidReadEditor = await harness.ui.waitForRuleForm();
    expect(invalidReadEditor.render().join("\n")).toContain(
      profileAuthoringInvalidMarker,
    );
    invalidReadEditor.press("CtrlShiftR");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: submitOverviewSelection,
    });
    await run;
    expect(
      loadRawProfileConfig(configPath)?.profiles["duplicate-work"],
    ).toBeDefined();
  });

  it("uses the immutable startup directory in the prefilled inline child profile name", async () => {
    const configPath = temporaryConfig();
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      contextCwd: "/workspace/remembered-project",
    });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo remembered-permission" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const editor = await harness.ui.waitForRuleForm();
    expect(editor.render().join("\n")).toContain(
      "Writes to        profile tools.bash",
    );
    editor.press("Enter");
    const general = await harness.ui.waitForProfileGeneralForm();
    const expectedProfile = expectedInlineChildName();
    expect(general.render().join("\n")).toContain(expectedProfile);
    general.press("Enter");
    await pending;

    expect(
      loadRawProfileConfig(configPath)?.profiles[expectedProfile],
    ).toMatchObject({
      extends: ["builtin:default"],
      tools: {
        bash: [{ pattern: "echo remembered-permission", decision: "allow" }],
      },
    });
    expect(harness.entries.at(-1)).toMatchObject({
      customType: "pi-guard-profile",
      data: { profile: expectedProfile },
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
    first.press("Enter");
    const general = await harness.ui.waitForProfileGeneralForm();
    for (let index = 0; index < 40; index++) general.press("ArrowRight");
    for (let index = 0; index < 40; index++) general.press("Backspace");
    general.type("default-custom"); // force a persistence collision
    general.press("Enter");

    const retry = await harness.ui.waitForProfileGeneralForm();
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
    const harness = createExtensionHarness({
      interactiveUi: true,
      contextCwd: "/workspace/bash-only-project",
    });
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
    (await harness.ui.waitForProfileGeneralForm()).press("Enter");
    const result = await pending;

    expect(result).toBeUndefined();
    expect(
      loadRawProfileConfig(configPath)?.profiles[expectedInlineChildName()],
    ).toMatchObject({
      tools: {
        bash: [{ pattern: "echo hello > package.json", decision: "allow" }],
      },
    });
  });

  it("persists only non-skipped edited command choices from a multi-command ASK", async () => {
    const configPath = temporaryConfig();
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      contextCwd: "/workspace/multi-command-project",
    });
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
    (await harness.ui.waitForProfileGeneralForm()).press("Enter");
    const result = await pending;

    expect(result).toMatchObject({ block: true });
    expect(
      loadRawProfileConfig(configPath)?.profiles[expectedInlineChildName()],
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
    });
    await harness.start();
    const entriesBefore = harness.entries.map((entry) => ({ ...entry }));

    const run = harness.runCommand("profile-add");
    await choosePicker(harness, "builtin:default");
    await choosePicker(harness, "Done");
    await completeGeneral({
      harness,
      name: "discarded",
      description: "Discarded draft",
    });
    const overview = await harness.ui.waitForProfileAuthoringOverview();
    overview.cancel();
    await run;

    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(loadRawProfileConfig(configPath)?.defaultProfile).toBe("existing");
    expect(
      loadRawProfileConfig(configPath)?.profiles.discarded,
    ).toBeUndefined();
    expect(harness.entries).toEqual(entriesBefore);
  });

  it("authors optional sandbox and directory declarations through the command and confirms both capabilities", async () => {
    const configPath = temporaryConfig();
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const sandbox = {
      mode: "customize",
      network: { mode: "local", value: "allow" },
      allowLocalBinding: { mode: "omitted" },
      allowAppleEvents: { mode: "omitted" },
      enableWeakerNetworkIsolation: { mode: "omitted" },
      onUnavailable: { mode: "omitted" },
      extraWritePaths: { mode: "overwrite", value: ["/tmp/profile-add"] },
      extraDenyReadPaths: { mode: "inherit" },
      extraDenyWritePaths: { mode: "inherit" },
      kernelUnenforcedProtectedPaths: { mode: "inherit" },
    } as const;
    const harness = createExtensionHarness({
      contextCwd: "/workspace/profile-add",
      confirm: true,
      customResults: [
        overviewSectionSelection({ id: "general" }),
        {
          action: "save",
          draft: {
            mode: "create",
            name: "metadata-work",
            description: "Metadata profile",
            emoji: defaultCustomProfileEmoji,
          },
        },
        overviewSectionSelection({ id: "sandbox" }),
        { action: "save", draft: sandbox },
        overviewSectionSelection({ id: "directoryGlobs" }),
        {
          action: "save",
          draft: { mode: "set", value: ["/workspace/profile-add"] },
        },
        submitOverviewSelection,
      ],
    });
    await harness.start();

    await harness.runCommand("profile-add");

    expect(harness.ui.custom).toHaveBeenCalled();
    expect(
      loadRawProfileConfig(configPath)?.profiles["metadata-work"],
    ).toMatchObject({
      sandbox: {
        network: "allow",
        extraWritePaths: ["/tmp/profile-add"],
        overwritePathArrays: ["extraWritePaths"],
      },
      directoryGlobs: ["/workspace/profile-add"],
    });
    expect(harness.ui.confirm).toHaveBeenCalledWith(
      metadataConfirmationTitle({ kind: "sandbox" }),
      expect.any(String),
      expect.anything(),
    );
    expect(harness.ui.confirm).toHaveBeenCalledWith(
      metadataConfirmationTitle({ kind: "directoryGlobs" }),
      expect.any(String),
      expect.anything(),
    );
    expect(harness.entries.at(-1)).toMatchObject({
      data: { profile: "metadata-work" },
    });
  });

  it("keeps optional metadata drafts out of the config when confirmation is rejected", async () => {
    const configPath = temporaryConfig();
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactionScript: [
        {
          kind: "custom",
          response: overviewSectionSelection({ id: "general" }),
        },
        {
          kind: "custom",
          response: {
            action: "save",
            draft: {
              mode: "create",
              name: "rejected-metadata",
              description: "Rejected metadata",
              emoji: defaultCustomProfileEmoji,
            },
          },
        },
        {
          kind: "custom",
          response: overviewSectionSelection({ id: "sandbox" }),
        },
        {
          kind: "custom",
          response: {
            action: "save",
            draft: {
              mode: "customize",
              network: { mode: "local", value: "allow" },
              allowLocalBinding: { mode: "omitted" },
              allowAppleEvents: { mode: "omitted" },
              enableWeakerNetworkIsolation: { mode: "omitted" },
              onUnavailable: { mode: "omitted" },
              extraWritePaths: { mode: "inherit" },
              extraDenyReadPaths: { mode: "inherit" },
              extraDenyWritePaths: { mode: "inherit" },
              kernelUnenforcedProtectedPaths: { mode: "inherit" },
            },
          },
        },
        { kind: "custom", response: submitOverviewSelection },
        {
          kind: "confirm",
          title: metadataConfirmationTitle({ kind: "sandbox" }),
          response: false,
        },
        { kind: "custom", response: undefined },
        {
          kind: "confirm",
          title: profileDraftDiscardTitle,
          response: true,
        },
      ],
    });
    await harness.start();
    await harness.runCommand("profile-add");
    harness.assertInteractionsDrained();

    expect(harness.ui.confirm).toHaveBeenCalledWith(
      metadataConfirmationTitle({ kind: "sandbox" }),
      expect.any(String),
      expect.anything(),
    );
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(
      loadRawProfileConfig(configPath)?.profiles["rejected-metadata"],
    ).toBeUndefined();
    expect(harness.entries).toHaveLength(0);
  });

  type ProfileAddHarness = ReturnType<typeof createExtensionHarness>;
  type ProfileAddScenario = {
    readonly name: string;
    readonly missingConfig?: boolean;
    readonly advance: (args: {
      readonly harness: ProfileAddHarness;
    }) => Promise<void>;
  };

  const ctrlC = ({ harness }: { readonly harness: ProfileAddHarness }) =>
    harness.ui.sendTerminalInput({ data: "\x03" });
  const openProfileAddOverview = async ({
    harness,
  }: {
    readonly harness: ProfileAddHarness;
  }) => {
    const overview = await harness.ui.waitForProfileAuthoringOverview();
    overview.choose({ selection: overviewSectionSelection({ id: "general" }) });
    await completeGeneral({
      harness,
      name: "ctrl-c-profile",
      description: "Ctrl+C profile",
      emoji: "🧪",
    });
    return await harness.ui.waitForProfileAuthoringOverview();
  };
  const openProfileAddSection = async ({
    harness,
    id,
    populated = false,
  }: {
    readonly harness: ProfileAddHarness;
    readonly id: Extract<
      ProfileAuthoringOverviewSectionId,
      "bash" | "read" | "write" | "protected"
    >;
    readonly populated?: boolean;
  }): Promise<void> => {
    const overview = await openProfileAddOverview({ harness });
    overview.choose({ selection: overviewSectionSelection({ id }) });
    const form = await harness.ui.waitForRuleForm();
    if (populated) {
      form.press("CtrlN");
      form.type(`${id}-rule`);
    }
  };
  const profileAddCtrlCScenarios: readonly ProfileAddScenario[] = [
    {
      name: "composition",
      missingConfig: true,
      advance: async ({ harness }) => {
        const overview = await harness.ui.waitForProfileAuthoringOverview();
        overview.choose({
          selection: overviewSectionSelection({ id: "composition" }),
        });
        await harness.ui.waitForCustomModal();
      },
    },
    {
      name: "initial General",
      advance: async ({ harness }) => {
        const overview = await harness.ui.waitForProfileAuthoringOverview();
        overview.choose({
          selection: overviewSectionSelection({ id: "general" }),
        });
        await harness.ui.waitForProfileGeneralForm();
      },
    },
    {
      name: "overview",
      advance: async ({ harness }) => {
        await openProfileAddOverview({ harness });
      },
    },
    {
      name: "Prompt",
      advance: async ({ harness }) => {
        const overview = await openProfileAddOverview({ harness });
        overview.choose({
          selection: overviewSectionSelection({ id: "prompt" }),
        });
        await harness.ui.waitForCustomModal();
      },
    },
    {
      name: "transform",
      advance: async ({ harness }) => {
        const overview = await openProfileAddOverview({ harness });
        overview.choose({
          selection: overviewSectionSelection({ id: "transforms" }),
        });
        await harness.ui.waitForCustomModal();
      },
    },
    ...(["bash", "read", "write", "protected"] as const).flatMap((id) =>
      [false, true].map((populated) => ({
        name: `${id} ${populated ? "populated" : "empty"} rules`,
        advance: async ({ harness }: { readonly harness: ProfileAddHarness }) =>
          await openProfileAddSection({ harness, id, populated }),
      })),
    ),
    {
      name: "Sandbox",
      advance: async ({ harness }) => {
        const overview = await openProfileAddOverview({ harness });
        overview.choose({
          selection: overviewSectionSelection({ id: "sandbox" }),
        });
        await harness.ui.waitForCustomModal();
      },
    },
    {
      name: "Directory",
      advance: async ({ harness }) => {
        const overview = await openProfileAddOverview({ harness });
        overview.choose({
          selection: overviewSectionSelection({ id: "directoryGlobs" }),
        });
        await harness.ui.waitForCustomModal();
      },
    },
    {
      name: "Sandbox expansion confirmation",
      advance: async ({ harness }) => {
        // The default base denies network, so it correctly refuses a local
        // Customize draft that could never grant an expansion. Use the
        // network-enabled shipped base, then opt into Apple Events: this is
        // an actual sandbox capability expansion and reaches the production
        // confirmation path without extending the test timeout.
        const initialOverview =
          await harness.ui.waitForProfileAuthoringOverview();
        initialOverview.choose({
          selection: overviewSectionSelection({ id: "composition" }),
        });
        const composition = await harness.ui.waitForCustomModal();
        composition.press("CtrlD");
        composition.press("CtrlN");
        await choosePicker(harness, "builtin:default-with-net");
        (await harness.ui.waitForCustomModal()).press("Enter");
        const generalOverview =
          await harness.ui.waitForProfileAuthoringOverview();
        generalOverview.choose({
          selection: overviewSectionSelection({ id: "general" }),
        });
        await completeGeneral({
          harness,
          name: "ctrl-c-profile",
          description: "Ctrl+C profile",
          emoji: "🧪",
        });
        const overview = await harness.ui.waitForProfileAuthoringOverview();
        overview.choose({
          selection: overviewSectionSelection({ id: "sandbox" }),
        });
        const sandbox = await harness.ui.waitForCustomModal();
        sandbox.press("Tab"); // inherit → customize
        sandbox.press("ArrowDown"); // Network
        sandbox.press("ArrowDown"); // Local listeners
        sandbox.press("ArrowDown"); // Apple Events
        sandbox.press("Tab"); // inherit → false
        sandbox.press("ArrowRight"); // false → true
        sandbox.press("Enter");
        (await harness.ui.waitForProfileAuthoringOverview()).choose({
          selection: submitOverviewSelection,
        });
        await harness.ui.waitForConfirmation();
      },
    },
    {
      name: "Directory activation confirmation",
      advance: async ({ harness }) => {
        const overview = await openProfileAddOverview({ harness });
        overview.choose({
          selection: overviewSectionSelection({ id: "directoryGlobs" }),
        });
        (await harness.ui.waitForCustomModal()).press("Enter");
        (await harness.ui.waitForProfileAuthoringOverview()).choose({
          selection: submitOverviewSelection,
        });
        await harness.ui.waitForConfirmation();
      },
    },
    {
      name: "discard confirmation",
      advance: async ({ harness }) => {
        const overview = await openProfileAddOverview({ harness });
        overview.cancel();
        await harness.ui.waitForConfirmation();
      },
    },
  ];

  describe("cancels through the public Ctrl+C surface", () => {
    for (const scenario of profileAddCtrlCScenarios) {
      it(`leaves no side effects from ${scenario.name}`, async () => {
        const configPath = path.join(
          tmpdir(),
          `pi-guard-profile-add-ctrl-c-${crypto.randomUUID()}.jsonc`,
        );
        files.push(configPath);
        if (!scenario.missingConfig) {
          fs.writeFileSync(
            configPath,
            '// Ctrl+C must retain these exact bytes\n{\n  "profiles": {}\n}\n',
          );
        }
        const before = fs.existsSync(configPath)
          ? fs.readFileSync(configPath, "utf8")
          : undefined;
        process.env.PI_GUARD_PROFILE_CONFIG = configPath;
        const harness = createExtensionHarness({
          contextCwd: "/workspace/profile-add-ctrl-c",
          interactiveUi: true,
          pendingStockUi: true,
          tuiMode: true,
        });
        await harness.start();
        const entriesBefore = JSON.stringify(harness.entries);
        const activeProfileBefore = process.env.PI_GUARD_ACTIVE_PROFILE;
        const activeToolsBefore = harness.getActiveTools();
        const statusCallsBefore = harness.ui.setStatus.mock.calls.length;
        const activationCallsBefore =
          harness.setActiveToolsMock.mock.calls.length;

        const command = harness.runCommand("profile-add");
        await scenario.advance({ harness });
        const dialogsAtAbort = {
          confirm: harness.ui.confirm.mock.calls.length,
          custom: harness.ui.custom.mock.calls.length,
          input: harness.ui.input.mock.calls.length,
          select: harness.ui.select.mock.calls.length,
        };
        ctrlC({ harness });
        await command;

        if (before === undefined) expect(fs.existsSync(configPath)).toBe(false);
        else expect(fs.readFileSync(configPath, "utf8")).toBe(before);
        expect(JSON.stringify(harness.entries)).toBe(entriesBefore);
        expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(activeProfileBefore);
        expect(harness.getActiveTools()).toEqual(activeToolsBefore);
        expect(harness.ui.setStatus.mock.calls).toHaveLength(statusCallsBefore);
        expect(harness.setActiveToolsMock.mock.calls).toHaveLength(
          activationCallsBefore,
        );
        expect(harness.ui.confirm.mock.calls).toHaveLength(
          dialogsAtAbort.confirm,
        );
        expect(harness.ui.custom.mock.calls).toHaveLength(
          dialogsAtAbort.custom,
        );
        expect(harness.ui.input.mock.calls).toHaveLength(dialogsAtAbort.input);
        expect(harness.ui.select.mock.calls).toHaveLength(
          dialogsAtAbort.select,
        );
        expect(harness.ui.notify).not.toHaveBeenCalled();
      });
    }
  });

  it("returns from Composition to the retained draft before discarding CREATE", async () => {
    const configPath = temporaryConfig();
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      confirm: true,
    });
    await harness.start();

    const run = harness.runCommand("profile-add");
    await chooseOverview({
      harness,
      selection: overviewSectionSelection({ id: "composition" }),
    });
    const composition = await harness.ui.waitForCustomModal();
    composition.press("Escape");
    const overview = await harness.ui.waitForProfileAuthoringOverview();
    overview.cancel();
    await run;

    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(harness.ui.confirm).toHaveBeenCalledWith(
      profileDraftDiscardTitle,
      expect.any(String),
      expect.anything(),
    );
  });
});
