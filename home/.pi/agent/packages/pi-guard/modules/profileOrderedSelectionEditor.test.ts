import { describe, expect, it } from "vitest";
import { createExtensionHarness } from "../integrationTests/support/extensionHarness";
import { createProfileAuthoringFlow } from "./profileAuthoringFlow";
import {
  editOrderedSelection,
  type OrderedSelectionOption,
} from "./profileOrderedSelectionEditor";

const options = [
  { value: "first", description: "First option", emoji: "1️⃣" },
  { value: "second", description: "Second option", emoji: "2️⃣" },
] as const satisfies readonly OrderedSelectionOption<string>[];
const editorTitle = "Ordered values";

function edit({
  harness,
  initial,
  explicitEmpty,
  flow,
}: {
  readonly harness: ReturnType<typeof createExtensionHarness>;
  readonly initial:
    | { readonly mode: "omit" }
    | { readonly mode: "set"; readonly value: readonly string[] };
  readonly explicitEmpty: boolean;
  readonly flow?: ReturnType<typeof createProfileAuthoringFlow>;
}) {
  return editOrderedSelection({
    ctx: harness.context,
    custom: flow?.custom,
    title: editorTitle,
    initial,
    options,
    explicitEmpty,
  });
}

async function add({
  harness,
  value,
}: {
  readonly harness: ReturnType<typeof createExtensionHarness>;
  readonly value: string;
}): Promise<void> {
  const editor = await harness.ui.waitForCustomModal();
  editor.press("CtrlN");
  const picker = await harness.ui.waitForCustomModal();
  picker.type(value);
  picker.press("Enter");
}

describe("ordered profile selection editor", () => {
  it("preserves duplicates and supports delete and Ctrl+Arrow reordering", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = edit({
      harness,
      initial: { mode: "set", value: ["first", "second"] },
      explicitEmpty: false,
    });
    const initial = await harness.ui.waitForCustomModal();
    initial.press("CtrlArrowDown");
    initial.press("CtrlN");
    const picker = await harness.ui.waitForCustomModal();
    picker.type("first");
    picker.press("Enter");
    const resumed = await harness.ui.waitForCustomModal();
    expect(resumed.render().join("\n")).toContain("3. first");
    resumed.press("CtrlD");
    resumed.press("Enter");

    await expect(pending).resolves.toEqual({
      action: "save",
      draft: { mode: "set", value: ["first", "first"] },
    });
  });

  it("distinguishes Transform omission from an explicit empty array", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const explicit = edit({
      harness,
      initial: { mode: "omit" },
      explicitEmpty: true,
    });
    const explicitModal = await harness.ui.waitForCustomModal();
    explicitModal.press("CtrlO");
    explicitModal.press("Enter");
    await expect(explicit).resolves.toEqual({
      action: "save",
      draft: { mode: "set", value: [] },
    });

    const omitted = edit({
      harness,
      initial: { mode: "set", value: [] },
      explicitEmpty: true,
    });
    const omittedModal = await harness.ui.waitForCustomModal();
    omittedModal.press("CtrlO");
    omittedModal.press("Enter");
    await expect(omitted).resolves.toEqual({
      action: "save",
      draft: { mode: "omit" },
    });
  });

  it("omits an empty Composition and retains populated rows on Escape", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const empty = edit({
      harness,
      initial: { mode: "set", value: ["first"] },
      explicitEmpty: false,
    });
    const emptyModal = await harness.ui.waitForCustomModal();
    emptyModal.press("CtrlD");
    emptyModal.press("Enter");
    await expect(empty).resolves.toEqual({
      action: "save",
      draft: { mode: "omit" },
    });

    const retained = edit({
      harness,
      initial: { mode: "omit" },
      explicitEmpty: false,
    });
    await add({ harness, value: "second" });
    const retainedModal = await harness.ui.waitForCustomModal();
    retainedModal.press("Escape");
    await expect(retained).resolves.toEqual({
      action: "back",
      draft: { mode: "set", value: ["second"] },
    });
  });

  it("returns null when the command-scoped flow aborts", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const flow = createProfileAuthoringFlow({ ctx: harness.context });
    const pending = edit({
      harness,
      initial: { mode: "omit" },
      explicitEmpty: false,
      flow,
    });
    await harness.ui.waitForCustomModal();
    harness.ui.sendTerminalInput({ data: "\x03" });
    await expect(pending).resolves.toBeNull();
    flow.dispose();
  });
});
