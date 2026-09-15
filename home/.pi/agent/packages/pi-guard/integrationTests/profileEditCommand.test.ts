import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRawProfileConfig } from "../modules/profileConfig";
import type {
  ProfileAuthoringOverviewSectionId,
  ProfileAuthoringOverviewSelection,
} from "../modules/profileAuthoringOverview";
import {
  generalSectionPresentation,
  metadataConfirmationTitle,
  postSaveActivationFailureMessage,
  profileAuthoringAction,
  profileAuthoringInvalidMarker,
  profileDraftDiscardTitle,
  ruleSectionPresentation,
} from "../modules/profileAuthoringPresentation";
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

const originalConfigPath = process.env.PI_GUARD_PROFILE_CONFIG;
const originalSubagentProfile = process.env.PI_SUBAGENT_PROFILE;
const temporaryDirectories: string[] = [];

function writeConfig(config: object): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-guard-edit-command-"),
  );
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "profiles.jsonc");
  fs.writeFileSync(
    configPath,
    `// Preserve this user-owned comment\n${JSON.stringify(config, null, 2)}\n`,
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
  vi.restoreAllMocks();
  restoreEnvironment();
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

const inheritedSandbox = { mode: "inherit" } as const;
const setDirectories = (value: string[]) => ({
  action: "save",
  draft: { mode: "set", value },
});

describe("/profile-edit public command", () => {
  it("creates a missing Prompt file at commit and can explicitly disable it without security confirmation", async () => {
    const configPath = writeConfig({
      defaultProfile: "edited",
      profiles: {
        edited: {
          description: "Prompt authoring.",
          extends: ["builtin:default"],
        },
      },
    });
    const promptPath = path.join(path.dirname(configPath), "instructions.md");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const createPrompt = harness.runCommand("profile-edit");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: overviewSectionSelection({ id: "prompt" }),
    });
    const prompt = await harness.ui.waitForCustomModal();
    prompt.press("Tab");
    prompt.press("Tab");
    prompt.type(promptPath);
    prompt.press("Enter");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: submitOverviewSelection,
    });
    await createPrompt;

    expect(fs.existsSync(promptPath)).toBe(true);
    expect(loadRawProfileConfig(configPath)?.profiles.edited.promptFile).toBe(
      promptPath,
    );
    expect(harness.ui.confirm).not.toHaveBeenCalled();

    const disablePrompt = harness.runCommand("profile-edit");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: overviewSectionSelection({ id: "prompt" }),
    });
    const disable = await harness.ui.waitForCustomModal();
    disable.press("ArrowLeft");
    disable.press("Enter");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: submitOverviewSelection,
    });
    await disablePrompt;

    expect(
      loadRawProfileConfig(configPath)?.profiles.edited.promptFile,
    ).toBeNull();
    expect(harness.ui.confirm).not.toHaveBeenCalled();
  });

  it("returns from an empty protected section on Escape without mutating config or session", async () => {
    const configPath = writeConfig({
      defaultProfile: "edited",
      profiles: {
        edited: {
          description: "Empty safeguards.",
          emoji: "🧪",
          extends: ["builtin:default"],
        },
      },
    });
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      tuiMode: true,
    });
    await harness.start();
    const entriesBefore = JSON.stringify(harness.entries);

    const pending = harness.runCommand("profile-edit");
    const overview = await harness.ui.waitForProfileAuthoringOverview();
    const renderedOverview = overview.render().join("\n");
    expect(renderedOverview).toContain("Edit profile: 🧪 edited");
    expect(renderedOverview).toContain("✅ Save profile changes");
    // General now leads the editable sections, immediately after Save.
    expect(
      renderedOverview.indexOf(generalSectionPresentation.label),
    ).toBeGreaterThan(
      renderedOverview.indexOf(profileAuthoringAction({ action: "save" })),
    );
    expect(
      renderedOverview.indexOf(generalSectionPresentation.label),
    ).toBeLessThan(
      renderedOverview.indexOf(ruleSectionPresentation.bash.label),
    );
    overview.choose({
      selection: overviewSectionSelection({ id: "protected" }),
    });
    const form = await harness.ui.waitForRuleForm();
    expect(form.render().join("\n")).toContain("No rules in this section");
    form.press("Escape");

    const returnedOverview = await harness.ui.waitForProfileAuthoringOverview();
    expect(returnedOverview.render().join("\n")).toContain(
      "Edit profile: 🧪 edited",
    );
    returnedOverview.cancel();
    await pending;
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(JSON.stringify(harness.entries)).toBe(entriesBefore);
  });

  it("renames, changes emoji, and composes a rule edit atomically while rewriting default and multi-parent references", async () => {
    const configPath = writeConfig({
      defaultProfile: "edited",
      profiles: {
        edited: {
          description: "Editable identity.",
          emoji: "🧪",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: "echo ask", decision: "ask" }] },
        },
        child: {
          description: "References the editable profile twice.",
          extends: ["builtin:default", "edited", "edited"],
        },
        "edited-more": {
          description: "Similarly named parent.",
          extends: ["builtin:default"],
        },
        similarlyNamed: {
          description: "Must not be rewritten.",
          extends: ["edited-more"],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const write = vi.spyOn(fs, "writeFileSync");
    const rename = vi.spyOn(fs, "renameSync");
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.runCommand("profile-edit");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: overviewSectionSelection({ id: "general" }),
    });
    const general = await harness.ui.waitForProfileGeneralForm();
    expect(general.render().join("\n")).toContain("General for 🧪 edited");
    general.press("CtrlU");
    general.type("renamed");
    general.press("ArrowDown");
    general.press("ArrowDown");
    general.press("CtrlU");
    general.type("✨");
    general.press("Enter");

    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: overviewSectionSelection({ id: "bash" }),
    });
    const bash = await harness.ui.waitForRuleForm();
    bash.press("Tab"); // ASK → allow
    bash.press("Enter");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: submitOverviewSelection,
    });
    await pending;

    const saved = loadRawProfileConfig(configPath);
    expect(saved?.defaultProfile).toBe("renamed");
    expect(saved?.profiles.renamed).toMatchObject({
      emoji: "✨",
      tools: { bash: [{ pattern: "echo ask", decision: "allow" }] },
    });
    expect(saved?.profiles.edited).toBeUndefined();
    expect(saved?.profiles.child.extends).toEqual([
      "builtin:default",
      "renamed",
      "renamed",
    ]);
    expect(saved?.profiles.similarlyNamed.extends).toEqual(["edited-more"]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledTimes(1);
  });

  it("does not reopen an already committed draft when post-save activation fails", async () => {
    const configPath = writeConfig({
      defaultProfile: "edited",
      profiles: {
        edited: {
          description: "Before activation failure.",
          extends: ["builtin:default"],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.runCommand("profile-edit");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: overviewSectionSelection({ id: "general" }),
    });
    const general = await harness.ui.waitForProfileGeneralForm();
    general.press("ArrowDown");
    general.press("CtrlU");
    general.type("Persisted before activation failure.");
    general.press("Enter");
    harness.ui.setStatus.mockImplementationOnce(() => {
      throw new Error("status refresh failed");
    });
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: submitOverviewSelection,
    });
    await pending;

    expect(loadRawProfileConfig(configPath)?.profiles.edited.description).toBe(
      "Persisted before activation failure.",
    );
    expect(harness.ui.notify).toHaveBeenCalledWith(
      postSaveActivationFailureMessage({
        profile: "edited",
        error: new Error("status refresh failed"),
      }),
      "error",
    );
  });

  it("keeps a General collision in the visible modal and makes an unchanged General save a write-free no-op", async () => {
    const configPath = writeConfig({
      defaultProfile: "edited",
      profiles: {
        edited: {
          description: "Editable identity.",
          extends: ["builtin:default"],
        },
        taken: {
          description: "Existing identity.",
          extends: ["builtin:default"],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const before = fs.readFileSync(configPath, "utf8");
    const write = vi.spyOn(fs, "writeFileSync");
    const rename = vi.spyOn(fs, "renameSync");
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.runCommand("profile-edit");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: overviewSectionSelection({ id: "general" }),
    });
    const general = await harness.ui.waitForProfileGeneralForm();
    general.press("CtrlU");
    general.type("taken");
    general.press("Enter");
    expect(general.render().join("\n")).toContain("Invalid:");
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    general.press("CtrlU");
    general.type("edited");
    general.press("Enter");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: submitOverviewSelection,
    });
    await pending;

    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(write).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it("edits all rule sections through their visible forms: ASK cycles, row add/remove, clear, Back, and protected constraints", async () => {
    const configPath = writeConfig({
      defaultProfile: "edited",
      profiles: {
        edited: {
          description: "Editable rule matrix.",
          extends: ["builtin:default"],
          tools: { bash: [{ pattern: "echo ask", decision: "ask" }] },
          readPaths: [
            { pattern: "read.txt", decision: "ask", contexts: ["read"] },
          ],
          writePaths: [
            { pattern: "write.txt", decision: "ask", contexts: ["write"] },
          ],
          protectedPathRules: [{ pattern: ".env", decision: "deny" }],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();
    const pending = harness.runCommand("profile-edit");

    let overview = await harness.ui.waitForProfileAuthoringOverview();
    overview.choose({ selection: overviewSectionSelection({ id: "bash" }) });
    let form = await harness.ui.waitForRuleForm();
    expect(form.render().join("\n")).toContain("Local decision  ❓ ASK");
    form.press("Tab");
    form.press("Tab");
    form.press("Tab"); // ASK → allow → deny → ASK
    form.press("CtrlN");
    form.type("echo temporary");
    form.press("CtrlD");
    form.press("Escape"); // Back must retain the unmodified local declaration.

    overview = await harness.ui.waitForProfileAuthoringOverview();
    overview.choose({ selection: overviewSectionSelection({ id: "bash" }) });
    form = await harness.ui.waitForRuleForm();
    expect(form.render().join("\n")).toContain("Local decision  ❓ ASK");
    form.press("CtrlShiftR"); // Explicitly retain an empty local section.

    overview = await harness.ui.waitForProfileAuthoringOverview();
    overview.choose({ selection: overviewSectionSelection({ id: "read" }) });
    form = await harness.ui.waitForRuleForm();
    form.press("Tab"); // ASK → allow
    form.press("CtrlN");
    form.type("temporary.txt");
    form.press("CtrlD");
    form.press("Enter");

    overview = await harness.ui.waitForProfileAuthoringOverview();
    overview.choose({ selection: overviewSectionSelection({ id: "write" }) });
    form = await harness.ui.waitForRuleForm();
    form.press("Tab");
    form.press("Tab"); // ASK → allow → deny
    form.press("Enter");

    overview = await harness.ui.waitForProfileAuthoringOverview();
    overview.choose({
      selection: overviewSectionSelection({ id: "protected" }),
    });
    form = await harness.ui.waitForRuleForm();
    const protectedForm = form.render().join("\n");
    expect(protectedForm).not.toContain("❓ ASK");
    expect(protectedForm).not.toContain("Context          ");
    form.press("Tab"); // Protected rules only alternate allow/deny.
    expect(form.render().join("\n")).not.toContain("❓ ASK");
    form.press("Enter");

    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: submitOverviewSelection,
    });
    await pending;

    const profile = loadRawProfileConfig(configPath)?.profiles.edited;
    expect(profile?.tools?.bash).toEqual([]);
    expect(profile?.readPaths).toEqual([
      { pattern: "read.txt", decision: "allow", contexts: ["read"] },
    ]);
    expect(profile?.writePaths).toEqual([
      { pattern: "write.txt", decision: "deny", contexts: ["write"] },
    ]);
    expect(profile?.protectedPathRules).toEqual([
      { pattern: ".env", decision: "allow" },
    ]);
  });

  it("discards overview drafts and recovers an invalid overlap without writing it", async () => {
    const configPath = writeConfig({
      defaultProfile: "edited",
      profiles: {
        edited: {
          description: "Draft recovery fixture.",
          extends: ["builtin:default"],
        },
      },
    });
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;

    const cancelled = createExtensionHarness({
      customResults: [
        overviewSectionSelection({ id: "sandbox" }),
        { action: "save", draft: inheritedSandbox },
        undefined,
      ],
    });
    await cancelled.start();
    await cancelled.runCommand("profile-edit");
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);

    const invalidRows = [
      {
        id: "read-0",
        kind: "read",
        pattern: "same.txt",
        decision: "ask",
        contexts: ["read"],
        origin: "existing",
      },
      {
        id: "new",
        kind: "read",
        pattern: "same.txt",
        decision: "deny",
        contexts: ["read"],
        origin: "create",
      },
    ];
    const repairedRows = [invalidRows[0]];
    const harness = createExtensionHarness({
      customResults: [
        overviewSectionSelection({ id: "read" }),
        { action: "save", rows: invalidRows },
        submitOverviewSelection,
        { action: "save", rows: repairedRows },
        submitOverviewSelection,
      ],
    });
    await harness.start();
    await harness.runCommand("profile-edit");
    expect(loadRawProfileConfig(configPath)?.profiles.edited.readPaths).toEqual(
      [{ pattern: "same.txt", decision: "ask", contexts: ["read"] }],
    );
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "// Preserve this user-owned comment",
    );
  });

  it("confirms inherited sandbox expansion, retains rejected drafts, and rejects nonidentical directory activation", async () => {
    const configPath = writeConfig({
      defaultProfile: "child",
      profiles: {
        restrictive: {
          description: "Restrictive parent",
          extends: ["builtin:default"],
          sandbox: { network: "deny", extraWritePaths: ["/restricted"] },
        },
        permissive: {
          description: "Permissive parent",
          extends: ["builtin:default"],
          sandbox: { network: "allow", extraWritePaths: ["/permissive"] },
        },
        child: {
          description: "Restrictive child",
          extends: ["restrictive", "permissive"],
          sandbox: { network: "deny", extraWritePaths: ["/child"] },
          directoryGlobs: ["/work/child"],
        },
      },
    });
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      customResults: [
        overviewSectionSelection({ id: "sandbox" }),
        { action: "save", draft: inheritedSandbox },
        submitOverviewSelection,
        submitOverviewSelection,
      ],
    });
    await harness.start();
    harness.ui.confirm
      .mockImplementationOnce(() => {
        expect(fs.readFileSync(configPath, "utf8")).toBe(before);
        return Promise.resolve(false);
      })
      .mockResolvedValueOnce(true);
    await harness.runCommand("profile-edit");

    expect(harness.ui.confirm).toHaveBeenCalledWith(
      metadataConfirmationTitle({ kind: "sandbox" }),
      expect.any(String),
      expect.anything(),
    );
    const profile = loadRawProfileConfig(configPath)?.profiles.child;
    expect(profile?.sandbox).toBeUndefined(); // accept removes the restrictive child declaration.

    const directory = createExtensionHarness({
      interactionScript: [
        {
          kind: "custom",
          response: overviewSectionSelection({ id: "directoryGlobs" }),
        },
        {
          kind: "custom",
          response: setDirectories(["/elsewhere/child"]),
        },
        { kind: "custom", response: submitOverviewSelection },
        {
          kind: "confirm",
          title: metadataConfirmationTitle({ kind: "directoryGlobs" }),
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
    await directory.start();
    await directory.runCommand("profile-edit");
    expect(directory.ui.confirm).toHaveBeenCalledWith(
      metadataConfirmationTitle({ kind: "directoryGlobs" }),
      expect.any(String),
      expect.anything(),
    );
    expect(
      loadRawProfileConfig(configPath)?.profiles.child?.directoryGlobs,
    ).toEqual(["/work/child"]); // rejected broad/nonidentical replacement is not written.
  });

  it.each([
    {
      location: "overview",
      customCalls: 1,
      drive: async (harness: ReturnType<typeof createExtensionHarness>) => {
        (await harness.ui.waitForCustomModal()).press("CtrlC");
      },
    },
    {
      location: "General editor",
      customCalls: 2,
      drive: async (harness: ReturnType<typeof createExtensionHarness>) => {
        (await harness.ui.waitForProfileAuthoringOverview()).choose({
          selection: overviewSectionSelection({ id: "general" }),
        });
        const editor = await harness.ui.waitForProfileGeneralForm();
        editor.press("CtrlU");
        editor.type("retained-general-draft");
        editor.press("CtrlC");
      },
    },
    ...(["prompt", "composition", "transforms"] as const).map((id) => ({
      location: `${id} editor`,
      customCalls: 2,
      drive: async (harness: ReturnType<typeof createExtensionHarness>) => {
        (await harness.ui.waitForProfileAuthoringOverview()).choose({
          selection: overviewSectionSelection({ id }),
        });
        (await harness.ui.waitForCustomModal()).press("CtrlC");
      },
    })),
    ...(["bash", "read", "write", "protected"] as const).map((id) => ({
      location: `${id} editor`,
      customCalls: 2,
      drive: async (harness: ReturnType<typeof createExtensionHarness>) => {
        (await harness.ui.waitForProfileAuthoringOverview()).choose({
          selection: overviewSectionSelection({ id }),
        });
        const editor = await harness.ui.waitForRuleForm();
        editor.press("CtrlN");
        editor.type(`${id}-retained-draft`);
        editor.press("CtrlC");
      },
    })),
    {
      location: "Sandbox editor",
      customCalls: 2,
      drive: async (harness: ReturnType<typeof createExtensionHarness>) => {
        (await harness.ui.waitForProfileAuthoringOverview()).choose({
          selection: overviewSectionSelection({ id: "sandbox" }),
        });
        (await harness.ui.waitForRuleForm()).press("CtrlC");
      },
    },
    {
      location: "Directory editor",
      customCalls: 2,
      drive: async (harness: ReturnType<typeof createExtensionHarness>) => {
        (await harness.ui.waitForProfileAuthoringOverview()).choose({
          selection: overviewSectionSelection({ id: "directoryGlobs" }),
        });
        (await harness.ui.waitForRuleForm()).press("CtrlC");
      },
    },
  ])(
    "aborts /profile-edit from the $location without writing or retrying",
    async ({ drive, customCalls }) => {
      const configPath = writeConfig({
        defaultProfile: "edited",
        profiles: {
          edited: {
            description: "Ctrl+C fixture.",
            extends: ["builtin:default"],
            tools: { bash: [{ pattern: "echo ask", decision: "ask" }] },
            readPaths: [
              { pattern: "read.txt", decision: "ask", contexts: ["read"] },
            ],
            writePaths: [
              { pattern: "write.txt", decision: "ask", contexts: ["write"] },
            ],
            protectedPathRules: [{ pattern: ".env", decision: "deny" }],
            sandbox: { network: "deny" },
            directoryGlobs: ["/work/edited"],
          },
        },
      });
      const before = fs.readFileSync(configPath, "utf8");
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const write = vi.spyOn(fs, "writeFileSync");
      const rename = vi.spyOn(fs, "renameSync");
      const harness = createExtensionHarness({ interactiveUi: true });
      await harness.start();
      const entries = [...harness.entries];
      const statuses = [...harness.ui.setStatus.mock.calls];
      const activeProfile = process.env.PI_GUARD_ACTIVE_PROFILE;

      const pending = harness.runCommand("profile-edit");
      await drive(harness);
      await pending;

      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
      expect(harness.entries).toEqual(entries);
      expect(harness.ui.setStatus.mock.calls).toEqual(statuses);
      expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(activeProfile);
      expect(write).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(harness.ui.notify).not.toHaveBeenCalled();
      expect(harness.ui.custom).toHaveBeenCalledTimes(customCalls);
      vi.restoreAllMocks();
    },
  );

  it.each([
    {
      location: "Sandbox capability expansion confirmation",
      prepare: async (harness: ReturnType<typeof createExtensionHarness>) => {
        (await harness.ui.waitForProfileAuthoringOverview()).choose({
          selection: overviewSectionSelection({ id: "sandbox" }),
        });
        const editor = await harness.ui.waitForRuleForm();
        editor.press("ArrowDown");
        editor.press("ArrowRight"); // network deny → allow
        editor.press("Enter");
      },
    },
    {
      location: "Directory activation confirmation",
      prepare: async (harness: ReturnType<typeof createExtensionHarness>) => {
        (await harness.ui.waitForProfileAuthoringOverview()).choose({
          selection: overviewSectionSelection({ id: "directoryGlobs" }),
        });
        const editor = await harness.ui.waitForRuleForm();
        editor.press("CtrlU");
        editor.type("/elsewhere/edited");
        editor.press("Enter");
      },
    },
  ])(
    "aborts /profile-edit at $location after retaining an edit",
    async ({ prepare }) => {
      const configPath = writeConfig({
        defaultProfile: "edited",
        profiles: {
          edited: {
            description: "Confirmation Ctrl+C fixture.",
            extends: ["builtin:default"],
            sandbox: { network: "deny" },
            directoryGlobs: ["/work/edited"],
          },
        },
      });
      const before = fs.readFileSync(configPath, "utf8");
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      const write = vi.spyOn(fs, "writeFileSync");
      const rename = vi.spyOn(fs, "renameSync");
      const harness = createExtensionHarness({
        interactiveUi: true,
        pendingStockUi: true,
      });
      await harness.start();
      const entries = [...harness.entries];
      const statuses = [...harness.ui.setStatus.mock.calls];
      const activeProfile = process.env.PI_GUARD_ACTIVE_PROFILE;

      const pending = harness.runCommand("profile-edit");
      await prepare(harness);
      (await harness.ui.waitForProfileAuthoringOverview()).choose({
        selection: submitOverviewSelection,
      });
      await harness.ui.waitForConfirmation();
      harness.ui.sendTerminalInput({ data: "\x03" });
      await pending;

      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
      expect(harness.entries).toEqual(entries);
      expect(harness.ui.setStatus.mock.calls).toEqual(statuses);
      expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(activeProfile);
      expect(write).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(harness.ui.notify).not.toHaveBeenCalled();
      // Overview → retained editor → confirmation: Ctrl+C must not reopen
      // either the overview or a rejected-confirmation retry branch.
      expect(harness.ui.custom).toHaveBeenCalledTimes(3);
      vi.restoreAllMocks();
    },
  );

  it("activates the explicitly saved profile after directory edits, unless PI_SUBAGENT_PROFILE is authoritative", async () => {
    const cwd = process.cwd();
    const config = {
      defaultProfile: "edited",
      profiles: {
        winner: {
          description: "Fallback directory winner",
          extends: ["builtin:default"],
          directoryGlobs: [`${path.dirname(cwd)}/**`],
        },
        edited: {
          description: "Explicitly edited profile",
          extends: ["builtin:default"],
          directoryGlobs: [cwd],
        },
        authority: {
          description: "Subagent authority",
          extends: ["builtin:default"],
          directoryGlobs: ["/unmatched-authority"],
        },
      },
    };
    const configPath = writeConfig(config);
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const ranked = createExtensionHarness({
      confirm: true,
      customResults: [
        overviewSectionSelection({ id: "directoryGlobs" }),
        setDirectories([`${cwd}/edited`]),
        submitOverviewSelection,
      ],
    });
    await ranked.start();
    const priorEntries = ranked.entries.length;
    await ranked.runCommand("profile-edit");
    expect(ranked.entries.slice(priorEntries)).toHaveLength(1);
    expect(ranked.entries.at(-1)).toMatchObject({
      data: { profile: "edited" },
    });

    // Load a fresh harness before supplying its per-session authority. The
    // harness deliberately clears only inherited worker authority.
    delete process.env.PI_SUBAGENT_PROFILE;
    vi.resetModules();
    const { createExtensionHarness: createSubagentHarness } =
      await import("./support/extensionHarness");
    process.env.PI_SUBAGENT_PROFILE = "authority";
    const authoritative = createSubagentHarness({
      confirm: true,
      customResults: [
        overviewSectionSelection({ id: "directoryGlobs" }),
        setDirectories([`${cwd}/authority`]),
        submitOverviewSelection,
      ],
    });
    await authoritative.start();
    const authorityEntries = authoritative.entries.length;
    await authoritative.runCommand("profile-edit");
    // The immutable authority wins instead of any directory match.
    expect(authoritative.entries.slice(authorityEntries)).toHaveLength(1);
    expect(authoritative.entries.at(-1)).toMatchObject({
      data: { profile: "authority" },
    });
    expect(authoritative.ui.custom).toHaveBeenCalled();
  });

  it("rejects a rename of the PI_SUBAGENT_PROFILE authority without writing", async () => {
    const configPath = writeConfig({
      defaultProfile: "edited",
      profiles: {
        edited: {
          description: "Authoritative profile.",
          extends: ["builtin:default"],
        },
      },
    });
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    delete process.env.PI_SUBAGENT_PROFILE;
    vi.resetModules();
    const { createExtensionHarness: createSubagentHarness } =
      await import("./support/extensionHarness");
    process.env.PI_SUBAGENT_PROFILE = "edited";
    const harness = createSubagentHarness({
      interactiveUi: true,
      confirm: true,
    });
    await harness.start();
    const write = vi.spyOn(fs, "writeFileSync");
    const rename = vi.spyOn(fs, "renameSync");

    const pending = harness.runCommand("profile-edit");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: overviewSectionSelection({ id: "general" }),
    });
    const general = await harness.ui.waitForProfileGeneralForm();
    general.press("CtrlU");
    general.type("renamed");
    general.press("Enter");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: submitOverviewSelection,
    });
    const invalidGeneral = await harness.ui.waitForProfileGeneralForm();
    expect(invalidGeneral.render().join("\n")).toContain(
      profileAuthoringInvalidMarker,
    );
    invalidGeneral.press("Escape");
    const returnedOverview = await harness.ui.waitForProfileAuthoringOverview();
    returnedOverview.cancel();
    await pending;

    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(write).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(process.env.PI_SUBAGENT_PROFILE).toBe("edited");
  });

  it("persists an inline ASK child while PI_SUBAGENT_PROFILE remains authoritative", async () => {
    const configPath = writeConfig({ profiles: {} });
    // An otherwise empty user config selects the shipped fallback while still
    // providing a user-owned destination for the atomic child creation.
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    // The selected active profile is shipped, so the durable ASK save must
    // create a user-owned child rather than modify the shipped declaration.
    delete process.env.PI_SUBAGENT_PROFILE;
    vi.resetModules();
    const { createExtensionHarness: createSubagentHarness } =
      await import("./support/extensionHarness");
    process.env.PI_SUBAGENT_PROFILE = "builtin:default";
    const harness = createSubagentHarness({ interactiveUi: true });
    await harness.start();
    const entriesBeforeSave = harness.entries.length;

    const pending = harness.callTool({
      toolName: "bash",
      input: { command: "echo remembered-permission" },
    });
    (await harness.ui.waitForPermissionChoice()).choose(
      "Save rule(s) to profile…",
    );
    // A shipped active target saves through the inline ASK rule form, which
    // creates a suggested user-owned child when its accepted rule is saved.
    const editor = await harness.ui.waitForRuleForm();
    editor.press("Enter");
    const general = await harness.ui.waitForProfileGeneralForm();
    expect(general.render().join("\n")).toContain("default-pi-guard");
    general.press("Enter");
    // The authority remains active, so the original request is still ASK and
    // receives the normal retry picker rather than running under the child.
    (await harness.ui.waitForPermissionChoice()).choose("No (default)");
    expect(await pending).toMatchObject({ block: true });

    const savedProfiles = loadRawProfileConfig(configPath)?.profiles ?? {};
    const child = Object.entries(savedProfiles).find(([, profile]) =>
      profile.extends?.includes("builtin:default"),
    );
    expect(child).toBeDefined();
    expect(child?.[1].tools?.bash).toContainEqual({
      pattern: "echo remembered-permission",
      decision: "allow",
    });
    expect(process.env.PI_SUBAGENT_PROFILE).toBe("builtin:default");
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("builtin:default");
    expect(
      JSON.stringify(harness.entries.slice(entriesBeforeSave)),
    ).not.toContain(`"profile":"${child?.[0]}"`);
  });
});
