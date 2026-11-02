import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { CustomToolRule } from "../modules/policyHelpers";
import {
  loadRawProfileConfig,
  profileConfigLockSettings,
  setProfileConfigLockWaitForTesting,
} from "../modules/profileConfig";
import { askPermissionChoices } from "../modules/profileUpdate";
import { createExtensionHarness } from "./support/extensionHarness";
import {
  authorSubagentAllowRule,
  renderedRuleDecisionLabels,
  setRenderedRuleDecisionToAllow,
} from "./support/liveCustomRuleEditorDriver";

const customProfileName = "custom";
const subagentToolName = "subagent";
const subagentInvocation = {
  agent: "reviewer",
  task: "review",
  cwd: "~/Code/config/project",
} as const;
const subagentAllowDeclaration = {
  decision: "allow",
  match: { agent: "*", task: "*", cwd: "~/Code/config/**" },
} as const;
/** Shipped profiles allow subagents; this local catch-all makes them ASK. */
const subagentAskDeclaration = { decision: "ask" } as const;
const createdProfileName = "custom-created";
const createdProfileDescription = "Created with the shared custom editor.";
const opaqueCustomToolName = "opaque-custom-tool";
const opaqueCustomToolInput = {} as const;
const opaqueCustomToolDifferentInput = {
  request: "different nonempty input",
} as const;
const opaqueCustomToolScenarioNames = {
  declinedCatchall:
    "declining the second catch-all consent returns to the permission picker and writes nothing",
  acceptedCatchall:
    "accepting the second catch-all consent persists an allow without match and re-evaluates the original opaque call",
  concurrentRevision:
    "a concurrent revision during second catch-all consent wins over the stale opaque custom-rule save",
} as const;
const broadOpaqueRuleConfirmation = {
  title: "Save broad custom-tool rule?",
  message: `This creates a catch-all rule for ${opaqueCustomToolName} with no input clauses. It can apply to every ${opaqueCustomToolName} request. Save it only if that broad effect is deliberate.`,
} as const;

type OpaqueAllowDeclaration = CustomToolRule & { readonly decision: "allow" };

const directories: string[] = [];
const originalConfigPath = process.env.PI_GUARD_PROFILE_CONFIG;

function writeConfig(config: object): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-guard-custom-ui-"),
  );
  directories.push(directory);
  const configPath = path.join(directory, "profiles.jsonc");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function customProfileFixture({
  description,
  opaqueRules,
}: {
  readonly description: string;
  readonly opaqueRules?:
    | readonly OpaqueAllowDeclaration[]
    | readonly { readonly decision: "deny" }[];
}) {
  return {
    defaultProfile: customProfileName,
    profiles: {
      [customProfileName]: {
        description,
        extends: ["builtin:default"],
        tools: {
          [subagentToolName]: [subagentAskDeclaration],
          ...(opaqueRules === undefined
            ? {}
            : { [opaqueCustomToolName]: opaqueRules }),
        },
      },
    },
  };
}

function expectOpaqueEditorToStartEmpty({
  rendered,
}: {
  readonly rendered: string;
}): void {
  expect(rendered).toContain(`Resolve ASK · ${opaqueCustomToolName}`);
  expect(rendered).toContain("No custom-tool rules. Ctrl+N adds one.");
  expect(rendered).not.toContain("Catch-all (no match clauses)");
  expect(rendered).toContain("(input) cannot be matched and is unconstrained");
  expect(rendered).not.toContain("    Path");
  expect(rendered).not.toContain("    Pattern");
}

async function saveOpaqueCatchallUntilConfirmation({
  harness,
}: {
  readonly harness: ReturnType<typeof createExtensionHarness>;
}) {
  const editor = await harness.ui.waitForRuleForm();
  expectOpaqueEditorToStartEmpty({ rendered: editor.render().join("\n") });

  editor.press("CtrlN");
  const catchall = editor.render().join("\n");
  expect(catchall).toContain("Catch-all (no match clauses)");
  expect(catchall.replace(/\s+/g, " ")).toContain(
    "⚠ Tool-wide catch-all: Save opens a separate confirmation before this rule is persisted.",
  );
  editor.press("Enter");
  return editor;
}

