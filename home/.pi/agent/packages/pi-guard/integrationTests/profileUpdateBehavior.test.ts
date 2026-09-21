import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPathContexts, type PathContext } from "../modules/policyHelpers";
import {
  loadRawProfileConfig,
  resolveProfileConfigPath,
} from "../modules/profileConfig";
import {
  clearSandboxCaches,
  setSandboxBackendForTesting,
  type SandboxBackend,
  type SandboxSpec,
} from "../modules/sandbox.lib";
import {
  metadataConfirmationTitle,
  profileAuthoringInvalidMarker,
  ruleSectionPresentation,
} from "../modules/profileAuthoringPresentation";
import { askPermissionChoices } from "../modules/profileUpdate";
import type { ProfileAuthoringOverviewSelection } from "../modules/profileAuthoringOverview";
import { setGuardOperationObserverForTesting } from "../extensions/guard";
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
const originalActiveProfile = process.env.PI_GUARD_ACTIVE_PROFILE;
const originalHome = process.env.HOME;
const [denyChoice, allowOnceChoice, saveRulesChoice] = askPermissionChoices;
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

function replaceConfig({
  configPath,
  config,
}: {
  readonly configPath: string;
  readonly config: object;
}): void {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function profileWithBashRule({
  profile = "current",
  command,
  decision,
  description = "Cross-instance profile",
}: {
  readonly profile?: string;
  readonly command: string;
  readonly decision: "allow" | "ask" | "deny";
  readonly description?: string;
}): object {
  return {
    defaultProfile: profile,
    profiles: {
      [profile]: {
        description,
        extends: ["builtin:default"],
        tools: { bash: [{ pattern: command, decision }] },
      },
    },
  };
}

const durableDecisions = ["allow", "deny"] as const;
type DurableDecision = (typeof durableDecisions)[number];
type RunningHarness = ReturnType<typeof createExtensionHarness>;

type OrdinaryPathScenario = {
  readonly toolName: "read";
  readonly input: { readonly path: string };
  readonly path: string;
};
type CustomToolScenario = {
  readonly toolName: "deploy";
  readonly input: { readonly environment: "staging" };
};

function ordinaryPathScenario({
  path,
}: {
  readonly path: string;
}): OrdinaryPathScenario {
  return { toolName: "read", input: { path }, path };
}

function customToolScenario(): CustomToolScenario {
  return { toolName: "deploy", input: { environment: "staging" } };
}

function profileWithOrdinaryPathRule({
  path: requestedPath,
  decision,
}: {
  readonly path: string;
  readonly decision: "allow" | "ask" | "deny";
}): object {
  return {
    defaultProfile: "current",
    profiles: {
      current: {
        description: "Shared ordinary-path profile",
        extends: ["builtin:default"],
        readPaths: [{ pattern: requestedPath, decision, contexts: ["read"] }],
      },
    },
  };
}

function profileWithCustomToolRule({
  decision,
}: {
  readonly decision: "allow" | "ask" | "deny";
}): object {
  return {
    defaultProfile: "current",
    profiles: {
      current: {
        description: "Shared custom-tool profile",
        extends: ["builtin:default"],
        tools: { deploy: [{ decision, match: { environment: "staging" } }] },
      },
    },
  };
}

async function saveBashDecision({
  harness,
  command,
  decision,
}: {
  readonly harness: RunningHarness;
  readonly command: string;
  readonly decision: DurableDecision;
}): Promise<void> {
  const pending = harness.callTool({ toolName: "bash", input: { command } });
  (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
  const editor = await harness.ui.waitForRuleForm();
  if (decision === "deny") editor.press("Tab");
  editor.press("Enter");
  await pending;
}

async function saveOrdinaryPathDecision({
  harness,
  scenario,
  decision,
}: {
  readonly harness: RunningHarness;
  readonly scenario: OrdinaryPathScenario;
  readonly decision: DurableDecision;
}): Promise<void> {
  const pending = harness.callTool(scenario);
  (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
  const editor = await harness.ui.waitForRuleForm();
  if (decision === "deny") editor.press("Tab");
  editor.press("Enter");
  await pending;
}

function expectDecision({
  result,
  decision,
}: {
  readonly result: { readonly block?: boolean } | undefined;
  readonly decision: DurableDecision;
}): void {
  expect(result?.block ?? false).toBe(decision === "deny");
}

function restoreEnvironment(): void {
  if (originalConfigPath === undefined)
    delete process.env.PI_GUARD_PROFILE_CONFIG;
  else process.env.PI_GUARD_PROFILE_CONFIG = originalConfigPath;
  if (originalSubagentProfile === undefined)
    delete process.env.PI_SUBAGENT_PROFILE;
  else process.env.PI_SUBAGENT_PROFILE = originalSubagentProfile;
  if (originalActiveProfile === undefined)
    delete process.env.PI_GUARD_ACTIVE_PROFILE;
  else process.env.PI_GUARD_ACTIVE_PROFILE = originalActiveProfile;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
}

function recordingSandboxBackend({
  prepared,
}: {
  readonly prepared: SandboxSpec[];
}): SandboxBackend {
  return {
    probe: () => Promise.resolve({ supported: true }),
    prepare: (spec) => {
      prepared.push(spec);
      return Promise.resolve({
        backend: "fake",
        report: {
          uncoveredRestrictions: [],
          waivedRestrictions: [],
          untranslatedAllows: [],
          noKernelMeaning: [],
        },
        denialSignatures: [],
        operations: { exec: () => Promise.resolve({ exitCode: 0 }) },
        dispose: () => Promise.resolve(),
      });
    },
    dispose: () => Promise.resolve(),
  };
}

afterEach(async () => {
  setGuardOperationObserverForTesting({ observer: undefined });
  restoreEnvironment();
  setSandboxBackendForTesting(undefined);
  await clearSandboxCaches();
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
      loadRawProfileConfig({ configPath: configPath })?.profiles["partial-work"]
        .tools?.bash,
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
      loadRawProfileConfig({ configPath: configPath })?.profiles["read-work"]
        .readPaths,
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
      loadRawProfileConfig({ configPath: configPath })?.profiles[
        "absolute-identity-work"
      ].readPaths,
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
      loadRawProfileConfig({ configPath: configPath })?.profiles["broaden-work"]
        .writePaths,
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

      const profile = loadRawProfileConfig({ configPath: configPath })
        ?.profiles["context-work"];
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
      loadRawProfileConfig({ configPath: configPath })?.profiles["cd-work"]
        .readPaths,
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
      loadRawProfileConfig({ configPath: configPath })?.profiles[
        "read-write-boundary"
      ].readPaths,
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
      loadRawProfileConfig({ configPath: configPath })?.profiles[
        "write-read-boundary"
      ].writePaths,
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
      loadRawProfileConfig({ configPath: configPath })?.profiles[
        "three-candidates"
      ].tools?.bash,
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
      loadRawProfileConfig({ configPath: configPath })?.profiles["glob-child"]
        .writePaths,
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
    const profile = loadRawProfileConfig({ configPath: configPath })?.profiles[
      "combined-allow-work"
    ];
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
    const persisted = loadRawProfileConfig({ configPath: configPath })
      ?.profiles["both-work"];
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
      loadRawProfileConfig({ configPath: configPath })?.profiles["edit-work"],
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
      loadRawProfileConfig({ configPath: configPath })?.profiles["edit-work"]
        .description,
    ).toBe("Changed elsewhere");
    expect(harness.entries).toHaveLength(0);
  });

  it("discards a stale picker answer when a newer allow makes the operation effective", async () => {
    const configPath = writeConfig({
      defaultProfile: "current",
      profiles: {
        current: {
          description: "Current",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: "echo stale-picker", decision: "ask" }] },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo stale-picker" },
    });
    const picker = await harness.ui.waitForPermissionChoice();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        defaultProfile: "current",
        profiles: {
          current: {
            description: "Current",
            extends: ["builtin:default"],
            tools: {
              bash: [{ pattern: "echo stale-picker", decision: "allow" }],
            },
          },
        },
      }),
    );
    picker.choose(denyChoice);
    expect(await pending).toBeUndefined();
    expect(harness.ui.custom).toHaveBeenCalledTimes(1);
  });

  it("discards a stale rule-editor submission when a newer deny takes precedence", async () => {
    const configPath = writeConfig({
      defaultProfile: "current",
      profiles: {
        current: {
          description: "Current",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: "echo stale-editor", decision: "ask" }] },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo stale-editor" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
    const editor = await harness.ui.waitForRuleForm();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        defaultProfile: "current",
        profiles: {
          current: {
            description: "Current",
            extends: ["builtin:default"],
            tools: {
              bash: [{ pattern: "echo stale-editor", decision: "deny" }],
            },
          },
        },
      }),
    );
    editor.press("Enter");
    expect(await pending).toMatchObject({ block: true });
    expect(harness.ui.custom).toHaveBeenCalledTimes(2);
    expect(
      loadRawProfileConfig({ configPath })?.profiles.current.tools?.bash,
    ).toEqual([{ pattern: "echo stale-editor", decision: "deny" }]);
  });

  it("propagates writer allow and deny decisions to already-running parent and sibling instances", async () => {
    const profile = "shared-running";
    const commandFor = (decision: "allow" | "deny") =>
      `echo shared-${decision}`;
    const configPath = writeConfig({
      defaultProfile: profile,
      profiles: {
        [profile]: {
          description: "Shared mutable profile",
          extends: ["builtin:default"],
          tools: {
            bash: [
              { pattern: commandFor("allow"), decision: "ask" },
              { pattern: commandFor("deny"), decision: "ask" },
            ],
          },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const writer = createExtensionHarness({ interactiveUi: true });
    const parent = createExtensionHarness({ hasUI: false });
    const sibling = createExtensionHarness({ hasUI: false });
    await Promise.all([writer.start(), parent.start(), sibling.start()]);

    for (const decision of ["allow", "deny"] as const) {
      const command = commandFor(decision);
      const save = writer.callTool({
        toolName: "bash",
        input: { command },
      });
      (await writer.ui.waitForPermissionChoice()).choose(saveRulesChoice);
      const editor = await writer.ui.waitForRuleForm();
      if (decision === "deny") editor.press("Tab");
      editor.press("Enter");
      const writerResult = await save;
      expect(writerResult?.block ?? false).toBe(decision === "deny");

      for (const observer of [parent, sibling]) {
        const result = await observer.callToolDecisivelyWithoutPrompt({
          toolName: "bash",
          input: { command },
        });
        expect(result?.block ?? false).toBe(decision === "deny");
      }
    }
  });

  it("refreshes inherited parent policy in an already-running child tool call", async () => {
    const command = "echo inherited-refresh";
    const config = (decision: "allow" | "deny") => ({
      defaultProfile: "child",
      profiles: {
        parent: {
          description: "Parent",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: command, decision }] },
        },
        child: { description: "Child", extends: ["parent"] },
      },
    });
    const configPath = writeConfig(config("allow"));
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const child = createExtensionHarness({ hasUI: false });
    await child.start();
    await child.callToolWithoutPrompt({ toolName: "bash", input: { command } });

    replaceConfig({ configPath, config: config("deny") });
    expect(
      await child.callToolDecisivelyWithoutPrompt({
        toolName: "bash",
        input: { command },
      }),
    ).toMatchObject({ block: true });
  });

  it("fails closed across running instances for deleted and malformed adopted sources, then recovers coherently", async () => {
    const command = "echo restored-source";
    const config = profileWithBashRule({ command, decision: "allow" });
    const configPath = writeConfig(config);
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const parent = createExtensionHarness({ hasUI: false });
    const sibling = createExtensionHarness({ hasUI: false });
    await Promise.all([parent.start(), sibling.start()]);

    for (const replacement of [undefined, "{ malformed"] as const) {
      if (replacement === undefined) fs.rmSync(configPath);
      else fs.writeFileSync(configPath, replacement);
      for (const observer of [parent, sibling]) {
        expect(
          await observer.callTool({ toolName: "bash", input: { command } }),
        ).toMatchObject({ block: true });
        expect(observer.ui.setStatus).toHaveBeenCalledWith(
          "permissions",
          "invalid-permissions",
        );
        expect(observer.ui.setStatus).toHaveBeenCalledWith(
          "sandbox",
          "sandbox: blocked (invalid permissions)",
        );
      }
      replaceConfig({ configPath, config });
      for (const observer of [parent, sibling]) {
        await observer.callToolWithoutPrompt({
          toolName: "bash",
          input: { command },
        });
      }
      expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("current");
    }
  });

  it("adopts the resolved DEFAULT path across running instances, fails closed after deletion, and recovers the built-in profile", async () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-guard-default-home-"),
    );
    temporaryDirectories.push(home);
    process.env.HOME = home;
    delete process.env.PI_GUARD_PROFILE_CONFIG;
    const configPath = resolveProfileConfigPath({});
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const config = { defaultProfile: "builtin:default", profiles: {} };
    const command = "pwd";
    replaceConfig({ configPath, config });
    const parent = createExtensionHarness({ hasUI: false });
    const sibling = createExtensionHarness({ hasUI: false });
    await Promise.all([parent.start(), sibling.start()]);
    for (const observer of [parent, sibling])
      await observer.callToolWithoutPrompt({
        toolName: "bash",
        input: { command },
      });

    fs.rmSync(configPath);
    for (const observer of [parent, sibling]) {
      const result = await observer.callTool({
        toolName: "bash",
        input: { command },
      });
      expect(result?.block).toBe(true);
      expect(observer.ui.setStatus).toHaveBeenCalledWith(
        "permissions",
        "invalid-permissions",
      );
    }
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBeUndefined();

    replaceConfig({ configPath, config });
    for (const observer of [parent, sibling]) {
      await observer.callToolWithoutPrompt({
        toolName: "bash",
        input: { command },
      });
      expect(observer.ui.setStatus).toHaveBeenCalledWith(
        "permissions",
        expect.stringContaining("builtin:default"),
      );
    }
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("builtin:default");
  });

  it("clears each running sandbox cache on failed-source recovery instead of reusing its stale prepared config", async () => {
    const command = "echo sandbox-cache-recovery";
    const prepared: SandboxSpec[] = [];
    setSandboxBackendForTesting(recordingSandboxBackend({ prepared }));
    const config = {
      defaultProfile: "sandboxed",
      profiles: {
        sandboxed: {
          description: "Sandbox cache fixture",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: command, decision: "allow" }] },
          sandbox: { network: "deny" },
        },
      },
    };
    const configPath = writeConfig(config);
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const parent = createExtensionHarness({ hasUI: false });
    const sibling = createExtensionHarness({ hasUI: false });
    await Promise.all([parent.start(), sibling.start()]);
    expect(prepared).toHaveLength(1);

    fs.rmSync(configPath);
    for (const observer of [parent, sibling]) {
      const result = await observer.callTool({
        toolName: "bash",
        input: { command },
      });
      expect(result?.block).toBe(true);
      expect(observer.ui.setStatus).toHaveBeenCalledWith(
        "sandbox",
        "sandbox: blocked (invalid permissions)",
      );
    }
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBeUndefined();

    replaceConfig({ configPath, config });
    for (const observer of [parent, sibling]) {
      await observer.callToolWithoutPrompt({
        toolName: "bash",
        input: { command },
      });
      expect(observer.ui.setStatus).toHaveBeenCalledWith(
        "sandbox",
        "sandbox: fake 🔐",
      );
      expect(observer.ui.setStatus).toHaveBeenCalledWith(
        "permissions",
        expect.stringContaining("sandboxed"),
      );
    }
    // Both already-running instances prepare a fresh resolution after their
    // own failed state; a stale pre-failure cache would leave this at one.
    expect(prepared).toHaveLength(3);
    expect(prepared.every(({ network }) => network === "deny")).toBe(true);
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("sandboxed");
  });

  it("preserves an explicitly activated non-directory profile across unchanged guarded operations", async () => {
    const command = "echo explicit-profile-persists";
    const cwd = process.cwd();
    const configPath = writeConfig({
      defaultProfile: "directory-profile",
      profiles: {
        "directory-profile": {
          description: "Directory authority",
          extends: ["builtin:default"],
          directoryGlobs: [cwd],
          tools: { bash: [{ pattern: command, decision: "deny" }] },
        },
        "explicit-profile": {
          description: "Explicit user selection",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: command, decision: "allow" }] },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ hasUI: false, contextCwd: cwd });
    await harness.start();
    await harness.runCommand("profile", "explicit-profile");

    for (let operation = 0; operation < 3; operation++) {
      await harness.callToolWithoutPrompt({
        toolName: "bash",
        input: { command },
      });
      expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("explicit-profile");
      expect(harness.ui.setStatus).toHaveBeenLastCalledWith(
        "permissions",
        expect.stringContaining("explicit-profile"),
      );
      expect(harness.entries.at(-1)).toMatchObject({
        data: { profile: "explicit-profile" },
      });
    }
  });

  it("keeps a durable ASK save and its next operation on the active user-owned profile", async () => {
    const command = "echo save-active-profile";
    const cwd = process.cwd();
    const configPath = writeConfig({
      defaultProfile: "directory-profile",
      profiles: {
        "directory-profile": {
          description: "Directory authority",
          extends: ["builtin:default"],
          directoryGlobs: [cwd],
          tools: { bash: [{ pattern: command, decision: "deny" }] },
        },
        "active-profile": {
          description: "ASK owner",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: command, decision: "ask" }] },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      contextCwd: cwd,
    });
    await harness.start();
    await harness.runCommand("profile", "active-profile");

    const pending = harness.callTool({ toolName: "bash", input: { command } });
    (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
    (await harness.ui.waitForRuleForm()).press("Enter");
    await pending;

    expect(
      loadRawProfileConfig({ configPath })?.profiles["active-profile"].tools
        ?.bash,
    ).toEqual([{ pattern: command, decision: "allow" }]);
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("active-profile");
    expect(harness.entries.at(-1)).toMatchObject({
      data: { profile: "active-profile" },
    });
    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command },
    });
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("active-profile");
  });

  it("keeps a durable ASK save coherent while its post-write cache transition is paused", async () => {
    const command = "echo save-transition-coherence";
    const cwd = process.cwd();
    const configPath = writeConfig({
      defaultProfile: "directory-profile",
      profiles: {
        "directory-profile": {
          description: "Directory authority that must never win this save.",
          extends: ["builtin:default"],
          directoryGlobs: [cwd],
          tools: { bash: [{ pattern: command, decision: "deny" }] },
        },
        "active-profile": {
          description: "User-owned durable ASK owner.",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: command, decision: "ask" }] },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      contextCwd: cwd,
    });
    await harness.start();
    await harness.runCommand("profile", "active-profile");
    const statusCountAfterActivation = harness.ui.setStatus.mock.calls.length;

    let releaseCacheTransition: (() => void) | undefined;
    let signalCacheTransition: () => void = () => undefined;
    const cacheTransitionStarted = new Promise<void>((resolve) => {
      signalCacheTransition = resolve;
    });
    const cacheTransition = new Promise<void>((resolve) => {
      releaseCacheTransition = resolve;
    });
    let pauseNextDisposal = true;
    setSandboxBackendForTesting({
      probe: () => Promise.resolve({ supported: true }),
      prepare: () =>
        Promise.resolve({
          backend: "fake",
          report: {
            uncoveredRestrictions: [],
            waivedRestrictions: [],
            untranslatedAllows: [],
            noKernelMeaning: [],
          },
          denialSignatures: [],
          operations: { exec: () => Promise.resolve({ exitCode: 0 }) },
          dispose: () => Promise.resolve(),
        }),
      dispose: () => {
        if (!pauseNextDisposal) return Promise.resolve();
        pauseNextDisposal = false;
        signalCacheTransition();
        return cacheTransition;
      },
    });

    const saved = harness.callTool({ toolName: "bash", input: { command } });
    (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
    (await harness.ui.waitForRuleForm()).press("Enter");
    await cacheTransitionStarted;

    const statusesBeforeRelease = harness.ui.setStatus.mock.calls.slice(
      statusCountAfterActivation,
    );
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("active-profile");
    expect(statusesBeforeRelease).not.toContainEqual([
      "permissions",
      expect.stringContaining("directory-profile"),
    ]);

    // Explicit boundary markers make this independent of the sandbox module's
    // own lifecycle queue: the concurrent call has requested refresh, but
    // cannot begin policy evaluation until the paused post-save transition is
    // released.
    const entries: string[] = [];
    setGuardOperationObserverForTesting({
      observer: {
        onRefreshRequested: ({ toolName }) => {
          if (toolName === "bash") entries.push("refresh-requested");
        },
        onRefreshStarted: ({ toolName }) => {
          if (toolName === "profile-refresh") entries.push("refresh-started");
        },
        onEvaluationStarted: ({ toolName }) => {
          if (toolName === "bash") entries.push("evaluation-started");
        },
      },
    });
    const concurrent = harness.callTool({
      toolName: "bash",
      input: { command },
    });
    // Request observation is synchronous. Entering the locked refresh is not:
    // it remains queued behind the paused post-save transition.
    expect(entries).toEqual(["refresh-requested"]);
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("active-profile");

    releaseCacheTransition?.();
    await saved;
    expect(await concurrent).toBeUndefined();
    expect(entries).toEqual([
      "refresh-requested",
      "refresh-started",
      "evaluation-started",
      "refresh-requested",
      "refresh-started",
      "evaluation-started",
    ]);

    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("active-profile");
    expect(harness.ui.setStatus).toHaveBeenLastCalledWith(
      "permissions",
      expect.stringContaining("active-profile"),
    );
    expect(harness.entries.at(-1)).toMatchObject({
      data: { profile: "active-profile" },
    });
  });

  it("fails closed for a rejected post-save disposal, blocks queued work, and rebuilds on recovery", async () => {
    const command = "echo rejected-transition";
    const prepared: SandboxSpec[] = [];
    let rejectNextDisposal = false;
    let signalDisposalStarted: () => void = () => undefined;
    const disposalStarted = new Promise<void>((resolve) => {
      signalDisposalStarted = resolve;
    });
    let rejectTransition: (reason: Error) => void = () => undefined;
    const rejectedTransition = new Promise<void>((_resolve, reject) => {
      rejectTransition = reject;
    });
    setSandboxBackendForTesting({
      probe: () => Promise.resolve({ supported: true }),
      prepare: (spec) => {
        prepared.push(spec);
        return Promise.resolve({
          backend: "fake",
          report: {
            uncoveredRestrictions: [],
            waivedRestrictions: [],
            untranslatedAllows: [],
            noKernelMeaning: [],
          },
          denialSignatures: [],
          operations: { exec: () => Promise.resolve({ exitCode: 0 }) },
          dispose: () => Promise.resolve(),
        });
      },
      dispose: () => {
        if (!rejectNextDisposal) return Promise.resolve();
        rejectNextDisposal = false;
        signalDisposalStarted();
        return rejectedTransition;
      },
    });
    const configPath = writeConfig({
      defaultProfile: "sandboxed",
      profiles: {
        sandboxed: {
          description: "Disposal-recovery fixture",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: command, decision: "ask" }] },
          sandbox: { network: "deny" },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      contextCwd: process.cwd(),
    });
    await harness.start();
    expect(prepared).toHaveLength(1);

    rejectNextDisposal = true;
    const saving = harness.callTool({ toolName: "bash", input: { command } });
    (await harness.ui.waitForPermissionChoice()).choose(saveRulesChoice);
    (await harness.ui.waitForRuleForm()).press("Enter");
    await disposalStarted;

    const queued = harness.callTool({ toolName: "bash", input: { command } });
    rejectTransition(new Error("dispose rejected once"));
    expect(await saving).toMatchObject({ block: true });
    const queuedResult = await queued;
    expect(queuedResult).toMatchObject({ block: true });
    expect(queuedResult?.reason).toContain("dispose rejected once");
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBeUndefined();
    expect(harness.ui.setStatus).toHaveBeenCalledWith(
      "sandbox",
      "sandbox: blocked (invalid permissions)",
    );
    expect(harness.ui.setStatus).toHaveBeenCalledWith(
      "permissions",
      "invalid-permissions",
    );

    await harness.callToolWithoutPrompt({
      toolName: "bash",
      input: { command },
    });
    expect(prepared).toHaveLength(2);
    expect(prepared.at(-1)?.network).toBe("deny");
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("sandboxed");
    expect(harness.ui.setStatus).toHaveBeenLastCalledWith(
      "permissions",
      expect.stringContaining("sandboxed"),
    );
  });

  it("re-resolves removed default and directory authorities from one replacement revision", async () => {
    const command = "echo authority-replacement";
    const cwd = process.cwd();
    const initial = {
      defaultProfile: "old",
      profiles: {
        old: {
          description: "Old",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: command, decision: "deny" }] },
          directoryGlobs: [cwd],
        },
      },
    };
    const replacement = {
      defaultProfile: "replacement",
      profiles: {
        replacement: {
          description: "Replacement",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: command, decision: "allow" }] },
          directoryGlobs: [cwd],
        },
      },
    };
    const configPath = writeConfig(initial);
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const running = createExtensionHarness({ hasUI: false, contextCwd: cwd });
    await running.start();
    expect(
      await running.callToolDecisivelyWithoutPrompt({
        toolName: "bash",
        input: { command },
      }),
    ).toMatchObject({ block: true });

    replaceConfig({ configPath, config: replacement });
    await running.callToolWithoutPrompt({
      toolName: "bash",
      input: { command },
    });
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("replacement");
  });

  it.each(["allow", "deny"] as const)(
    "applies a newer %s policy while denial guidance input is pending",
    async (decision) => {
      const command = `echo guidance-newer-${decision}`;
      const configPath = writeConfig(
        profileWithBashRule({ command, decision: "ask" }),
      );
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const parent = createExtensionHarness({ interactiveUi: true });
      let submitGuidance: (value: string | undefined) => void = () => undefined;
      const guidanceInput = new Promise<string | undefined>((resolve) => {
        submitGuidance = resolve;
      });
      parent.ui.editor.mockImplementationOnce(() => guidanceInput);
      const writer = createExtensionHarness({ interactiveUi: true });
      await Promise.all([parent.start(), writer.start()]);
      const pending = parent.callTool({ toolName: "bash", input: { command } });
      (await parent.ui.waitForPermissionChoice()).choose(denyChoice);
      await saveBashDecision({ harness: writer, command, decision });
      submitGuidance("obsolete guidance");

      const result = await pending;
      if (decision === "deny") {
        expect(result).toMatchObject({ block: true });
        expect(result?.reason).not.toContain("obsolete guidance");
      } else expect(result).toBeUndefined();
    },
  );

  it("re-evaluates the immutable Bash command when a protected path changes during ASK", async () => {
    const command = "echo protected > protected-after-ask.txt";
    const configPath = writeConfig(
      profileWithBashRule({ command, decision: "ask" }),
    );
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const running = createExtensionHarness({ interactiveUi: true });
    await running.start();
    const pending = running.callTool({ toolName: "bash", input: { command } });
    const picker = await running.ui.waitForPermissionChoice();
    replaceConfig({
      configPath,
      config: {
        ...profileWithBashRule({ command, decision: "ask" }),
        profiles: {
          current: {
            description: "Protected after prompt",
            extends: ["builtin:default"],
            tools: { bash: [{ pattern: command, decision: "ask" }] },
            protectedPathRules: [
              { pattern: "protected-after-ask.txt", decision: "deny" },
            ],
          },
        },
      },
    });
    picker.choose(allowOnceChoice);
    const result = await pending;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("protected-path policy");
  });

  it("keeps PI_SUBAGENT_PROFILE authoritative and fails closed when it is deleted", async () => {
    const command = "echo authoritative-profile";
    const configPath = writeConfig({
      defaultProfile: "other",
      profiles: {
        authoritative: {
          description: "Authoritative",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: command, decision: "allow" }] },
        },
        other: {
          description: "Other",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: command, decision: "deny" }] },
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    process.env.PI_SUBAGENT_PROFILE = "authoritative";
    const running = createExtensionHarness({ hasUI: false });
    await running.start();
    await running.callToolWithoutPrompt({
      toolName: "bash",
      input: { command },
    });

    replaceConfig({
      configPath,
      config: profileWithBashRule({
        profile: "other",
        command,
        decision: "deny",
      }),
    });
    const result = await running.callTool({
      toolName: "bash",
      input: { command },
    });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("Invalid");
  });

  it("fails closed after bounded repeated revisions without recursively accepting stale prompts", async () => {
    const command = "echo bounded-stale-revisions";
    const configPath = writeConfig(
      profileWithBashRule({ command, decision: "ask" }),
    );
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const running = createExtensionHarness({ interactiveUi: true });
    await running.start();
    const pending = running.callTool({ toolName: "bash", input: { command } });
    for (let revision = 0; revision < 4; revision++) {
      const picker = await running.ui.waitForPermissionChoice();
      replaceConfig({
        configPath,
        config: profileWithBashRule({
          command,
          decision: "ask",
          description: `Cross-instance profile revision ${revision}`,
        }),
      });
      picker.choose(allowOnceChoice);
    }
    const result = await pending;
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("changed repeatedly");
    expect(running.ui.custom).toHaveBeenCalledTimes(4);
  });

  it.each(durableDecisions)(
    "discards a cross-instance stale picker answer after a newer %s decision",
    async (decision) => {
      const command = `echo picker-newer-${decision}`;
      const configPath = writeConfig(
        profileWithBashRule({ command, decision: "ask" }),
      );
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const parent = createExtensionHarness({ interactiveUi: true });
      const writer = createExtensionHarness({ interactiveUi: true });
      await Promise.all([parent.start(), writer.start()]);

      const pending = parent.callTool({ toolName: "bash", input: { command } });
      const stalePicker = await parent.ui.waitForPermissionChoice();
      await saveBashDecision({ harness: writer, command, decision });
      stalePicker.choose(denyChoice);

      // The answer was made visible before the writer committed, then is
      // discarded when the running parent checks the shared source again.
      const result = await pending;
      if (decision === "deny") expect(result).toMatchObject({ block: true });
      else expect(result).toBeUndefined();
      expect(parent.ui.custom).toHaveBeenCalledTimes(1);
      expect(
        loadRawProfileConfig({ configPath })?.profiles.current.tools?.bash,
      ).toEqual([{ pattern: command, decision }]);
    },
  );

  it.each(durableDecisions)(
    "discards a cross-instance stale durable editor after a newer %s decision",
    async (decision) => {
      const command = `echo editor-newer-${decision}`;
      const configPath = writeConfig(
        profileWithBashRule({ command, decision: "ask" }),
      );
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const parent = createExtensionHarness({ interactiveUi: true });
      const writer = createExtensionHarness({ interactiveUi: true });
      await Promise.all([parent.start(), writer.start()]);

      const pending = parent.callTool({ toolName: "bash", input: { command } });
      (await parent.ui.waitForPermissionChoice()).choose(saveRulesChoice);
      const staleEditor = await parent.ui.waitForRuleForm();
      await saveBashDecision({ harness: writer, command, decision });
      staleEditor.press("Enter");

      const result = await pending;
      if (decision === "deny") expect(result).toMatchObject({ block: true });
      else expect(result).toBeUndefined();
      expect(parent.ui.custom).toHaveBeenCalledTimes(2);
      expect(
        loadRawProfileConfig({ configPath })?.profiles.current.tools?.bash,
      ).toEqual([{ pattern: command, decision }]);
    },
  );

  it.each(durableDecisions)(
    "propagates a newer ordinary-path %s decision to already-running parent and sibling instances",
    async (decision) => {
      const scenario = ordinaryPathScenario({
        path: `shared-path-${decision}.txt`,
      });
      const configPath = writeConfig(
        profileWithOrdinaryPathRule({ path: scenario.path, decision: "ask" }),
      );
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const writer = createExtensionHarness({ interactiveUi: true });
      const parent = createExtensionHarness({ hasUI: false });
      const sibling = createExtensionHarness({ hasUI: false });
      await Promise.all([writer.start(), parent.start(), sibling.start()]);

      await saveOrdinaryPathDecision({ harness: writer, scenario, decision });
      for (const observer of [parent, sibling]) {
        expectDecision({
          result: await observer.callToolDecisivelyWithoutPrompt(scenario),
          decision,
        });
      }
    },
  );

  it.each(durableDecisions)(
    "propagates a newer custom-tool %s decision to already-running parent and sibling instances",
    async (decision) => {
      const scenario = customToolScenario();
      const configPath = writeConfig(
        profileWithCustomToolRule({ decision: "ask" }),
      );
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const parent = createExtensionHarness({ hasUI: false });
      const sibling = createExtensionHarness({ hasUI: false });
      await Promise.all([parent.start(), sibling.start()]);

      // Custom-tool policy has no durable editor. A real shared source revision
      // is still observed by both already-running production harnesses.
      replaceConfig({
        configPath,
        config: profileWithCustomToolRule({ decision }),
      });
      for (const observer of [parent, sibling]) {
        expectDecision({
          result: await observer.callToolDecisivelyWithoutPrompt(scenario),
          decision,
        });
      }
    },
  );

  it.each(durableDecisions)(
    "discards an ordinary-path pending picker answer after a newer %s revision",
    async (decision) => {
      const scenario = ordinaryPathScenario({
        path: `picker-path-${decision}.txt`,
      });
      const configPath = writeConfig(
        profileWithOrdinaryPathRule({ path: scenario.path, decision: "ask" }),
      );
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const parent = createExtensionHarness({ interactiveUi: true });
      const writer = createExtensionHarness({ interactiveUi: true });
      await Promise.all([parent.start(), writer.start()]);

      const pending = parent.callTool(scenario);
      const stalePicker = await parent.ui.waitForPermissionChoice();
      await saveOrdinaryPathDecision({ harness: writer, scenario, decision });
      stalePicker.choose(denyChoice);
      expectDecision({ result: await pending, decision });
      expect(parent.ui.custom).toHaveBeenCalledTimes(1);
    },
  );

  it.each(durableDecisions)(
    "discards a custom-tool pending picker answer after a newer %s revision",
    async (decision) => {
      const scenario = customToolScenario();
      const configPath = writeConfig(
        profileWithCustomToolRule({ decision: "ask" }),
      );
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const parent = createExtensionHarness({ interactiveUi: true });
      const writer = createExtensionHarness({ hasUI: false });
      await Promise.all([parent.start(), writer.start()]);

      const pending = parent.callTool(scenario);
      const stalePicker = await parent.ui.waitForPermissionChoice();
      replaceConfig({
        configPath,
        config: profileWithCustomToolRule({ decision }),
      });
      stalePicker.choose(denyChoice);
      expectDecision({ result: await pending, decision });
      expect(parent.ui.custom).toHaveBeenCalledTimes(1);
    },
  );

  it("rebuilds an ordinary-path editor from the N+1 ASK revision and never persists stale edits", async () => {
    const scenario = ordinaryPathScenario({ path: "immutable-request.txt" });
    const configPath = writeConfig(
      profileWithOrdinaryPathRule({ path: scenario.path, decision: "ask" }),
    );
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const parent = createExtensionHarness({ interactiveUi: true });
    await parent.start();

    const pending = parent.callTool(scenario);
    (await parent.ui.waitForPermissionChoice()).choose(saveRulesChoice);
    const staleEditor = await parent.ui.waitForRuleForm();
    staleEditor.press("CtrlA");
    staleEditor.type("stale-pattern.txt");
    staleEditor.press("Tab"); // allow → deny
    staleEditor.press("ArrowDown");
    staleEditor.type("stale guidance");
    staleEditor.press("CtrlN");
    staleEditor.type("stale-added.txt");

    // N+1 deliberately remains ASK for the immutable original operation.
    replaceConfig({
      configPath,
      config: profileWithOrdinaryPathRule({
        path: scenario.path,
        decision: "ask",
      }),
    });
    staleEditor.press("Enter");

    const refreshedPicker = await parent.ui.waitForPermissionChoice();
    refreshedPicker.choose(saveRulesChoice);
    const refreshedEditor = await parent.ui.waitForRuleForm();
    const refreshed = refreshedEditor.render().join("\n");
    expect(refreshed).toContain(scenario.path);
    expect(refreshed).not.toContain("stale-pattern.txt");
    expect(refreshed).not.toContain("stale guidance");
    expect(refreshed).not.toContain("stale-added.txt");
    refreshedEditor.press("Tab"); // deny the immutable original request
    refreshedEditor.press("Enter");

    const result = await pending;
    expect(result).toMatchObject({ block: true });
    expect(result?.reason).not.toContain("stale guidance");
    expect(
      loadRawProfileConfig({ configPath })?.profiles.current.readPaths,
    ).toEqual([
      { pattern: scenario.path, decision: "deny", contexts: ["read"] },
    ]);
  });

  it.each(durableDecisions)(
    "discards an ordinary-path pending durable editor after a newer %s revision",
    async (decision) => {
      const scenario = ordinaryPathScenario({
        path: `editor-path-${decision}.txt`,
      });
      const configPath = writeConfig(
        profileWithOrdinaryPathRule({ path: scenario.path, decision: "ask" }),
      );
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const parent = createExtensionHarness({ interactiveUi: true });
      const writer = createExtensionHarness({ interactiveUi: true });
      await Promise.all([parent.start(), writer.start()]);

      const pending = parent.callTool(scenario);
      (await parent.ui.waitForPermissionChoice()).choose(saveRulesChoice);
      const staleEditor = await parent.ui.waitForRuleForm();
      await saveOrdinaryPathDecision({ harness: writer, scenario, decision });
      staleEditor.press("Enter");
      expectDecision({ result: await pending, decision });
      expect(parent.ui.custom).toHaveBeenCalledTimes(2);
      expect(
        loadRawProfileConfig({ configPath })?.profiles.current.readPaths,
      ).toEqual([{ pattern: scenario.path, decision, contexts: ["read"] }]);
    },
  );
});
