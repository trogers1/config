import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { loadRawProfileConfig } from "../modules/profileConfig";
import { ruleSectionPresentation } from "../modules/profileAuthoringPresentation";
import { createExtensionHarness } from "./support/extensionHarness";
import {
  allowOnceChoice,
  denyChoice,
  installProfileUpdateFixture,
  saveRulesChoice,
  writeConfig,
} from "./support/profileUpdateTestSupport";

installProfileUpdateFixture({});

describe("profile updates through the public extension surface", () => {
  it("drives the production custom permission picker through a durable save", async () => {
    const configPath = writeConfig({
      config: {
        defaultProfile: "tui-work",
        profiles: {
          "tui-work": {
            description: "TUI permission picker fixture.",
            extends: ["builtin:default"],
            tools: { bash: [{ pattern: "echo tui-ask", decision: "ask" }] },
          },
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
      config: {
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
      config: {
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
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    await harness.runCommand("profile-select", "custom-work");

    const deniedPending = harness.callTool({
      toolName: "bash",
      input: { command: "echo remember-deny" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const deniedForm = await harness.ui.waitForRuleForm();
    deniedForm.press("Tab"); // allow → deny
    deniedForm.press("CtrlK");
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
    allowedForm.press("CtrlK");
    allowedForm.type("Use the approved rollout.");
    allowedForm.press("CtrlEnter");
    allowedForm.type("Keep this exact second line.");
    allowedForm.press("Enter");
    await allowedPending;
    const savedProfile = loadRawProfileConfig({
      configPath,
    })?.profiles["custom-work"];
    expect(savedProfile?.tools?.bash).toContainEqual({
      pattern: "echo remember-allow",
      decision: "allow",
      guidance: "Use the approved rollout.\nKeep this exact second line.",
    });
    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command: "echo remember-allow" },
    });
  }, 10_000);

  it("does not save an all-skipped ASK draft and discards only from the permission choice", async () => {
    const configPath = writeConfig({
      config: {
        defaultProfile: "three-tabs-work",
        profiles: {
          "three-tabs-work": {
            description: "Profile for checking the ASK decision cycle.",
            extends: ["builtin:default"],
            tools: { bash: [{ pattern: "echo cycle-me", decision: "ask" }] },
          },
        },
      },
    });
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    await harness.runCommand("profile-select", "three-tabs-work");

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

  it("adds a labelled related rule with changed kind/context in the atomic ASK batch", async () => {
    const configPath = writeConfig({
      config: {
        defaultProfile: "related-work",
        profiles: {
          "related-work": {
            description: "Additional ASK row fixture.",
            extends: ["builtin:default"],
            tools: { bash: [{ pattern: "echo primary", decision: "ask" }] },
          },
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
    editor.press("CtrlShiftK"); // Bash → read path; pattern is focused.
    editor.type("related.txt");
    editor.press("CtrlK"); // pattern → guidance
    editor.type("Use the related workflow.");
    editor.press("CtrlX"); // all read contexts → read
    editor.press("CtrlX"); // read → grep
    expect(editor.render().join("\n")).toContain(
      "Additional profile rule (not required by this ASK)",
    );
    expect(editor.render().join("\n")).toContain("Context          grep");
    expect(editor.render().join("\n")).toContain("ASK → ⛔️ DENY");
    editor.press("Enter");
    await pending;

    const profile = loadRawProfileConfig({ configPath: configPath })?.profiles[
      "related-work"
    ];
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
  }, 10_000);

  it("retains only a skipped direct-path draft after an additional-rule save", async () => {
    const configPath = writeConfig({
      config: {
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
    editor.press("CtrlK");
    editor.type("Retain this request guidance.");
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
    unresolved.press("Escape"); // Back discards edits made after the save.
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const discardedDraft = await harness.ui.waitForRuleForm();
    const discarded = discardedDraft.render().join("\n");
    expect(discarded).toContain("retained");
    expect(discarded).toContain("unchanged; remains ASK");
    expect(discarded).not.toContain("ASK → ⛔️ DENY");
    discardedDraft.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose("No (default)");

    expect(await pending).toMatchObject({ block: true });
    expect(
      loadRawProfileConfig({ configPath: configPath })?.profiles[
        "direct-partial-work"
      ].readPaths,
    ).toContainEqual({
      pattern: "saved-related.txt",
      decision: "deny",
      contexts: ["read"],
    });
  });

  it("re-prompts with only skipped Bash candidates and retains their edits", async () => {
    const configPath = writeConfig({
      config: {
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
    firstEditor.press("CtrlArrowDown");
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
      loadRawProfileConfig({ configPath: configPath })?.profiles["partial-work"]
        .tools?.bash,
    ).toContainEqual({ pattern: "echo first", decision: "allow" });
  }, 10_000);

  it("saves valid ASK row with incomplete skipped addition", async () => {
    const configPath = writeConfig({
      config: {
        defaultProfile: "skip-incomplete-addition",
        profiles: {
          "skip-incomplete-addition": {
            description: "A valid request plus an incomplete skipped addition.",
            extends: ["builtin:default"],
            tools: { bash: [{ pattern: "echo durable", decision: "ask" }] },
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo durable" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    const editor = await harness.ui.waitForRuleForm();
    editor.press("CtrlN"); // blank additional Bash pattern
    editor.press("Tab"); // new ASK additions start deny → skip; its incomplete pattern is irrelevant
    const skippedAddition = editor.render().join("\n");
    expect(skippedAddition).toContain("⚙️ Bash rules · SKIP");
    expect(skippedAddition).not.toContain("Save disabled:");
    editor.press("Enter");

    await expect(pending).resolves.toBeUndefined();
    const rules = loadRawProfileConfig({ configPath })?.profiles[
      "skip-incomplete-addition"
    ].tools?.bash;
    expect(rules).toContainEqual({
      pattern: "echo durable",
      decision: "allow",
    });
    expect(rules).not.toContainEqual({ pattern: "", decision: "skip" });
  });

  it("resets an interactive profile update to exact allow defaults before saving", async () => {
    const configPath = writeConfig({
      config: {
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
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    await harness.runCommand("profile-select", "reset-work");

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
    form.press("CtrlK");
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
});
