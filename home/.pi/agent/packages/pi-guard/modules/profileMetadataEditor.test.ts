import { describe, expect, it } from "vitest";
import { createExtensionHarness } from "../integrationTests/support/extensionHarness";
import {
  editDirectoryGlobs,
  editSandboxDeclaration,
  isConservativelyBroadDirectoryActivation,
  summarizeSandboxSecurityExpansion,
} from "./profileMetadataEditor";
import { metadataSectionPresentation } from "./profileAuthoringPresentation";
import { createProfileAuthoringFlow } from "./profileAuthoringFlow";

describe("profile metadata section editors", () => {
  it("mounts one directory editor, preserves multirow focus, and saves rows", async () => {
    const harness = createExtensionHarness({
      interactiveUi: true,
      tuiMode: true,
    });
    const pending = editDirectoryGlobs({
      ctx: harness.context,
      initial: undefined,
      startupCwd: "/trusted/project",
      title: metadataSectionPresentation.directoryGlobs.label,
    });
    const modal = await harness.ui.waitForCustomModal();
    expect(harness.ui.custom).toHaveBeenCalledTimes(1);
    const lines = modal.render(500);
    const rendered = lines.join("\n");
    const presentation = metadataSectionPresentation.directoryGlobs;
    const purpose = lines.findIndex((line) =>
      line.includes(presentation.purpose),
    );
    const examples = lines.findIndex((line) =>
      line.includes(presentation.examples),
    );
    const syntax = lines.findIndex((line) =>
      line.includes(presentation.syntax),
    );
    const controls = lines.findIndex((line) => line.includes("Enter save"));
    expect(rendered).toContain(presentation.label);
    expect(lines[1]).toBe("");
    expect(lines[purpose - 1]).toBe("");
    expect(lines[examples - 1]).toBe("");
    expect(syntax).toBe(examples + 1);
    expect(lines[controls - 1]).toBe("");
    modal.press("CtrlN");
    modal.type("/trusted/other");
    modal.press("ArrowUp");
    modal.press("ArrowDown");
    modal.press("Enter");
    await expect(pending).resolves.toEqual({
      action: "save",
      draft: { mode: "set", value: ["/trusted/project", "/trusted/other"] },
    });
  });

  it("renders one arrow for an empty directory row added with Ctrl+N", async () => {
    const harness = createExtensionHarness({
      interactiveUi: true,
      tuiMode: true,
    });
    const pending = editDirectoryGlobs({
      ctx: harness.context,
      initial: { mode: "omit" },
      startupCwd: "/ignored",
      title: metadataSectionPresentation.directoryGlobs.label,
    });
    const modal = await harness.ui.waitForCustomModal();

    modal.press("CtrlN");
    const inputRow = modal.render().find((line) => line.startsWith("→ "));
    expect(inputRow).toBeDefined();
    expect(inputRow).toMatch(/^→ (?![→>])/u);
    expect(inputRow).not.toContain("> >");

    modal.type("/workspace/client");
    modal.press("Backspace");
    modal.type("t");
    modal.press("Enter");
    await expect(pending).resolves.toEqual({
      action: "save",
      draft: { mode: "set", value: ["/workspace/client"] },
    });
  });

  it("shows directory validation errors and keeps the draft editable", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editDirectoryGlobs({
      ctx: harness.context,
      initial: { mode: "set", value: ["/ok"] },
      startupCwd: "/ignored",
      title: metadataSectionPresentation.directoryGlobs.label,
    });
    const modal = await harness.ui.waitForCustomModal();
    modal.press("CtrlU");
    modal.type("relative");
    modal.press("Enter");
    expect(modal.render().join("\n")).toContain("Invalid:");
    modal.press("CtrlU");
    modal.type("/recovered");
    modal.press("Enter");
    await expect(pending).resolves.toEqual({
      action: "save",
      draft: { mode: "set", value: ["/recovered"] },
    });
  });

  it("prefills only a trusted CREATE first open and leaves UPDATE raw omission empty", async () => {
    const createHarness = createExtensionHarness({ interactiveUi: true });
    const createPending = editDirectoryGlobs({
      ctx: createHarness.context,
      initial: undefined,
      startupCwd: "relative",
      title: metadataSectionPresentation.directoryGlobs.label,
    });
    const createModal = await createHarness.ui.waitForCustomModal();
    expect(createModal.render().join("\n")).toContain(
      "No Startup Directory globs: declaration will be omitted.",
    );
    createModal.press("Escape");
    await expect(createPending).resolves.toEqual({
      action: "back",
      draft: { mode: "omit" },
    });

    const updateHarness = createExtensionHarness({
      interactiveUi: true,
      contextCwd: "/ctx/must-not-inject",
    });
    const updatePending = editDirectoryGlobs({
      ctx: updateHarness.context,
      initial: { mode: "omit" },
      startupCwd: "/startup/must-not-inject",
      title: metadataSectionPresentation.directoryGlobs.label,
    });
    const updateModal = await updateHarness.ui.waitForCustomModal();
    expect(updateModal.render().join("\n")).toContain(
      "No Startup Directory globs: declaration will be omitted.",
    );
    updateModal.press("Escape");
    await expect(updatePending).resolves.toEqual({
      action: "back",
      draft: { mode: "omit" },
    });
  });

  it("root-aborts empty directory and scalar sandbox forms only through the authoring adapter", async () => {
    const directoryHarness = createExtensionHarness({ interactiveUi: true });
    const directoryFlow = createProfileAuthoringFlow({
      ctx: directoryHarness.context,
    });
    const directory = editDirectoryGlobs({
      ctx: directoryHarness.context,
      initial: { mode: "omit" },
      startupCwd: "/ignored",
      title: metadataSectionPresentation.directoryGlobs.label,
      custom: directoryFlow.custom,
    });
    const directoryModal = await directoryHarness.ui.waitForCustomModal();
    directoryModal.press("CtrlC");
    await expect(directory).resolves.toBeNull();
    expect(directoryFlow.signal.aborted).toBe(true);
    directoryFlow.dispose();

    const sandboxHarness = createExtensionHarness({ interactiveUi: true });
    const sandboxFlow = createProfileAuthoringFlow({
      ctx: sandboxHarness.context,
    });
    const sandbox = editSandboxDeclaration({
      ctx: sandboxHarness.context,
      initial: { mode: "inherit" },
      resolvedParent: { network: "allow" },
      title: `${metadataSectionPresentation.sandbox.label} declaration`,
      custom: sandboxFlow.custom,
    });
    const sandboxModal = await sandboxHarness.ui.waitForCustomModal();
    sandboxModal.press("CtrlC");
    await expect(sandbox).resolves.toBeNull();
    expect(sandboxFlow.signal.aborted).toBe(true);
    sandboxFlow.dispose();
  });

  it("keeps Ctrl+C and Escape local without the authoring adapter", async () => {
    const directoryHarness = createExtensionHarness({ interactiveUi: true });
    const directory = editDirectoryGlobs({
      ctx: directoryHarness.context,
      initial: { mode: "omit" },
      startupCwd: "/ignored",
      title: metadataSectionPresentation.directoryGlobs.label,
    });
    const directoryModal = await directoryHarness.ui.waitForCustomModal();
    let directorySettled = false;
    void directory.then(() => {
      directorySettled = true;
    });
    directoryModal.press("CtrlC");
    await Promise.resolve();
    expect(directorySettled).toBe(false);
    directoryModal.press("Escape");
    await expect(directory).resolves.toEqual({
      action: "back",
      draft: { mode: "omit" },
    });

    const sandboxHarness = createExtensionHarness({ interactiveUi: true });
    const sandbox = editSandboxDeclaration({
      ctx: sandboxHarness.context,
      initial: { mode: "inherit" },
      resolvedParent: { network: "allow" },
      title: `${metadataSectionPresentation.sandbox.label} declaration`,
    });
    const sandboxModal = await sandboxHarness.ui.waitForCustomModal();
    let sandboxSettled = false;
    void sandbox.then(() => {
      sandboxSettled = true;
    });
    sandboxModal.press("CtrlC");
    await Promise.resolve();
    expect(sandboxSettled).toBe(false);
    sandboxModal.press("Escape");
    await expect(sandbox).resolves.toMatchObject({
      action: "back",
      draft: { mode: "inherit" },
    });
  });

  it("edits raw sandbox modes and canonicalizes an empty append while retaining empty overwrite", async () => {
    const appendHarness = createExtensionHarness({ interactiveUi: true });
    const appendPending = editSandboxDeclaration({
      ctx: appendHarness.context,
      initial: { mode: "inherit" },
      resolvedParent: { network: "allow" },
      title: `${metadataSectionPresentation.sandbox.label} declaration`,
    });
    const appendModal = await appendHarness.ui.waitForCustomModal();
    const lines = appendModal.render(500);
    const rendered = lines.join("\n");
    const presentation = metadataSectionPresentation.sandbox;
    const purpose = lines.findIndex((line) =>
      line.includes(presentation.purpose),
    );
    const examples = lines.findIndex((line) =>
      line.includes(presentation.examples),
    );
    const syntax = lines.findIndex((line) =>
      line.includes(presentation.syntax),
    );
    const mode = lines.findIndex((line) => line.includes("Mode: inherit"));
    const controls = lines.findIndex((line) => line.includes("Tab cycles"));
    expect(rendered).toContain(`${presentation.label} declaration`);
    expect(lines[1]).toBe("");
    expect(lines[purpose - 1]).toBe("");
    expect(lines[examples - 1]).toBe("");
    expect(syntax).toBe(examples + 1);
    expect(lines[mode - 1]).toBe("");
    expect(lines[controls - 1]).toBe("");
    appendModal.press("Tab");
    for (let index = 0; index < 6; index++) appendModal.press("ArrowDown");
    appendModal.press("Tab");
    appendModal.press("Enter");
    await expect(appendPending).resolves.toMatchObject({
      action: "save",
      draft: { mode: "customize", extraWritePaths: { mode: "inherit" } },
    });

    const overwriteHarness = createExtensionHarness({ interactiveUi: true });
    const overwritePending = editSandboxDeclaration({
      ctx: overwriteHarness.context,
      initial: { mode: "inherit" },
      resolvedParent: { network: "allow" },
      title: `${metadataSectionPresentation.sandbox.label} declaration`,
    });
    const overwriteModal = await overwriteHarness.ui.waitForCustomModal();
    overwriteModal.press("Tab");
    for (let index = 0; index < 6; index++) overwriteModal.press("ArrowDown");
    overwriteModal.press("Tab");
    overwriteModal.press("Tab");
    overwriteModal.press("Enter");
    await expect(overwritePending).resolves.toMatchObject({
      action: "save",
      draft: {
        mode: "customize",
        extraWritePaths: { mode: "overwrite", value: [] },
      },
    });
  });

  it("renders one arrow for an empty sandbox path row added with Ctrl+N", async () => {
    const harness = createExtensionHarness({
      interactiveUi: true,
      tuiMode: true,
    });
    const pending = editSandboxDeclaration({
      ctx: harness.context,
      initial: { mode: "inherit" },
      resolvedParent: { network: "allow" },
      title: `${metadataSectionPresentation.sandbox.label} declaration`,
    });
    const modal = await harness.ui.waitForCustomModal();

    modal.press("Tab");
    for (let index = 0; index < 6; index++) modal.press("ArrowDown");
    modal.press("Tab");
    modal.press("CtrlN");
    const inputRow = modal.render().find((line) => line.startsWith("    → "));
    expect(inputRow).toBeDefined();
    expect(inputRow).toMatch(/^    → (?![→>])/u);
    expect(inputRow).not.toContain("> >");

    modal.type("/workspace/write");
    modal.press("Backspace");
    modal.type("e");
    modal.press("Enter");
    await expect(pending).resolves.toMatchObject({
      action: "save",
      draft: {
        mode: "customize",
        extraWritePaths: { mode: "append", value: ["/workspace/write"] },
      },
    });
  });

  it("shows read-only parent context and supports scalar inherit removal", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editSandboxDeclaration({
      ctx: harness.context,
      initial: { mode: "inherit" },
      resolvedParent: {
        network: "deny",
        allowLocalBinding: true,
        allowAppleEvents: false,
      },
      title: `${metadataSectionPresentation.sandbox.label} declaration`,
    });
    const modal = await harness.ui.waitForCustomModal();
    expect(modal.render().join("\n")).toContain(
      "Parent context: network deny; local listeners on",
    );
    modal.press("Tab");
    modal.press("ArrowDown");
    modal.press("Tab");
    modal.press("Tab");
    modal.press("Enter");
    await expect(pending).resolves.toMatchObject({
      action: "save",
      draft: { mode: "inherit" },
    });
  });

  it("blocks Customize when the effective sandbox lacks network", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editSandboxDeclaration({
      ctx: harness.context,
      initial: { mode: "inherit" },
      resolvedParent: { network: "deny" },
      title: `${metadataSectionPresentation.sandbox.label} declaration`,
    });
    const modal = await harness.ui.waitForCustomModal();
    modal.press("Tab");
    expect(modal.render().join("\n")).toContain(
      "Customize requires an effective enabled sandbox with network access.",
    );
    modal.press("Escape");
    await expect(pending).resolves.toEqual({
      action: "back",
      draft: { mode: "inherit" },
    });
  });

  it("distinguishes an explicitly disabled parent from an absent parent", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editSandboxDeclaration({
      ctx: harness.context,
      initial: { mode: "inherit" },
      resolvedParent: false,
      title: `${metadataSectionPresentation.sandbox.label} declaration`,
    });
    const modal = await harness.ui.waitForCustomModal();
    expect(modal.render().join("\n")).toContain(
      "Parent context: sandbox explicitly disabled.",
    );
    modal.press("Escape");
    await expect(pending).resolves.toEqual({
      action: "back",
      draft: { mode: "inherit" },
    });
  });

  it("reports only actual sandbox expansion and broad activation effects", () => {
    expect(
      summarizeSandboxSecurityExpansion({
        current: undefined,
        candidate: undefined,
      }),
    ).toEqual({
      unsafe: false,
      warnings: [],
    });
    expect(
      summarizeSandboxSecurityExpansion({
        current: undefined,
        candidate: false,
      }).warnings[0],
    ).toContain("fail-closed");
    expect(
      summarizeSandboxSecurityExpansion({
        current: {
          network: "deny",
          allowLocalBinding: false,
          allowAppleEvents: false,
        },
        candidate: {
          network: "allow",
          allowLocalBinding: false,
          allowAppleEvents: false,
          extraWritePaths: ["/tmp/write"],
        },
      }).warnings,
    ).toEqual([
      "Adds external network access.",
      "Adds writable sandbox roots.",
    ]);
    expect(
      summarizeSandboxSecurityExpansion({ current: false, candidate: false }),
    ).toEqual({
      unsafe: false,
      warnings: [],
    });
    expect(
      isConservativelyBroadDirectoryActivation({
        candidate: ["/work/*"],
        existing: ["/work/project"],
      }),
    ).toBe(true);
    expect(
      isConservativelyBroadDirectoryActivation({
        candidate: ["/work/project"],
        existing: ["/work/*"],
      }),
    ).toBe(true);
  });
});