type BroadOpaqueRuleConfirmation = {
  readonly title: string;
  readonly message: string;
  choose: ({ value }: { readonly value: boolean }) => void;
};

function deferBroadOpaqueRuleConfirmation({
  harness,
}: {
  readonly harness: ReturnType<typeof createExtensionHarness>;
}) {
  let confirmation: BroadOpaqueRuleConfirmation | undefined;
  let choose: ((value: boolean) => void) | undefined;
  let confirmationStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    confirmationStarted = resolve;
  });
  harness.ui.confirm.mockImplementationOnce(
    (title: string, message: string) => {
      confirmation = {
        title,
        message,
        choose: ({ value }) => choose?.(value),
      };
      confirmationStarted?.();
      return new Promise<boolean>((resolve) => {
        choose = resolve;
      });
    },
  );

  return {
    async waitForConfirmation(): Promise<BroadOpaqueRuleConfirmation> {
      await started;
      if (confirmation === undefined)
        throw new Error("Broad opaque-rule confirmation was not opened");
      expect(confirmation.title).toBe(broadOpaqueRuleConfirmation.title);
      expect(confirmation.message).toBe(broadOpaqueRuleConfirmation.message);
      return confirmation;
    },
  };
}

async function beginOpaqueCustomToolSave({
  harness,
}: {
  readonly harness: ReturnType<typeof createExtensionHarness>;
}) {
  const pending = harness.callTool({
    toolName: opaqueCustomToolName,
    input: opaqueCustomToolInput,
  });
  const permission = await harness.ui.waitForPermissionChoice();
  const saveProfileChoice = askPermissionChoices[2];
  expect(permission.render().join("\n")).toContain(saveProfileChoice);
  permission.choose(saveProfileChoice);
  const editor = await saveOpaqueCatchallUntilConfirmation({ harness });
  return { pending, editor };
}

