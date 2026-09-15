import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExtensionHarness } from "../integrationTests/support/extensionHarness";
import { createProfileAuthoringFlow } from "./profileAuthoringFlow";
import { promptSectionPresentation } from "./profileAuthoringPresentation";
import { editProfilePrompt } from "./profilePromptEditor";

const fixture = {
  profile: "prompt-editor-profile",
  title: promptSectionPresentation.label,
} as const;
const temporaryDirectories: string[] = [];

function temporaryPromptPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-editor-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "instructions.md");
}

function edit({
  harness,
  initial,
  flow,
}: {
  readonly harness: ReturnType<typeof createExtensionHarness>;
  readonly initial:
    | { readonly mode: "inherit" }
    | { readonly mode: "disable" }
    | { readonly mode: "file"; readonly path: string };
  readonly flow?: ReturnType<typeof createProfileAuthoringFlow>;
}) {
  return editProfilePrompt({
    ctx: harness.context,
    custom: flow?.custom,
    initial,
    profile: fixture.profile,
    title: fixture.title,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("profile Prompt editor", () => {
  it("cycles raw inherit, disable, and file modes", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const disabled = edit({ harness, initial: { mode: "inherit" } });
    const disabledModal = await harness.ui.waitForCustomModal();
    disabledModal.press("Tab");
    disabledModal.press("Enter");
    await expect(disabled).resolves.toEqual({
      action: "save",
      draft: { mode: "disable" },
    });

    const promptPath = temporaryPromptPath();
    const file = edit({ harness, initial: { mode: "disable" } });
    const fileModal = await harness.ui.waitForCustomModal();
    fileModal.press("Tab");
    fileModal.type(promptPath);
    fileModal.press("Enter");
    await expect(file).resolves.toEqual({
      action: "save",
      draft: { mode: "file", path: promptPath },
    });
  });

  it("keeps invalid blank and relative paths visible", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = edit({
      harness,
      initial: { mode: "file", path: "" },
    });
    const modal = await harness.ui.waitForCustomModal();
    modal.press("Enter");
    expect(modal.render().join("\n")).toContain("absolute or begin with ~/");
    modal.type("relative.md");
    modal.press("Enter");
    expect(modal.render().join("\n")).toContain("absolute or begin with ~/");
    modal.press("Escape");
    await expect(pending).resolves.toEqual({
      action: "back",
      draft: { mode: "file", path: "relative.md" },
    });
  });

  it("returns a retained file draft on Escape", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const original = temporaryPromptPath();
    const pending = edit({
      harness,
      initial: { mode: "file", path: original },
    });
    const modal = await harness.ui.waitForCustomModal();
    modal.press("CtrlU");
    const replacement = path.join(path.dirname(original), "replacement.md");
    modal.type(replacement);
    modal.press("Escape");
    await expect(pending).resolves.toEqual({
      action: "back",
      draft: { mode: "file", path: replacement },
    });
  });

  it("returns null when the command-scoped flow aborts", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const flow = createProfileAuthoringFlow({ ctx: harness.context });
    const pending = edit({ harness, initial: { mode: "inherit" }, flow });
    await harness.ui.waitForCustomModal();
    harness.ui.sendTerminalInput({ data: "\x03" });
    await expect(pending).resolves.toBeNull();
    flow.dispose();
  });
});
