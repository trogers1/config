import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPathContexts, type PathContext } from "../modules/policyHelpers";
import {
  defaultCustomProfileEmoji,
  suggestedProfileName,
} from "../modules/profileAuthoringModel";
import { loadRawProfileConfig } from "../modules/profileConfig";
import {
  generalSectionPresentation,
  metadataConfirmationTitle,
  profileAuthoringInvalidMarker,
  ruleSectionPresentation,
} from "../modules/profileAuthoringPresentation";
import { askPermissionChoices } from "../modules/profileUpdate";
import type { ProfileAuthoringOverviewSelection } from "../modules/profileAuthoringOverview";
import { createExtensionHarness } from "./support/extensionHarness";

const submitOverviewSelection = {
  kind: "action",
  id: "submit",
} as const satisfies ProfileAuthoringOverviewSelection;
function overviewSectionSelection({
  id,
}: {
  readonly id:
    "bash" | "read" | "write" | "protected" | "sandbox" | "directoryGlobs";
}): ProfileAuthoringOverviewSelection {
  return { kind: "section", id };
}

const originalConfigPath = process.env.PI_GUARD_PROFILE_CONFIG;
const originalSubagentProfile = process.env.PI_SUBAGENT_PROFILE;
const [denyChoice, allowOnceChoice, saveRulesChoice] = askPermissionChoices;
const temporaryDirectories: string[] = [];

/** Remove terminal cursor styling before asserting user-visible copy. */
function plainText(value: string): string {
  return value.replace(
    /\x1b(?:\][^\x07]*\x07|_[^\x07]*\x07|\[[0-?]*[ -/]*[@-~])/g,
    "",
  );
}

function expectedInlineChildName({
  existingNames,
}: {
  readonly existingNames: ReadonlySet<string>;
}): string {
  return suggestedProfileName({
    profile: "builtin:default",
    cwd: process.cwd(),
    existingNames,
  });
}

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
  if (originalSubagentProfile === undefined)
    delete process.env.PI_SUBAGENT_PROFILE;
  else process.env.PI_SUBAGENT_PROFILE = originalSubagentProfile;
}

