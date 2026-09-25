import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadRawProfileConfig,
  profileConfigLockSettings,
  setProfileConfigLockWaitForTesting,
} from "../modules/profileConfig";
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
  it("offers destructive Force write after a timeout and preserves the lock and draft when declined", async () => {
    const configPath = writeConfig({
      defaultProfile: "edited",
      profiles: {
        edited: { description: "Before force.", extends: ["builtin:default"] },
      },
    });
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    const promptPath = path.join(
      path.dirname(configPath),
      "declined-force-prompt.md",
    );
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    fs.writeFileSync(lockPath, JSON.stringify({ token: "blocked" }));
    const resetWait = setProfileConfigLockWaitForTesting({ wait: () => {} });
    try {
      const harness = createExtensionHarness({ interactiveUi: true });
      await harness.start();
      const entriesBefore = [...harness.entries];
      const statusesBefore = [...harness.ui.setStatus.mock.calls];
      const activeProfileBefore = process.env.PI_GUARD_ACTIVE_PROFILE;
      const pending = harness.runCommand("profile-edit");
      (await harness.ui.waitForProfileAuthoringOverview()).choose({
        selection: overviewSectionSelection({ id: "general" }),
      });
      const general = await harness.ui.waitForProfileGeneralForm();
      general.press("ArrowDown");
      general.press("CtrlU");
      general.type("Retained force draft.");
      general.press("Enter");
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
      // Declining retains the draft in the retry loop; then exit that retained editor.
      const retainedOverview =
        await harness.ui.waitForProfileAuthoringOverview();
      const retainedOverviewText = retainedOverview.render(1_000).join("\n");
      expect(retainedOverviewText).toContain("Retained force draft.");
      expect(retainedOverviewText).toContain(promptPath);
      harness.ui.sendTerminalInput({ data: "\x03" });
      await pending;
      expect(harness.ui.confirm).toHaveBeenCalledWith(
        "Force write profile?",
        expect.stringContaining("emergency destructive action"),
        expect.anything(),
      );
      expect(harness.ui.confirm).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(fs.existsSync(promptPath)).toBe(false);
      expect(harness.entries).toEqual(entriesBefore);
      expect(harness.ui.setStatus.mock.calls).toEqual(statusesBefore);
      expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(activeProfileBefore);
      // Declining returns to the authoring retry loop rather than discarding the edited draft.
      expect(harness.ui.custom).toHaveBeenCalledTimes(6);
    } finally {
      resetWait();
    }
  });

  it("aborts when Force confirmation returns an abort result without durable effects", async () => {
    const configPath = writeConfig({
      defaultProfile: "edited",
      profiles: {
        edited: { description: "Before force.", extends: ["builtin:default"] },
      },
    });
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    const promptPath = path.join(
      path.dirname(configPath),
      "abort-result-force-prompt.md",
    );
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    fs.writeFileSync(lockPath, JSON.stringify({ token: "blocked" }));
    const resetWait = setProfileConfigLockWaitForTesting({ wait: () => {} });
    try {
      const harness = createExtensionHarness({ interactiveUi: true });
      await harness.start();
      const entriesBefore = [...harness.entries];
      const statusesBefore = [...harness.ui.setStatus.mock.calls];
      const activeProfileBefore = process.env.PI_GUARD_ACTIVE_PROFILE;
      harness.ui.confirm.mockImplementationOnce(() =>
        Promise.resolve(undefined),
      );
      const pending = harness.runCommand("profile-edit");
      (await harness.ui.waitForProfileAuthoringOverview()).choose({
        selection: overviewSectionSelection({ id: "general" }),
      });
      const general = await harness.ui.waitForProfileGeneralForm();
      general.press("ArrowDown");
      general.press("CtrlU");
      general.type("Aborted Force result.");
      general.press("Enter");
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
      // An undefined confirmation response is an abort result, not approval.
      // It must retain the draft and never re-open Force confirmation.
      const retainedOverview =
        await harness.ui.waitForProfileAuthoringOverview();
      expect(retainedOverview.render(1_000).join("\n")).toContain(
        "Aborted Force result.",
      );
      harness.ui.sendTerminalInput({ data: "\x03" });
      await pending;
      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
      expect(fs.existsSync(promptPath)).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(harness.entries).toEqual(entriesBefore);
      expect(harness.ui.setStatus.mock.calls).toEqual(statusesBefore);
      expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(activeProfileBefore);
      expect(harness.ui.confirm).toHaveBeenCalledTimes(1);
      expect(harness.ui.custom).toHaveBeenCalledTimes(6);
    } finally {
      resetWait();
    }
  });

  it("aborts at the active Force confirmation with Ctrl+C without durable effects", async () => {
    const configPath = writeConfig({
      defaultProfile: "edited",
      profiles: {
        edited: { description: "Before force.", extends: ["builtin:default"] },
      },
    });
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    const promptPath = path.join(
      path.dirname(configPath),
      "aborted-force-prompt.md",
    );
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    fs.writeFileSync(lockPath, JSON.stringify({ token: "blocked" }));
    const resetWait = setProfileConfigLockWaitForTesting({ wait: () => {} });
    try {
      const harness = createExtensionHarness({
        interactiveUi: true,
        pendingStockUi: true,
      });
      await harness.start();
      const entriesBefore = [...harness.entries];
      const statusesBefore = [...harness.ui.setStatus.mock.calls];
      const activeProfileBefore = process.env.PI_GUARD_ACTIVE_PROFILE;
      const pending = harness.runCommand("profile-edit");
      (await harness.ui.waitForProfileAuthoringOverview()).choose({
        selection: overviewSectionSelection({ id: "general" }),
      });
      const general = await harness.ui.waitForProfileGeneralForm();
      general.press("ArrowDown");
      general.press("CtrlU");
      general.type("Aborted at Force confirmation.");
      general.press("Enter");
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
      const confirmation = await harness.ui.waitForConfirmation();
      expect(confirmation.title).toBe("Force write profile?");
      harness.ui.sendTerminalInput({ data: "\x03" });
      await pending;
      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
      expect(fs.existsSync(promptPath)).toBe(false);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(harness.entries).toEqual(entriesBefore);
      expect(harness.ui.setStatus.mock.calls).toEqual(statusesBefore);
      expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(activeProfileBefore);
      expect(harness.ui.confirm).toHaveBeenCalledTimes(1);
    } finally {
      resetWait();
    }
  });

  it("retries safely with its retained draft when the observed Force lock disappears before confirmation", async () => {
    const promptName = "disappeared-force-prompt.md";
    const configPath = writeConfig({
      defaultProfile: "edited",
      profiles: {
        edited: { description: "Before force.", extends: ["builtin:default"] },
      },
    });
    const promptPath = path.join(path.dirname(configPath), promptName);
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    const foreignSidecarPath = `${lockPath}${profileConfigLockSettings.ownerSuffix}foreign`;
    const foreignSidecar = JSON.stringify({ token: "foreign" });
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    fs.writeFileSync(lockPath, JSON.stringify({ token: "observed" }));
    fs.writeFileSync(foreignSidecarPath, foreignSidecar);
    const resetWait = setProfileConfigLockWaitForTesting({ wait: () => {} });
    try {
      const harness = createExtensionHarness({ interactiveUi: true });
      await harness.start();
      const entriesBefore = [...harness.entries];
      const statusesBefore = [...harness.ui.setStatus.mock.calls];
      const activeProfileBefore = process.env.PI_GUARD_ACTIVE_PROFILE;
      harness.ui.confirm.mockImplementationOnce((title, message) => {
        expect(title).toBe("Force write profile?");
        expect(message).toContain("emergency destructive action");
        fs.unlinkSync(lockPath);
        return Promise.resolve(true);
      });
      const pending = harness.runCommand("profile-edit");
      (await harness.ui.waitForProfileAuthoringOverview()).choose({
        selection: overviewSectionSelection({ id: "general" }),
      });
      const general = await harness.ui.waitForProfileGeneralForm();
      general.press("ArrowDown");
      general.press("CtrlU");
      general.type("Retained after released lock.");
      general.press("Enter");
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
      const retry = await harness.ui.waitForProfileAuthoringOverview();
      expect(retry.render().join("\n")).toContain(
        "Retained after released lock.",
      );
      expect(harness.ui.notify).toHaveBeenCalledWith(
        "The blocking lock was already released; retry the save normally.",
        "info",
      );
      harness.ui.sendTerminalInput({ data: "\x03" });
      await pending;
      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
      expect(fs.existsSync(promptPath)).toBe(false);
      expect(fs.readFileSync(foreignSidecarPath, "utf8")).toBe(foreignSidecar);
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(harness.entries).toEqual(entriesBefore);
      expect(harness.ui.setStatus.mock.calls).toEqual(statusesBefore);
      expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(activeProfileBefore);
      expect(harness.ui.confirm).toHaveBeenCalledTimes(1);
    } finally {
      resetWait();
    }
  });

  it("preserves a replacement Force lock without config, prompt, activation, or repeated confirmation effects", async () => {
    const promptName = "replacement-force-prompt.md";
    const configPath = writeConfig({
      defaultProfile: "edited",
      profiles: {
        edited: { description: "Before force.", extends: ["builtin:default"] },
      },
    });
    const promptPath = path.join(path.dirname(configPath), promptName);
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    const replacement = JSON.stringify({ token: "replacement" });
    const before = fs.readFileSync(configPath, "utf8");
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    fs.writeFileSync(lockPath, JSON.stringify({ token: "observed" }));
    const resetWait = setProfileConfigLockWaitForTesting({ wait: () => {} });
    try {
      const harness = createExtensionHarness({ interactiveUi: true });
      await harness.start();
      const entriesBefore = [...harness.entries];
      const statusesBefore = [...harness.ui.setStatus.mock.calls];
      const activeProfileBefore = process.env.PI_GUARD_ACTIVE_PROFILE;
      harness.ui.confirm.mockImplementationOnce(() => {
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, replacement);
        return Promise.resolve(true);
      });
      const pending = harness.runCommand("profile-edit");
      (await harness.ui.waitForProfileAuthoringOverview()).choose({
        selection: overviewSectionSelection({ id: "general" }),
      });
      const general = await harness.ui.waitForProfileGeneralForm();
      general.press("ArrowDown");
      general.press("CtrlU");
      general.type("Retained after replacement lock.");
      general.press("Enter");
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
      const retry = await harness.ui.waitForProfileAuthoringOverview();
      expect(retry.render().join("\n")).toContain(
        "Retained after replacement lock.",
      );
      expect(harness.ui.notify).toHaveBeenCalledWith(
        "The blocking lock changed; it was not removed. Retry normally.",
        "info",
      );
      harness.ui.sendTerminalInput({ data: "\x03" });
      await pending;
      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
      expect(fs.existsSync(promptPath)).toBe(false);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(replacement);
      expect(harness.entries).toEqual(entriesBefore);
      expect(harness.ui.setStatus.mock.calls).toEqual(statusesBefore);
      expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(activeProfileBefore);
      expect(harness.ui.confirm).toHaveBeenCalledTimes(1);
    } finally {
      resetWait();
    }
  });

  it("preserves the reviewed revision through accepted Force and reloads a source conflict without durable effects", async () => {
    const promptName = "conflict-force-prompt.md";
    const configPath = writeConfig({
      defaultProfile: "edited",
      profiles: {
        edited: { description: "Before force.", extends: ["builtin:default"] },
      },
    });
    const promptPath = path.join(path.dirname(configPath), promptName);
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    const externalDescription = "External source revision.";
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    fs.writeFileSync(lockPath, JSON.stringify({ token: "observed" }));
    const resetWait = setProfileConfigLockWaitForTesting({ wait: () => {} });
    try {
      const harness = createExtensionHarness({ interactiveUi: true });
      await harness.start();
      const entriesBefore = [...harness.entries];
      const activeProfileBefore = process.env.PI_GUARD_ACTIVE_PROFILE;
      harness.ui.confirm.mockImplementationOnce(() => {
        fs.writeFileSync(
          configPath,
          JSON.stringify({
            defaultProfile: "edited",
            profiles: {
              edited: {
                description: externalDescription,
                extends: ["builtin:default"],
              },
              unrelated: {
                description: "Concurrent unrelated profile.",
                extends: ["builtin:default"],
              },
            },
          }),
        );
        return Promise.resolve(true);
      });
      const pending = harness.runCommand("profile-edit");
      (await harness.ui.waitForProfileAuthoringOverview()).choose({
        selection: overviewSectionSelection({ id: "general" }),
      });
      const general = await harness.ui.waitForProfileGeneralForm();
      general.press("ArrowDown");
      general.press("CtrlU");
      general.type("Retained after revision conflict.");
      general.press("Enter");
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
      const retry = await harness.ui.waitForProfileAuthoringOverview();
      expect(retry.render().join("\n")).toContain(
        "Retained after revision conflict.",
      );
      // The retained draft is now reviewed against the refreshed revision and
      // can commit in this same command; the unrelated external declaration
      // remains present.
      retry.choose({ selection: submitOverviewSelection });
      await pending;
      expect(
        loadRawProfileConfig({ configPath })?.profiles.edited.description,
      ).toBe("Retained after revision conflict.");
      expect(loadRawProfileConfig({ configPath })?.profiles.unrelated).toEqual({
        description: "Concurrent unrelated profile.",
        extends: ["builtin:default"],
      });
      expect(fs.existsSync(promptPath)).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(harness.entries).toHaveLength(entriesBefore.length + 1);
      expect(harness.ui.setStatus.mock.calls).toContainEqual([
        "permissions",
        expect.stringContaining("edited"),
      ]);
      expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe(activeProfileBefore);
      expect(harness.ui.confirm).toHaveBeenCalledTimes(1);
    } finally {
      resetWait();
    }
  });

  it("Force removes the observed lock, then commits after normal reacquisition", async () => {
    const promptName = "successful-force-prompt.md";
    const configPath = writeConfig({
      defaultProfile: "edited",
      profiles: {
        edited: { description: "Before force.", extends: ["builtin:default"] },
      },
    });
    const lockPath = `${configPath}${profileConfigLockSettings.suffix}`;
    const promptPath = path.join(path.dirname(configPath), promptName);
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    fs.writeFileSync(lockPath, JSON.stringify({ token: "blocked" }));
    const resetWait = setProfileConfigLockWaitForTesting({ wait: () => {} });
    try {
      const harness = createExtensionHarness({
        interactiveUi: true,
        confirm: true,
      });
      await harness.start();
      const entriesBefore = [...harness.entries];
      const statusesBefore = [...harness.ui.setStatus.mock.calls];
      const pending = harness.runCommand("profile-edit");
      (await harness.ui.waitForProfileAuthoringOverview()).choose({
        selection: overviewSectionSelection({ id: "general" }),
      });
      const general = await harness.ui.waitForProfileGeneralForm();
      general.press("ArrowDown");
      general.press("CtrlU");
      general.type("Saved after force.");
      general.press("Enter");
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
      await pending;
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(fs.existsSync(promptPath)).toBe(true);
      expect(
        loadRawProfileConfig({ configPath })?.profiles.edited,
      ).toMatchObject({
        description: "Saved after force.",
        promptFile: promptPath,
      });
      expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("edited");
      expect(harness.entries).toHaveLength(entriesBefore.length + 1);
      expect(harness.entries.at(-1)).toMatchObject({
        type: "custom",
        customType: "pi-guard-profile",
        data: { profile: "edited" },
      });
      expect(
        harness.ui.setStatus.mock.calls.slice(statusesBefore.length),
      ).toContainEqual(["permissions", expect.stringContaining("edited")]);
      expect(harness.ui.confirm).toHaveBeenCalledTimes(1);
    } finally {
      resetWait();
    }
  });

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
    expect(
      loadRawProfileConfig({ configPath: configPath })?.profiles.edited
        .promptFile,
    ).toBe(promptPath);
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
      loadRawProfileConfig({ configPath: configPath })?.profiles.edited
        .promptFile,
    ).toBeNull();
    expect(harness.ui.confirm).not.toHaveBeenCalled();
  });

  it("selects builtin:committer compositionally through the public profile-edit command", async () => {
    const configPath = writeConfig({
      defaultProfile: "sidecar",
      profiles: {
        sidecar: {
          description: "Sidecar profile.",
          extends: ["builtin:default"],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({ interactiveUi: true });
    await harness.start();

    const pending = harness.runCommand("profile-edit");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: overviewSectionSelection({ id: "composition" }),
    });
    const editor = await harness.ui.waitForCustomModal();
    editor.press("CtrlN");
    const picker = await harness.ui.waitForCustomModal();
    picker.type("builtin:committer");
    picker.press("Enter");
    const resumedEditor = await harness.ui.waitForCustomModal();
    expect(resumedEditor.render().join("\n")).toContain("builtin:committer");
    // Ctrl+C aborts the command-scoped flow; reaching this editor exercises
    // the composition path that previously crashed while resolving raw config.
    resumedEditor.press("CtrlC");
    await pending;

    expect(
      loadRawProfileConfig({ configPath })?.profiles.sidecar.extends,
    ).toEqual(["builtin:default"]);
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

    const saved = loadRawProfileConfig({ configPath: configPath });
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
    // The immutable owner generation and one config temporary file are written;
    // hard-link publication/release does not rename the lock pathname.
    expect(write).toHaveBeenCalledTimes(2);
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

    expect(
      loadRawProfileConfig({ configPath: configPath })?.profiles.edited
        .description,
    ).toBe("Persisted before activation failure.");
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
    // A no-op still writes/releases an owner generation, but never creates or
    // replaces a configuration temporary file.
    expect(write).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledTimes(0);
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

    const profile = loadRawProfileConfig({ configPath: configPath })?.profiles
      .edited;
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
    expect(
      loadRawProfileConfig({ configPath: configPath })?.profiles.edited
        .readPaths,
    ).toEqual([{ pattern: "same.txt", decision: "ask", contexts: ["read"] }]);
    expect(fs.readFileSync(configPath, "utf8")).toContain(
      "// Preserve this user-owned comment",
    );
  });

  it("lets an inherited restrictive sandbox enter Customize and override its network behavior", async () => {
    const desiredNetwork = "allow";
    const targetProfile = "example-profile-committer-deny-asks";
    const configPath = writeConfig({
      defaultProfile: targetProfile,
      profiles: {
        "example-profile": {
          description: "Restrictive example parent.",
          extends: ["builtin:default"],
          sandbox: { network: "deny" },
        },
        "example-profile-committer": {
          description: "Example profile with Git mutation.",
          extends: ["example-profile", "builtin:committer"],
        },
        [targetProfile]: {
          description: "Non-interactive maintenance committer.",
          extends: ["example-profile-committer"],
          transforms: ["transform:deny-asks"],
        },
      },
    });
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    const harness = createExtensionHarness({
      interactiveUi: true,
      confirm: true,
    });
    await harness.start();

    const pending = harness.runCommand("profile-edit");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: overviewSectionSelection({ id: "sandbox" }),
    });
    const sandbox = await harness.ui.waitForCustomModal();
    expect(sandbox.render().join("\n")).toContain("Mode: inherit");
    sandbox.press("Tab"); // inherit → customize
    sandbox.press("ArrowDown"); // Network
    sandbox.press("Tab"); // inherit → deny
    sandbox.press("ArrowRight"); // deny → allow
    sandbox.press("Enter");
    (await harness.ui.waitForProfileAuthoringOverview()).choose({
      selection: submitOverviewSelection,
    });
    await pending;

    const savedSandbox = loadRawProfileConfig({ configPath })?.profiles[
      targetProfile
    ]?.sandbox;
    if (savedSandbox === undefined || savedSandbox === false)
      throw new Error("profile-edit did not save a sandbox override");
    expect(savedSandbox.network).toBe(desiredNetwork);
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
    const profile = loadRawProfileConfig({ configPath: configPath })?.profiles
      .child;
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
      loadRawProfileConfig({ configPath: configPath })?.profiles.child
        ?.directoryGlobs,
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

  it("rejects an inline ASK persistence attempt for an authoritative built-in profile", async () => {
    const configPath = writeConfig({ profiles: {} });
    // An otherwise empty user config selects the shipped fallback, which is
    // not a user-owned destination for durable ASK decisions.
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
    // The selected active profile is shipped, so persistent saves are
    // rejected instead of creating a child that authority would not select.
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
    expect(await pending).toMatchObject({ block: true });
    expect(harness.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("not user-owned"),
      "error",
    );

    const savedProfiles =
      loadRawProfileConfig({ configPath: configPath })?.profiles ?? {};
    expect(savedProfiles).toEqual({});
    expect(process.env.PI_SUBAGENT_PROFILE).toBe("builtin:default");
    expect(process.env.PI_GUARD_ACTIVE_PROFILE).toBe("builtin:default");
    expect(
      JSON.stringify(harness.entries.slice(entriesBeforeSave)),
    ).not.toContain('"profile":"');
  });
});