afterEach(() => {
  if (originalConfigPath === undefined)
    delete process.env.PI_GUARD_PROFILE_CONFIG;
  else process.env.PI_GUARD_PROFILE_CONFIG = originalConfigPath;
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("shared custom-rule production editor parity", () => {
  it("bounds decision cycling and rejects invalid rendered decisions", () => {
    let cyclePresses = 0;
    const cyclingEditor = {
      press: (key: string) => {
        expect(key).toBe("Tab");
        cyclePresses++;
      },
      render: () => ["→ subagent · DENY"],
    };
    expect(() =>
      setRenderedRuleDecisionToAllow({ editor: cyclingEditor }),
    ).toThrow("did not reach ALLOW");
    expect(cyclePresses).toBe(renderedRuleDecisionLabels.length);

    const invalidEditor = {
      press: () => {
        throw new Error("An invalid decision must not cycle");
      },
      render: () => ["→ subagent · INVALID"],
    };
    expect(() =>
      setRenderedRuleDecisionToAllow({ editor: invalidEditor }),
    ).toThrow("Unexpected rendered rule decision: INVALID");
  });

  it("uses the unchanged live interaction script for inline ASK", async () => {
    const configPath = writeConfig(
      customProfileFixture({ description: "Custom inline rule fixture." }),
    );
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: subagentToolName,
      input: { ...subagentInvocation },
    });
    const permission = await harness.ui.waitForPermissionChoice();
    const saveProfileChoice = askPermissionChoices[2];
    expect(permission.render().join("\n")).toContain(saveProfileChoice);
    permission.choose(saveProfileChoice);

    await authorSubagentAllowRule({ harness, removeInitialRule: true });
    // Saving is not approval: the re-evaluated request matches the new allow.
    await expect(pending).resolves.toBeUndefined();

    expect(
      loadRawProfileConfig({ configPath })?.profiles[customProfileName].tools?.[
        subagentToolName
      ],
    ).toEqual([subagentAskDeclaration, subagentAllowDeclaration]);
    await expect(
      harness.callToolDecisivelyWithoutPrompt({
        toolName: subagentToolName,
        input: { ...subagentInvocation },
      }),
    ).resolves.toBeUndefined();
  });

  it(opaqueCustomToolScenarioNames.declinedCatchall, async () => {
    const configPath = writeConfig(
      customProfileFixture({
        description: "Opaque custom-rule decline fixture.",
      }),
    );
    const sourceBeforeConfirmation = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const broadConsent = deferBroadOpaqueRuleConfirmation({ harness });
    const { pending, editor } = await beginOpaqueCustomToolSave({ harness });
    expect(fs.readFileSync(configPath, "utf8")).toBe(sourceBeforeConfirmation);
    const confirmation = await broadConsent.waitForConfirmation();
    expect(confirmation).not.toBe(editor);
    confirmation.choose({ value: false });

    // Declining keeps the request open; rejecting it then writes nothing.
    const permission = await harness.ui.waitForPermissionChoice();
    permission.choose(askPermissionChoices[0]);
    await expect(pending).resolves.toMatchObject({ block: true });
    expect(fs.readFileSync(configPath, "utf8")).toBe(sourceBeforeConfirmation);
  });

  it(opaqueCustomToolScenarioNames.acceptedCatchall, async () => {
    const configPath = writeConfig(
      customProfileFixture({
        description: "Opaque custom-rule accept fixture.",
      }),
    );
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const broadConsent = deferBroadOpaqueRuleConfirmation({ harness });
    const { pending, editor } = await beginOpaqueCustomToolSave({ harness });
    const confirmation = await broadConsent.waitForConfirmation();
    expect(confirmation).not.toBe(editor);
    confirmation.choose({ value: true });
    await expect(pending).resolves.toBeUndefined();

    const expectedPersistedDeclaration = { decision: "allow" } as const;
    expect(
      loadRawProfileConfig({ configPath })?.profiles[customProfileName].tools?.[
        opaqueCustomToolName
      ],
    ).toEqual([expectedPersistedDeclaration]);
    await expect(
      harness.callToolDecisivelyWithoutPrompt({
        toolName: opaqueCustomToolName,
        input: opaqueCustomToolDifferentInput,
      }),
    ).resolves.toBeUndefined();
  });

  it(opaqueCustomToolScenarioNames.concurrentRevision, async () => {
    const configPath = writeConfig(
      customProfileFixture({
        description: "Opaque custom-rule stale fixture.",
      }),
    );
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const broadConsent = deferBroadOpaqueRuleConfirmation({ harness });
    const { pending, editor } = await beginOpaqueCustomToolSave({ harness });
    const confirmation = await broadConsent.waitForConfirmation();
    expect(confirmation).not.toBe(editor);
    const winningSource = JSON.stringify(
      customProfileFixture({
        description: "Concurrent revision wins.",
        opaqueRules: [{ decision: "deny" }],
      }),
      null,
      2,
    );
    fs.writeFileSync(configPath, winningSource);
    confirmation.choose({ value: true });

    await expect(pending).resolves.toMatchObject({ block: true });
    expect(fs.readFileSync(configPath, "utf8")).toBe(winningSource);
    expect(
      loadRawProfileConfig({ configPath })?.profiles[customProfileName].tools?.[
        opaqueCustomToolName
      ],
    ).toEqual([{ decision: "deny" }]);
  });

  it("warns for a sparse input hole without inventing a clause or catch-all", async () => {
    const configPath = writeConfig(
      customProfileFixture({ description: "Sparse input fixture." }),
    );
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const before = fs.readFileSync(configPath, "utf8");
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.callTool({
      toolName: opaqueCustomToolName,
      input: { values: new Array(1) },
    });
    void pending.catch(() => undefined);
    (await harness.ui.waitForPermissionChoice()).choose(
      askPermissionChoices[2],
    );
    const editor = await harness.ui.waitForRuleForm();
    const screen = editor.render().join("\n");
    expect(screen).toContain("values.0 cannot be matched and is unconstrained");
    expect(screen).toContain("No custom-tool rules. Ctrl+N adds one.");
    expect(screen).not.toContain("Catch-all (no match clauses)");
    expect(screen).not.toContain("    Pattern");
    editor.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose(
      askPermissionChoices[0],
    );
    await expect(pending).resolves.toMatchObject({ block: true });
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  });

  it("offers Allow once and Reject but no Save for an unwritable built-in profile", async () => {
    const configPath = writeConfig({ profiles: {} });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: opaqueCustomToolName,
      input: opaqueCustomToolDifferentInput,
    });
    const permission = await harness.ui.waitForPermissionChoice();
    const rendered = permission.render().join("\n");
    expect(rendered).toContain(askPermissionChoices[0]);
    expect(rendered).toContain(askPermissionChoices[1]);
    expect(rendered).not.toContain(askPermissionChoices[2]);
    permission.choose(askPermissionChoices[1]);
    await expect(pending).resolves.toBeUndefined();
  });

  it("re-evaluates the request after saving, so a more specific deny still blocks it", async () => {
    const deployDeny = {
      decision: "deny",
      guidance: "Production deploys need a release ticket.",
      match: { environment: "production", region: "us" },
    } as const;
    const configPath = writeConfig({
      defaultProfile: customProfileName,
      profiles: {
        [customProfileName]: {
          description: "Save-is-not-approval fixture.",
          extends: ["builtin:default"],
          tools: { deploy: [deployDeny] },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "deploy",
      input: { region: "eu", environment: "production" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      askPermissionChoices[2],
    );
    const editor = await harness.ui.waitForRuleForm();
    // Drop the selected region clause, so the saved allow is broader than the
    // existing deny for us-region production deploys.
    editor.press("CtrlShiftD");
    editor.press("Enter");
    await expect(pending).resolves.toBeUndefined();
    expect(
      loadRawProfileConfig({ configPath })?.profiles[customProfileName].tools
        ?.deploy,
    ).toEqual([
      deployDeny,
      { decision: "allow", match: { environment: "production" } },
    ]);

    const denied = await harness.callTool({
      toolName: "deploy",
      input: { environment: "production", region: "us" },
    });
    expect(denied).toMatchObject({ block: true });
    expect(denied?.reason).toContain(deployDeny.guidance);
  });

  it("shows request values in the editor with terminal controls escaped", async () => {
    const configPath = writeConfig(
      customProfileFixture({ description: "Terminal-safe editor fixture." }),
    );
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const clearScreen = `${String.fromCharCode(0x1b)}[2J`;
    const rightToLeftOverride = String.fromCharCode(0x202e);
    const controlSequenceIntroducer = String.fromCharCode(0x9b);
    const unsafe = {
      url: `https://example.test/${clearScreen}*`,
      label: `safe${rightToLeftOverride}txt.exe`,
      note: `first\nsecond${controlSequenceIntroducer}`,
    };

    const pending = harness.callTool({
      toolName: opaqueCustomToolName,
      input: unsafe,
    });
    // Observe cleanup rejection if a rendering assertion fails before Reject.
    void pending.catch(() => undefined);
    (await harness.ui.waitForPermissionChoice()).choose(
      askPermissionChoices[2],
    );
    const editor = await harness.ui.waitForRuleForm();
    const lines = editor.render();
    const screen = lines.join("\n");
    for (const raw of [
      clearScreen,
      rightToLeftOverride,
      controlSequenceIntroducer,
    ])
      expect(screen).not.toContain(raw);
    expect(lines.some((line) => line.includes("\n"))).toBe(false);
    // SDK cursor markers split the first character from each Input value.
    // Check raw dangerous characters above before stripping terminal metadata.
    const displayed = stripTerminalSequences(screen);
    expect(displayed).toContain("https://example.test/\\u001b[2J*");
    expect(displayed).toContain("safe\\u202etxt.exe");
    expect(displayed).toContain("first\\u000asecond\\u009b");

    editor.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose(
      askPermissionChoices[0],
    );
    await expect(pending).resolves.toMatchObject({ block: true });
  });

  it("returns to the picker after saving a rule that does not match the request", async () => {
    const configPath = writeConfig(
      customProfileFixture({ description: "Save-is-not-approval fixture." }),
    );
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    let settled = false;
    const pending = harness.callTool({
      toolName: "deploy",
      input: { environment: "staging" },
    });
    // Observe both outcomes without creating an unhandled rejecting derivative
    // if an assertion fails and harness cleanup cancels the request.
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    (await harness.ui.waitForPermissionChoice()).choose(
      askPermissionChoices[2],
    );
    const editor = await harness.ui.waitForRuleForm();
    // The prefilled cursor starts before the value: "other-staging".
    editor.type("other-");
    editor.press("Enter");

    const permission = await harness.ui.waitForPermissionChoice();
    expect(
      loadRawProfileConfig({ configPath })?.profiles[customProfileName].tools
        ?.deploy,
    ).toEqual([{ decision: "allow", match: { environment: "other-staging" } }]);
    expect(settled).toBe(false);
    permission.choose(askPermissionChoices[0]);
    await expect(pending).resolves.toMatchObject({ block: true });
  });

  it("returns to the picker when the rule save fails, keeping Allow once", async () => {
    const configPath = writeConfig(
      customProfileFixture({ description: "Failed-save fixture." }),
    );
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const before = fs.readFileSync(configPath, "utf8");
    // A held cooperative lock leaves the file revision unchanged, so the
    // append itself fails rather than the refresh reporting a stale policy.
    fs.writeFileSync(
      `${configPath}${profileConfigLockSettings.suffix}`,
      JSON.stringify({ token: "other-writer" }),
    );
    const resetWait = setProfileConfigLockWaitForTesting({ wait: () => {} });
    try {
      const pending = harness.callTool({
        toolName: "deploy",
        input: { environment: "staging" },
      });
      (await harness.ui.waitForPermissionChoice()).choose(
        askPermissionChoices[2],
      );
      (await harness.ui.waitForRuleForm()).press("Enter");

      const permission = await harness.ui.waitForPermissionChoice();
      expect(harness.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Custom-tool rules were not saved"),
        "error",
      );
      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
      permission.choose(askPermissionChoices[1]);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      resetWait();
    }
  });

  it("reopens only the skipped request row after saving another rule", async () => {
    const configPath = writeConfig(
      customProfileFixture({ description: "Retained skip fixture." }),
    );
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.callTool({
      toolName: "deploy",
      input: { environment: "staging" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      askPermissionChoices[2],
    );
    const editor = await harness.ui.waitForRuleForm();
    // ASK decisions cycle allow → deny → skip.
    editor.press("Tab");
    editor.press("Tab");
    editor.press("CtrlN");
    editor.press("CtrlA");
    editor.type("region");
    editor.press("CtrlK");
    editor.type("eu");
    editor.press("Enter");

    (await harness.ui.waitForPermissionChoice()).choose(
      askPermissionChoices[2],
    );
    const reopened = await harness.ui.waitForRuleForm();
    const screen = reopened.render().join("\n");
    expect(screen).toContain("deploy · SKIP");
    expect(screen).toContain("staging");
    expect(screen).not.toContain("region");
    expect(
      loadRawProfileConfig({ configPath })?.profiles[customProfileName].tools
        ?.deploy,
    ).toEqual([{ decision: "allow", match: { region: "eu" } }]);

    reopened.press("Escape");
    (await harness.ui.waitForPermissionChoice()).choose(
      askPermissionChoices[0],
    );
    await expect(pending).resolves.toMatchObject({ block: true });
  });

  it("persists and reopens multiline custom guidance without dropping an explicit empty value", async () => {
    const configPath = writeConfig({
      defaultProfile: "custom",
      profiles: {
        custom: {
          description: "Multiline custom guidance fixture.",
          extends: ["builtin:default"],
          tools: {
            subagent: [
              {
                decision: "deny",
                guidance: "",
                match: { agent: "reviewer" },
              },
              {
                decision: "deny",
                match: { task: "review" },
              },
            ],
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.runCommand("profile-edit");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: { kind: "section", id: "customTools" },
    });
    const editor = await harness.ui.waitForRuleForm();
    editor.press("CtrlArrowDown");
    editor.press("CtrlK");
    editor.type("first");
    editor.press("ShiftEnter");
    editor.type("second");
    editor.press("Enter");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: { kind: "action", id: "submit" },
    });
    await pending;

    expect(
      loadRawProfileConfig({ configPath })?.profiles.custom.tools?.subagent,
    ).toEqual([
      {
        decision: "deny",
        guidance: "",
        match: { agent: "reviewer" },
      },
      {
        decision: "deny",
        guidance: "first\nsecond",
        match: { task: "review" },
      },
    ]);

    const reopened = harness.runCommand("profile-edit");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: { kind: "section", id: "customTools" },
    });
    const reopenedEditor = await harness.ui.waitForRuleForm();
    expect(reopenedEditor.render().join("\n")).toContain("first");
    expect(reopenedEditor.render().join("\n")).toContain("second");
    reopenedEditor.press("Escape");
    (await harness.ui.waitForProfileAuthoringOverview()).cancel();
    await reopened;
  });

  it("renders migrated multiline deny guidance on single lines and saves it byte-for-byte", async () => {
    const migratedGuidance =
      "Use the repository scripts.\n\nSuggested alternatives:\n- npm test\n- npm run check:all";
    const configPath = writeConfig({
      defaultProfile: "custom",
      profiles: {
        custom: {
          description: "Migrated guidance fixture.",
          extends: ["builtin:default"],
          tools: {
            bash: [
              {
                pattern: "npm exec *",
                decision: "deny",
                guidance: migratedGuidance,
              },
            ],
            subagent: [
              {
                decision: "deny",
                guidance: migratedGuidance,
                match: { agent: "reviewer" },
              },
            ],
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.runCommand("profile-edit");
    for (const id of ["bash", "customTools"] as const) {
      (await harness.ui.waitForProfileAuthoringOverview()).choose({
        selection: { kind: "section", id },
      });
      const editor = await harness.ui.waitForRuleForm();
      const lines = editor.render();
      expect(lines.filter((line) => line.includes("\n"))).toEqual([]);
      for (const guidanceLine of migratedGuidance.split("\n").filter(Boolean))
        expect(lines.some((line) => line.includes(guidanceLine))).toBe(true);
      // Changing the decision re-serializes the row; untouched guidance stays.
      editor.press("Tab");
      editor.press("Enter");
    }
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: { kind: "action", id: "submit" },
    });
    await pending;

    const tools = loadRawProfileConfig({ configPath })?.profiles.custom.tools;
    expect(tools?.bash).toEqual([
      { pattern: "npm exec *", decision: "ask", guidance: migratedGuidance },
    ]);
    expect(tools?.subagent).toEqual([
      {
        decision: "ask",
        guidance: migratedGuidance,
        match: { agent: "reviewer" },
      },
    ]);
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      JSON.stringify(migratedGuidance),
    );
  });

  it("uses the unchanged live interaction script from /profile-edit", async () => {
    const configPath = writeConfig(
      customProfileFixture({ description: "Editable custom rule fixture." }),
    );
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.runCommand("profile-edit");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: { kind: "section", id: "customTools" },
    });
    await authorSubagentAllowRule({ harness });
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: { kind: "action", id: "submit" },
    });
    await pending;

    expect(
      loadRawProfileConfig({ configPath })?.profiles[customProfileName].tools?.[
        subagentToolName
      ],
    ).toEqual([subagentAskDeclaration, subagentAllowDeclaration]);
  });

  it("uses the unchanged live interaction script from an empty /profile-add draft", async () => {
    const configPath = writeConfig({ profiles: {} });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      confirm: true,
    });
    await harness.start();

    const pending = harness.runCommand("profile-add");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: { kind: "section", id: "customTools" },
    });
    await authorSubagentAllowRule({ harness });
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: { kind: "section", id: "general" },
    });
    const general = await harness.ui.waitForProfileGeneralForm();
    general.press("CtrlU");
    general.type(createdProfileName);
    general.press("ArrowDown");
    general.press("CtrlU");
    general.type(createdProfileDescription);
    general.press("Enter");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: { kind: "action", id: "submit" },
    });
    await pending;

    expect(
      loadRawProfileConfig({ configPath })?.profiles[createdProfileName]
        .tools?.[subagentToolName],
    ).toEqual([subagentAllowDeclaration]);
  });
});