afterEach(() => {
  restoreEnvironment();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("profile updates through the public extension surface", () => {
  it("drives the production custom permission picker through a durable save", async () => {
    const configPath = writeConfig({
      defaultProfile: "tui-work",
      profiles: {
        "tui-work": {
          description: "TUI permission picker fixture.",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: "echo tui-ask", decision: "ask" }] },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      tuiMode: true,
    });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo tui-ask" },
    });
    const picker = await harness.ui.waitForCustomModal();
    expect(picker.render().join("\n")).toContain(
      "⚙️ Bash command permission request",
    );
    picker.type(saveRulesChoice);
    picker.press("Enter");
    const editor = await harness.ui.waitForRuleForm();
    expect(editor.render().join("\n")).toContain(
      ruleSectionPresentation.bash.label,
    );
    editor.press("Enter");
    expect(await pending).toBeUndefined();
    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo tui-ask" },
    });
  });

  it("omits durable save when a Bash request mixes concrete and dynamic path ASKs", async () => {
    const configPath = writeConfig({
      defaultProfile: "mixed-uncertainty",
      profiles: {
        "mixed-uncertainty": {
          description: "Concrete plus non-authorable ASK fixture.",
          extends: ["builtin:default"],
          tools: {
            bash: [
              { pattern: 'cat "$TARGET" > concrete.txt', decision: "ask" },
            ],
          },
          writePaths: [{ pattern: "concrete.txt", decision: "ask" }],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: 'cat "$TARGET" > concrete.txt' },
    });
    const permission = await harness.ui.waitForCustomModal();
    expect(permission.render().join("\n")).not.toContain(
      "Save rule(s) to profile…",
    );
    permission.type(allowOnceChoice);
    permission.press("Enter");
    expect(await pending).toBeUndefined();
  });

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
      "Save rule(s) to profile…",
    );
    const deniedForm = await harness.ui.waitForRuleForm();
    deniedForm.press("Tab"); // allow → deny
    deniedForm.press("ArrowDown");
    deniedForm.type("Use the documented workflow instead.");
    deniedForm.press("Enter");
    const denied = await deniedPending;
    expect(denied).toMatchObject({ block: true });
    expect(denied?.reason).toContain("Use the documented workflow instead.");

    const repeatedDeny = await harness.callToolDecisivelyWithoutPrompt({
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
      "Save rule(s) to profile…",
    );
    const allowedForm = await harness.ui.waitForRuleForm();
    allowedForm.press("Enter");
    await allowedPending;
    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo remember-allow" },
    });
  });

  it("does not save an all-skipped ASK draft and discards only from the permission choice", async () => {
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
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    form.press("Tab"); // allow → deny
    form.press("Tab"); // deny → skip
    expect(form.render().join("\n")).toContain(
      "Save disabled: every row is skipped",
    );
    form.press("Escape"); // Back retains the draft and reopens the choice.
    (await harness.ui.waitForPermissionChoice()).choose(denyChoice);

    expect(await request).toMatchObject({ block: true });
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  });

  it("treats Ctrl+C in an ASK rule editor as local Back and retains its draft", async () => {
    const configPath = writeConfig({ profiles: {} });
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      contextCwd: "/workspace/retained-child",
    });
    await harness.start();
    const entries = [...harness.entries];

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo retain-child-draft" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
    const editor = await harness.ui.waitForRuleForm();
    for (let index = 0; index < 40; index++) editor.press("ArrowRight");
    editor.type(" retained");
    editor.press("CtrlC");

    // Rule editors keep their local Back behavior. They do not receive the
    // General form's root-cancel semantics.
    (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
    const reopened = await harness.ui.waitForRuleForm();
    expect(plainText(reopened.render().join("\n"))).toContain(
      "echo retain-child-draft retained",
    );
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(harness.entries).toEqual(entries);
    // Ctrl+C and Escape both retain the local draft while returning to the
    // request picker. End the pending request from that production picker;
    // saving the retained draft is covered by the inline child save flow.
    reopened.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose(denyChoice);

    expect(await pending).toMatchObject({ block: true });
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  });

  it("returns General Escape to the retained ASK rules before saving", async () => {
    const configPath = writeConfig({ profiles: {} });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      contextCwd: "/workspace/general-back",
    });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo general-back" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
    const rules = await harness.ui.waitForRuleForm();
    rules.press("Tab"); // allow → deny
    rules.press("ArrowDown");
    rules.type("Return through the approved workflow.");
    rules.press("Enter");

    const general = await harness.ui.waitForProfileGeneralForm();
    general.press("ArrowDown");
    general.type(" retained");
    general.press("Escape");
    const reopenedRules = await harness.ui.waitForRuleForm();
    expect(plainText(reopenedRules.render().join("\n"))).toContain(
      "Return through the approved workflow.",
    );
    reopenedRules.press("Enter");
    const reopenedGeneral = await harness.ui.waitForProfileGeneralForm();
    expect(reopenedGeneral.render().join("\n")).toContain(
      "Custom extension of builtin:default. retained",
    );
    reopenedGeneral.press("Enter");

    expect(await pending).toMatchObject({ block: true });
    expect(
      loadRawProfileConfig(configPath)?.profiles[
        expectedInlineChildName({ existingNames: new Set() })
      ].tools?.bash,
    ).toContainEqual({
      pattern: "echo general-back",
      decision: "deny",
      guidance: "Return through the approved workflow.",
    });
  });

  it("returns General Ctrl+C to the permission picker without writing a child", async () => {
    const configPath = writeConfig({ profiles: {} });
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo cancel-general" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
    (await harness.ui.waitForRuleForm()).press("Enter");
    (await harness.ui.waitForProfileGeneralForm()).press("CtrlC");
    (await harness.ui.waitForPermissionChoice()).choose(denyChoice);

    expect(await pending).toMatchObject({ block: true });
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(loadRawProfileConfig(configPath)?.profiles).toEqual({});
  });

  it("does not open General or create a child when every ASK rule is skipped", async () => {
    const configPath = writeConfig({ profiles: {} });
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo skip-general" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
    const rules = await harness.ui.waitForRuleForm();
    rules.press("Tab"); // allow → deny
    rules.press("Tab"); // deny → skip
    expect(rules.render().join("\n")).toContain(
      "Save disabled: every row is skipped",
    );
    rules.press("Escape");
    expect(harness.ui.custom).toHaveBeenCalledTimes(2); // picker + rules only
    (await harness.ui.waitForPermissionChoice()).choose(denyChoice);

    expect(await pending).toMatchObject({ block: true });
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  });

  it("keeps PI_SUBAGENT_PROFILE authoritative after saving an inline ASK child", async () => {
    const configPath = writeConfig({ profiles: {} });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    delete process.env.PI_SUBAGENT_PROFILE;
    vi.resetModules();
    const { createExtensionHarness: createSubagentHarness } =
      await import("./support/extensionHarness");
    process.env.PI_SUBAGENT_PROFILE = "builtin:default";
    const harness = createSubagentHarness({
      interactiveUi: true,
      contextCwd: "/workspace/authority-child",
    });
    await harness.start();
    const entriesBeforeSave = harness.entries.length;

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo authority-child" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
    (await harness.ui.waitForRuleForm()).press("Enter");
    const general = await harness.ui.waitForProfileGeneralForm();
    const expectedChild = expectedInlineChildName({ existingNames: new Set() });
    expect(general.render().join("\n")).toContain(expectedChild);
    general.press("Enter");
    // The saved child cannot override the launcher's authoritative parent.
    (await harness.ui.waitForPermissionChoice()).choose(denyChoice);

    expect(await pending).toMatchObject({ block: true });
    const child = loadRawProfileConfig(configPath)?.profiles[expectedChild];
    expect(child).toMatchObject({
      extends: ["builtin:default"],
      tools: { bash: [{ pattern: "echo authority-child", decision: "allow" }] },
    });
    expect(process.env.PI_SUBAGENT_PROFILE).toBe("builtin:default");
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("builtin:default");
    expect(
      JSON.stringify(harness.entries.slice(entriesBeforeSave)),
    ).not.toContain(`"profile":"${expectedChild}"`);
  });

  it("adds a labelled related rule with changed kind/context in the atomic ASK batch", async () => {
    const configPath = writeConfig({
      defaultProfile: "related-work",
      profiles: {
        "related-work": {
          description: "Additional ASK row fixture.",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: "echo primary", decision: "ask" }] },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo primary" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const editor = await harness.ui.waitForRuleForm();
    editor.press("CtrlN");
    editor.press("CtrlK"); // Bash → read path
    editor.press("CtrlX"); // all read contexts → read
    editor.press("CtrlX"); // read → grep
    editor.type("related.txt");
    expect(editor.render().join("\n")).toContain(
      "Additional profile rule (not required by this ASK)",
    );
    editor.press("ArrowDown");
    editor.type("Use the related workflow.");
    editor.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const reopened = await harness.ui.waitForRuleForm();
    const restored = reopened.render().join("\n");
    expect(restored).toContain(
      "Additional profile rule (not required by this ASK)",
    );
    expect(restored).toContain("elated.txt");
    expect(restored).toContain("Context          grep");
    expect(restored).toContain("se the related workflow.");
    expect(restored).toContain("ASK → ⛔️ DENY");
    reopened.press("Enter");
    await pending;

    const profile = loadRawProfileConfig(configPath)?.profiles["related-work"];
    expect(profile?.tools?.bash).toContainEqual({
      pattern: "echo primary",
      decision: "allow",
    });
    expect(profile?.readPaths).toContainEqual({
      pattern: "related.txt",
      decision: "deny",
      contexts: ["grep"],
      guidance: "Use the related workflow.",
    });
    const enforcement = createExtensionHarness({ hasUI: false });
    await enforcement.start();
    expect(
      await enforcement.callTool({
        toolName: "grep",
        input: { path: "related.txt", pattern: "needle" },
      }),
    ).toMatchObject({ block: true });
    expect(
      await enforcement.callTool({
        toolName: "read",
        input: { path: "related.txt" },
      }),
    ).toBeUndefined();
  });

  it("retains only a skipped direct-path draft after an additional-rule save", async () => {
    const configPath = writeConfig({
      defaultProfile: "direct-partial-work",
      profiles: {
        "direct-partial-work": {
          description: "Direct partial-save fixture.",
          extends: ["builtin:default"],
          readPaths: [
            { pattern: "requested.txt", decision: "ask", contexts: ["read"] },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "read",
      input: { path: "requested.txt" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const editor = await harness.ui.waitForRuleForm();
    for (let index = 0; index < 40; index++) editor.press("ArrowRight");
    editor.type(" retained");
    editor.press("Tab"); // allow → deny
    editor.press("ArrowDown");
    editor.type("Retain this request guidance.");
    editor.press("ArrowUp");
    editor.press("Tab"); // deny → skip
    editor.press("CtrlN");
    editor.type("saved-related.txt");
    editor.press("Enter");

    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const unresolved = await harness.ui.waitForRuleForm();
    const rendered = unresolved.render().join("\n");
    expect(rendered).toContain("retained");
    expect(rendered).not.toContain("saved-related.txt");
    expect(rendered).toContain("unchanged; remains ASK");
    unresolved.press("Tab"); // skip → allow
    unresolved.press("Tab"); // allow → deny
    expect(unresolved.render().join("\n")).toContain(
      "etain this request guidance.",
    );
    unresolved.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose("No (default)");

    expect(await pending).toMatchObject({ block: true });
    expect(
      loadRawProfileConfig(configPath)?.profiles["direct-partial-work"]
        .readPaths,
    ).toContainEqual({
      pattern: "saved-related.txt",
      decision: "deny",
      contexts: ["read"],
    });
  });

  it("re-prompts with only skipped Bash candidates and retains their edits", async () => {
    const configPath = writeConfig({
      defaultProfile: "partial-work",
      profiles: {
        "partial-work": {
          description: "Partial ASK save fixture.",
          extends: ["builtin:default"],
          tools: {
            bash: [
              { pattern: "echo first", decision: "ask" },
              { pattern: "echo second", decision: "ask" },
            ],
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo first && echo second" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const firstEditor = await harness.ui.waitForRuleForm();
    firstEditor.press("ArrowDown");
    for (let index = 0; index < 40; index++) firstEditor.press("ArrowRight");
    firstEditor.type(" edited");
    firstEditor.press("Tab"); // allow → deny
    firstEditor.press("Tab"); // deny → skip
    firstEditor.press("Enter"); // save only echo first

    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const unresolvedEditor = await harness.ui.waitForRuleForm();
    const unresolved = unresolvedEditor.render().join("\n");
    expect(unresolved).toContain("second edited");
    expect(unresolved).not.toContain("echo first");
    unresolvedEditor.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const reopened = await harness.ui.waitForRuleForm();
    expect(reopened.render().join("\n")).toContain("second edited");
    reopened.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose("No (default)");

    expect(await pending).toMatchObject({ block: true });
    expect(
      loadRawProfileConfig(configPath)?.profiles["partial-work"].tools?.bash,
    ).toContainEqual({ pattern: "echo first", decision: "allow" });
  });

  it("resets an interactive profile update to exact allow defaults before saving", async () => {
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
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    form.type(" changed");
    form.press("Tab");
    form.press("ArrowDown");
    form.type("Do not save this guidance.");
    form.press("CtrlShiftR");
    form.press("Enter");

    const resetResult = await pending;
    expect(resetResult).toBeUndefined();

    // Reset restores the request-derived exact pattern and default allow, so
    // the exact retry is prompt-free after persistence and re-evaluation.
    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo reset-me" },
    });
  });

  it("persists a direct read ASK to readPaths with immutable request semantics", async () => {
    const configPath = writeConfig({
      defaultProfile: "read-work",
      profiles: {
        "read-work": {
          description: "Read context fixture.",
          extends: ["builtin:default"],
          readPaths: [
            { pattern: "private.txt", decision: "ask", contexts: ["read"] },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "read",
      input: { path: "private.txt" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    const rendered = form.render().join("\n");
    expect(rendered).toContain(ruleSectionPresentation.read.label);
    expect(rendered).toContain("Requested value");
    expect(rendered).toContain("Context/source   read");
    expect(rendered).toContain("Writes to        profile readPaths");
    expect(rendered).toContain("writes are unaffected");
    form.press("Enter");
    await pending;

    expect(
      loadRawProfileConfig(configPath)?.profiles["read-work"].readPaths,
    ).toContainEqual({
      pattern: "private.txt",
      decision: "allow",
      contexts: ["read"],
    });
    await harness.callToolWithoutPrompt({
      toolName: "read",
      input: { path: "private.txt" },
    });
  });

  it("replaces the exact persisted absolute ASK identity when the display pattern is relative", async () => {
    const requestedPath = path.join(process.cwd(), "absolute-identity.txt");
    const configPath = writeConfig({
      defaultProfile: "absolute-identity-work",
      profiles: {
        "absolute-identity-work": {
          description: "Absolute persisted ASK identity fixture.",
          extends: ["builtin:default"],
          readPaths: [
            {
              pattern: requestedPath,
              decision: "ask",
              contexts: ["read"],
            },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "read",
      input: { path: "absolute-identity.txt" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const editor = await harness.ui.waitForRuleForm();
    expect(editor.render(300).join("\n")).toContain(requestedPath);
    editor.press("Enter");
    expect(await pending).toBeUndefined();

    expect(
      loadRawProfileConfig(configPath)?.profiles["absolute-identity-work"]
        .readPaths,
    ).toEqual([
      {
        pattern: "absolute-identity.txt",
        decision: "allow",
        contexts: ["read"],
      },
    ]);
    await harness.callToolWithoutPrompt({
      toolName: "read",
      input: { path: "absolute-identity.txt" },
    });
  });

  it("persists an edited broader path pattern with matching preview semantics", async () => {
    const configPath = writeConfig({
      defaultProfile: "broaden-work",
      profiles: {
        "broaden-work": {
          description: "Broader pattern fixture.",
          extends: ["builtin:default"],
          writePaths: [
            { pattern: "generated/a.ts", decision: "ask", contexts: ["write"] },
            { pattern: "outside.ts", decision: "deny", contexts: ["write"] },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "write",
      input: { path: "generated/a.ts", content: "a" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    for (let index = 0; index < 40; index++) form.press("ArrowRight");
    for (let index = 0; index < 40; index++) form.press("Backspace");
    form.type("generated/**");
    const rendered = form.render().join("\n");
    expect(rendered).toContain("Requested value");
    expect(rendered).toContain("generated/a.ts");
    expect(rendered).toContain("Writes to        profile writePaths");
    expect(rendered).toMatch(/broader|custom/i);
    form.press("Enter");
    await pending;

    // Mutated candidates append after retained declarations. This persisted
    // order is security-significant for ties, while the sibling DENY remains
    // a distinct durable rule and matches preview.
    expect(
      loadRawProfileConfig(configPath)?.profiles["broaden-work"].writePaths,
    ).toEqual([
      { pattern: "outside.ts", decision: "deny", contexts: ["write"] },
      { pattern: "generated/**", decision: "allow", contexts: ["write"] },
    ]);

    expect(
      await harness.callToolWithoutPrompt({
        toolName: "write",
        input: { path: "generated/b.ts", content: "b" },
      }),
    ).toBeUndefined();
    expect(
      await harness.callTool({
        toolName: "write",
        input: { path: "outside.ts", content: "outside" },
      }),
    ).toMatchObject({ block: true });
  });

  it.each([
    ["read", "grep"],
    ["grep", "find"],
    ["find", "ls"],
    ["ls", "read"],
    ["edit", "write"],
    ["write", "edit"],
  ] satisfies readonly (readonly [PathContext, PathContext])[])(
    "persists direct %s context without granting sibling %s context",
    async (toolName, siblingTool) => {
      const isRead = readPathContexts.some((context) => context === toolName);
      const requestedPath = `context-${toolName}.txt`;
      const configPath = writeConfig({
        defaultProfile: "context-work",
        profiles: {
          "context-work": {
            description: "Direct context scoping fixture.",
            extends: ["builtin:default"],
            [isRead ? "readPaths" : "writePaths"]: [
              {
                pattern: requestedPath,
                decision: "ask",
                contexts: [toolName, siblingTool],
              },
            ],
          },
        },
      });
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const harness = createExtensionHarness({ interactiveUi: true });
      await harness.start();
      const inputFor = (tool: string): Record<string, unknown> => {
        switch (tool) {
          case "grep":
            return { path: requestedPath, pattern: "needle" };
          case "edit":
            return { path: requestedPath, edits: [] };
          case "write":
            return { path: requestedPath, content: "context test" };
          default:
            return { path: requestedPath };
        }
      };

      const pending = harness.callTool({
        toolName,
        input: inputFor(toolName),
      });
      (await harness.ui.waitForPermissionChoice()).choose(
        "Save rule(s) to profile…",
      );
      const form = await harness.ui.waitForRuleForm();
      expect(form.render().join("\n")).toContain(
        `${toolName} · ${toolName} tool`,
      );
      form.press("Enter");
      await pending;

      const profile =
        loadRawProfileConfig(configPath)?.profiles["context-work"];
      const collection = isRead ? profile?.readPaths : profile?.writePaths;
      expect(collection).toContainEqual({
        pattern: requestedPath,
        decision: "allow",
        contexts: [toolName],
      });
      const siblingHarness = createExtensionHarness({ hasUI: false });
      await siblingHarness.start();
      expect(
        await siblingHarness.callTool({
          toolName: siblingTool,
          input: inputFor(siblingTool),
        }),
      ).toMatchObject({ block: true });
    },
  );

  it("persists cd as readPaths context ls without granting read context", async () => {
    const configPath = writeConfig({
      defaultProfile: "cd-work",
      profiles: {
        "cd-work": {
          description: "cd context fixture.",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: "cd context-dir", decision: "allow" }] },
          readPaths: [
            {
              pattern: "context-dir",
              decision: "ask",
              contexts: ["ls", "read"],
            },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "cd context-dir" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    const rendered = form.render().join("\n");
    expect(rendered).toContain(ruleSectionPresentation.read.label);
    expect(rendered).toContain("ls · bash (ls path reference)");
    form.press("Enter");
    await pending;

    expect(
      loadRawProfileConfig(configPath)?.profiles["cd-work"].readPaths,
    ).toContainEqual({
      pattern: "context-dir",
      decision: "allow",
      contexts: ["ls"],
    });
    const siblingHarness = createExtensionHarness({ hasUI: false });
    await siblingHarness.start();
    expect(
      await siblingHarness.callTool({
        toolName: "read",
        input: { path: "context-dir" },
      }),
    ).toMatchObject({ block: true });
  });

  it("persists ordinary write-path deny and allow decisions through ASK flows", async () => {
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
      "Save rule(s) to profile…",
    );
    const deniedForm = await harness.ui.waitForRuleForm();
    deniedForm.press("Tab"); // allow → deny
    deniedForm.press("Enter");
    const denied = await deniedPending;
    expect(denied).toMatchObject({ block: true });
    const repeatedDeny = await harness.callToolDecisivelyWithoutPrompt({
      toolName: "write",
      input: { path: "remember-deny.txt", content: "no" },
    });
    expect(repeatedDeny).toMatchObject({ block: true });

    const allowedPending = harness.callTool({
      toolName: "write",
      input: { path: "remember-allow.txt", content: "yes" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const allowedForm = await harness.ui.waitForRuleForm();
    allowedForm.press("Enter");
    await allowedPending;
    await harness.callToolWithoutPrompt({
      toolName: "write",
      input: { path: "remember-allow.txt", content: "yes" },
    });
  });

  it("keeps direct read saves scoped while the write layer remains governed", async () => {
    const configPath = writeConfig({
      defaultProfile: "read-write-boundary",
      profiles: {
        "read-write-boundary": {
          description: "Separate direct read and write decisions.",
          extends: ["builtin:default"],
          readPaths: [
            { pattern: "boundary.txt", decision: "ask", contexts: ["read"] },
          ],
          writePaths: [
            { pattern: "boundary.txt", decision: "ask", contexts: ["write"] },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const read = harness.callTool({
      toolName: "read",
      input: { path: "boundary.txt" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const readForm = await harness.ui.waitForRuleForm();
    expect(readForm.render().join("\n")).toContain("writes are unaffected");
    readForm.press("Enter");
    await read;

    expect(
      loadRawProfileConfig(configPath)?.profiles["read-write-boundary"]
        .readPaths,
    ).toContainEqual({
      pattern: "boundary.txt",
      decision: "allow",
      contexts: ["read"],
    });
    const write = harness.callTool({
      toolName: "write",
      input: { path: "boundary.txt", content: "x" },
    });
    const writePicker = await harness.ui.waitForPermissionChoice();
    expect(writePicker.render().join("\n")).toContain("permission request");
    writePicker.choose("No (default)");
    expect(await write).toMatchObject({ block: true });
  });

  it("persists direct write denial guidance without changing read enforcement", async () => {
    const configPath = writeConfig({
      defaultProfile: "write-read-boundary",
      profiles: {
        "write-read-boundary": {
          description: "Separate direct write and read decisions.",
          extends: ["builtin:default"],
          readPaths: [
            { pattern: "boundary.txt", decision: "ask", contexts: ["read"] },
          ],
          writePaths: [
            { pattern: "boundary.txt", decision: "ask", contexts: ["write"] },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const write = harness.callTool({
      toolName: "write",
      input: { path: "boundary.txt", content: "x" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    form.press("Tab");
    form.press("ArrowDown");
    form.type("Writes require the approved workflow.");
    form.press("Enter");
    expect(await write).toMatchObject({ block: true });
    expect(
      await harness.callToolDecisivelyWithoutPrompt({
        toolName: "write",
        input: { path: "boundary.txt", content: "x" },
      }),
    ).toMatchObject({ block: true });

    const read = harness.callTool({
      toolName: "read",
      input: { path: "boundary.txt" },
    });
    const readPicker = await harness.ui.waitForPermissionChoice();
    expect(readPicker.render().join("\n")).toContain("permission request");
    readPicker.choose("No (default)");
    expect(await read).toMatchObject({ block: true });
    expect(
      loadRawProfileConfig(configPath)?.profiles["write-read-boundary"]
        .writePaths,
    ).toContainEqual({
      pattern: "boundary.txt",
      decision: "deny",
      contexts: ["write"],
      guidance: "Writes require the approved workflow.",
    });
  });

  it("presents three Bash candidates in encounter order and re-prompts only skipped rows", async () => {
    const configPath = writeConfig({
      defaultProfile: "three-candidates",
      profiles: {
        "three-candidates": {
          description: "Three authorable Bash candidates.",
          extends: ["builtin:default"],
          tools: {
            bash: [
              { pattern: "echo first", decision: "ask" },
              { pattern: "echo second", decision: "ask" },
              { pattern: "echo third", decision: "ask" },
            ],
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo first && echo second && echo third" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    const rendered = form.render().join("\n");
    expect(rendered.indexOf("echo first")).toBeLessThan(
      rendered.indexOf("echo second"),
    );
    expect(rendered.indexOf("echo second")).toBeLessThan(
      rendered.indexOf("echo third"),
    );
    // Keep first and third as allow; skip only the second.
    form.press("ArrowDown");
    form.press("Tab");
    form.press("Tab");
    form.press("Enter");
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const skipped = await harness.ui.waitForRuleForm();
    const retry = skipped.render().join("\n");
    expect(retry).toContain("echo second");
    expect(retry).not.toContain("echo first");
    expect(retry).not.toContain("echo third");
    skipped.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose("No (default)");
    expect(await pending).toMatchObject({ block: true });
    expect(
      loadRawProfileConfig(configPath)?.profiles["three-candidates"].tools
        ?.bash,
    ).toEqual(
      expect.arrayContaining([
        { pattern: "echo first", decision: "allow" },
        { pattern: "echo third", decision: "allow" },
      ]),
    );
  });

  it("keeps distinct Bash path contexts while deduplicating repeated path candidates", async () => {
    const configPath = writeConfig({
      defaultProfile: "dedupe-contexts",
      profiles: {
        "dedupe-contexts": {
          description: "Repeated path references with distinct contexts.",
          extends: ["builtin:default"],
          tools: {
            bash: [
              {
                pattern: "cat same.txt same.txt; cd same.txt",
                decision: "allow",
              },
            ],
          },
          readPaths: [
            { pattern: "same.txt", decision: "ask", contexts: ["ls"] },
          ],
          writePaths: [
            { pattern: "same.txt", decision: "ask", contexts: ["bash"] },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "cat same.txt same.txt; cd same.txt" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    const rendered = form.render().join("\n");
    expect(rendered.match(/Requested value/g)?.length, rendered).toBe(2);
    expect(rendered).toContain("Context/source   ls");
    expect(rendered).toContain("Context/source   bash");
    form.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose("No (default)");
    expect(await pending).toMatchObject({ block: true });
  });

  it("allows a parent glob and denies only an additional narrower child", async () => {
    const configPath = writeConfig({
      defaultProfile: "glob-child",
      profiles: {
        "glob-child": {
          description: "Parent and child glob fixture.",
          extends: ["builtin:default"],
          writePaths: [
            {
              pattern: "generated/a.txt",
              decision: "ask",
              contexts: ["write"],
            },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.callTool({
      toolName: "write",
      input: { path: "generated/a.txt", content: "a" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const form = await harness.ui.waitForRuleForm();
    expect(form.render().join("\n")).toContain(
      "PATH GLOB/PATTERN — interpreted as a glob, not a literal path",
    );
    for (let index = 0; index < 40; index++) form.press("ArrowRight");
    for (let index = 0; index < 40; index++) form.press("Backspace");
    form.type("generated/**");
    form.press("CtrlN");
    form.type("generated/private/**");
    form.press("Enter");
    await pending;

    await harness.callToolWithoutPrompt({
      toolName: "write",
      input: { path: "generated/sibling.txt", content: "ok" },
    });
    expect(
      await harness.callTool({
        toolName: "write",
        input: { path: "generated/private/secret.txt", content: "no" },
      }),
    ).toMatchObject({ block: true });
    expect(
      loadRawProfileConfig(configPath)?.profiles["glob-child"].writePaths,
    ).toEqual(
      expect.arrayContaining([
        { pattern: "generated/**", decision: "allow", contexts: ["write"] },
        {
          pattern: "generated/private/**",
          decision: "deny",
          contexts: ["write"],
        },
      ]),
    );
  });

  it("keeps General and rule drafts after child-name validation, then saves atomically", async () => {
    const configPath = writeConfig({
      defaultProfile: "builtin:default",
      profiles: {
        "default-custom": {
          description: "Collision",
          extends: ["builtin:default"],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      contextCwd: "/workspace/general-validation",
    });
    await harness.start();
    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo child-target" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
    const rules = await harness.ui.waitForRuleForm();
    rules.press("Tab"); // allow → deny
    rules.press("ArrowDown");
    rules.type("Use the child workflow.");
    rules.press("Enter");

    const general = await harness.ui.waitForProfileGeneralForm();
    const prefilled = general.render().join("\n");
    expect(prefilled).toContain(generalSectionPresentation.label);
    expect(prefilled).toContain(
      expectedInlineChildName({ existingNames: new Set(["default-custom"]) }),
    );
    expect(prefilled).toContain("Custom extension of builtin:default.");
    expect(prefilled).toContain(defaultCustomProfileEmoji);
    general.press("CtrlU");
    general.type("default-custom");
    general.press("Enter");
    expect(general.render().join("\n")).toContain("already exists");
    general.press("CtrlU");
    general.type("recovered-custom");
    general.press("Enter");

    expect(await pending).toMatchObject({ block: true });
    expect(
      loadRawProfileConfig(configPath)?.profiles["recovered-custom"],
    ).toMatchObject({
      description: "Custom extension of builtin:default.",
      emoji: defaultCustomProfileEmoji,
      extends: ["builtin:default"],
      tools: {
        bash: [
          {
            pattern: "echo child-target",
            decision: "deny",
            guidance: "Use the child workflow.",
          },
        ],
      },
    });
  });

  it("saves combined Bash and ordinary path allows and continues after re-evaluation", async () => {
    const configPath = writeConfig({
      defaultProfile: "combined-allow-work",
      profiles: {
        "combined-allow-work": {
          description: "Combined allow and recheck fixture.",
          extends: ["builtin:default"],
          tools: {
            bash: [
              { pattern: "echo combined > combined.txt", decision: "ask" },
            ],
          },
          writePaths: [
            { pattern: "combined.txt", decision: "ask", contexts: ["bash"] },
          ],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo combined > combined.txt" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const editor = await harness.ui.waitForRuleForm();
    const rendered = editor.render().join("\n");
    expect(rendered.indexOf(ruleSectionPresentation.write.label)).toBeLessThan(
      rendered.indexOf(ruleSectionPresentation.bash.label),
    );
    editor.press("Enter");
    expect(await pending).toBeUndefined();

    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo combined > combined.txt" },
    });
    const profile =
      loadRawProfileConfig(configPath)?.profiles["combined-allow-work"];
    expect(profile?.tools?.bash).toContainEqual({
      pattern: "echo combined > combined.txt",
      decision: "allow",
    });
    expect(profile?.writePaths).toContainEqual({
      pattern: "combined.txt",
      decision: "allow",
      contexts: ["bash"],
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
      "Save rule(s) to profile…",
    );
    const commandForm = await harness.ui.waitForRuleForm();
    const rendered = commandForm.render().join("\n");
    expect(rendered.indexOf(ruleSectionPresentation.write.label)).toBeLessThan(
      rendered.indexOf(ruleSectionPresentation.bash.label),
    );
    commandForm.press("ArrowDown"); // path row → Bash row
    commandForm.press("Tab"); // allow → deny
    commandForm.press("ArrowDown"); // inline persistent guidance
    commandForm.type("Use the approved project workflow.");
    commandForm.press("Enter");
    const denied = await deniedPending;
    expect(denied).toMatchObject({ block: true });
    expect(denied?.reason).toContain("Use the approved project workflow.");
    const persisted = loadRawProfileConfig(configPath)?.profiles["both-work"];
    expect(persisted?.tools?.bash).toContainEqual({
      pattern: "echo both > both.txt",
      decision: "deny",
      guidance: "Use the approved project workflow.",
    });
    expect(persisted?.writePaths).toContainEqual({
      pattern: "both.txt",
      decision: "allow",
      contexts: ["bash"],
    });
    expect(harness.ui.custom).toHaveBeenCalledTimes(2);

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

  it("edits every /profile-edit destination without flattening untouched local ASK declarations", async () => {
    const configPath = writeConfig({
      defaultProfile: "edit-work",
      profiles: {
        "edit-work": {
          description: "Raw declaration preservation fixture.",
          extends: ["builtin:default"],
          tools: {
            bash: [
              {
                pattern: "echo ask",
                decision: "ask",
                alternatives: ["echo safe"],
              },
            ],
            deploy: [{ decision: "deny", match: { target: "release" } }],
          },
          readPaths: [
            {
              pattern: "secret.txt",
              decision: "ask",
              contexts: ["read", "grep"],
            },
          ],
          writePaths: [
            { pattern: "output.txt", decision: "ask", contexts: ["write"] },
          ],
          protectedPathRules: [{ pattern: ".env", decision: "deny" }],
          sandbox: { network: "deny", extraWritePaths: ["/tmp/inherited"] },
          directoryGlobs: ["/workspace/old"],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const customize = {
      mode: "customize",
      network: { mode: "local", value: "allow" },
      allowLocalBinding: { mode: "omitted" },
      allowAppleEvents: { mode: "omitted" },
      enableWeakerNetworkIsolation: { mode: "omitted" },
      onUnavailable: { mode: "omitted" },
      extraWritePaths: { mode: "overwrite", value: ["/tmp/local"] },
      extraDenyReadPaths: { mode: "inherit" },
      extraDenyWritePaths: { mode: "inherit" },
      kernelUnenforcedProtectedPaths: { mode: "inherit" },
    } as const;
    const result = (rows: object[]) => ({ action: "save", rows });
    const harness = createExtensionHarness({
      confirm: true,
      customResults: [
        overviewSectionSelection({ id: "bash" }),
        result([
          {
            id: "bash-0",
            kind: "bash",
            pattern: "echo ask",
            decision: "ask",
            origin: "existing",
          },
        ]),
        overviewSectionSelection({ id: "read" }),
        result([
          {
            id: "read-0",
            kind: "read",
            pattern: "secret.txt",
            decision: "ask",
            contexts: ["read", "grep"],
            origin: "existing",
          },
        ]),
        overviewSectionSelection({ id: "write" }),
        result([
          {
            id: "write-0",
            kind: "write",
            pattern: "output.txt",
            decision: "ask",
            contexts: ["write"],
            origin: "existing",
          },
        ]),
        overviewSectionSelection({ id: "protected" }),
        result([
          {
            id: "protected-0",
            kind: "protected",
            pattern: ".env",
            decision: "deny",
            origin: "existing",
          },
        ]),
        overviewSectionSelection({ id: "sandbox" }),
        { action: "save", draft: customize },
        overviewSectionSelection({ id: "directoryGlobs" }),
        { action: "save", draft: { mode: "set", value: ["/workspace/new"] } },
        submitOverviewSelection,
      ],
    });
    await harness.start();
    await harness.runCommand("profile-edit");

    expect(
      loadRawProfileConfig(configPath)?.profiles["edit-work"],
    ).toMatchObject({
      tools: {
        bash: [
          { pattern: "echo ask", decision: "ask", alternatives: ["echo safe"] },
        ],
        deploy: [{ decision: "deny", match: { target: "release" } }],
      },
      readPaths: [
        { pattern: "secret.txt", decision: "ask", contexts: ["read", "grep"] },
      ],
      writePaths: [
        { pattern: "output.txt", decision: "ask", contexts: ["write"] },
      ],
      protectedPathRules: [{ pattern: ".env", decision: "deny" }],
      sandbox: {
        network: "allow",
        extraWritePaths: ["/tmp/local"],
        overwritePathArrays: ["extraWritePaths"],
      },
      directoryGlobs: ["/workspace/new"],
    });
    expect(harness.ui.confirm).toHaveBeenCalledWith(
      metadataConfirmationTitle({ kind: "sandbox" }),
      expect.any(String),
      expect.anything(),
    );
  });

  it("keeps bytes and activation unchanged for a cancelled or empty /profile-edit, and rejects an external revision", async () => {
    const configPath = writeConfig({
      defaultProfile: "edit-work",
      profiles: {
        "edit-work": { description: "Editable", extends: ["builtin:default"] },
      },
    });
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const noop = createExtensionHarness({
      customResults: [submitOverviewSelection],
    });
    await noop.start();
    const entries = [...noop.entries];
    await noop.runCommand("profile-edit");
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(noop.entries.slice(entries.length)).toHaveLength(1);
    expect(noop.entries.at(-1)).toMatchObject({
      data: { profile: "edit-work" },
    });

    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.runCommand("profile-edit");
    const overview = await harness.ui.waitForProfileAuthoringOverview();
    overview.choose({ selection: overviewSectionSelection({ id: "bash" }) });
    const editor = await harness.ui.waitForRuleForm();
    editor.press("CtrlN");
    editor.type("echo concurrent");
    editor.press("Enter");
    fs.writeFileSync(
      configPath,
      fs
        .readFileSync(configPath, "utf8")
        .replace("Editable", "Changed elsewhere"),
    );
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: submitOverviewSelection,
    });
    const retriedOverview = await harness.ui.waitForProfileAuthoringOverview();
    expect(retriedOverview.render().join("\n")).not.toContain(
      profileAuthoringInvalidMarker,
    );
    harness.ui.sendTerminalInput({ data: "\x03" });
    await pending;
    expect(
      loadRawProfileConfig(configPath)?.profiles["edit-work"].description,
    ).toBe("Changed elsewhere");
    expect(harness.entries).toHaveLength(0);
  });
});
