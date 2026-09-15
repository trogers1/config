import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createExtensionHarness } from "../integrationTests/support/extensionHarness";
import { createProfileAuthoringFlow } from "./profileAuthoringFlow";
import { defaultCustomProfileEmoji } from "./profileAuthoringModel";
import {
  editProfileGeneral,
  type ProfileGeneralNameValidator,
} from "./profileGeneralEditor";
import {
  generalSectionPresentation,
  profileAuthoringSelectedRowMarker,
} from "./profileAuthoringPresentation";

const profileDescription = "Work profile";

const validateName: ProfileGeneralNameValidator = ({ name }) => {
  if (name !== name.trim()) return "Name cannot have surrounding whitespace.";
  if (name.startsWith("builtin:")) return "Name uses a reserved prefix.";
  if (name === "existing") return "A profile named 'existing' already exists.";
  return undefined;
};

function createDraft() {
  return {
    mode: "create" as const,
    name: "work",
    description: profileDescription,
    emoji: defaultCustomProfileEmoji,
    color: undefined,
  };
}

describe("profile General editor", () => {
  it("mounts CREATE fields with default emoji, shared copy, and one row marker", async () => {
    const harness = createExtensionHarness({
      interactiveUi: true,
      tuiMode: true,
    });
    const pending = editProfileGeneral({
      ctx: harness.context,
      initial: createDraft(),
      title: generalSectionPresentation.label,
      validateName,
    });
    const modal = await harness.ui.waitForCustomModal();
    const rendered = modal.render(500);
    expect(rendered.join("\n")).toContain(generalSectionPresentation.purpose);
    expect(rendered.join("\n")).toContain(generalSectionPresentation.examples);
    expect(rendered.join("\n")).toContain(generalSectionPresentation.syntax);
    expect(
      rendered.filter((line) =>
        line.startsWith(profileAuthoringSelectedRowMarker),
      ),
    ).toHaveLength(1);
    expect(rendered.join("\n")).toContain(defaultCustomProfileEmoji);
    modal.press("Enter");
    await expect(pending).resolves.toEqual({
      action: "save",
      draft: createDraft(),
    });
  });

  it("edits description, emoji, and schema-derived color in EDIT", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileGeneral({
      ctx: harness.context,
      initial: {
        mode: "edit",
        name: "work",
        description: profileDescription,
        emoji: "🧪",
      },
      title: generalSectionPresentation.label,
      validateName,
    });
    const modal = await harness.ui.waitForCustomModal();
    modal.press("ArrowDown");
    modal.type(" updated");
    modal.press("ArrowDown");
    modal.press("CtrlU");
    modal.type("🚀");
    modal.press("ArrowDown");
    modal.press("ArrowRight");
    modal.press("Enter");
    await expect(pending).resolves.toEqual({
      action: "save",
      draft: {
        mode: "edit",
        name: "work",
        description: `${profileDescription} updated`,
        emoji: "🚀",
        color: "black",
      },
    });
  });

  it("requires CREATE name and description and delegates duplicate, reserved, and trim validation", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileGeneral({
      ctx: harness.context,
      initial: {
        mode: "create",
        name: "",
        description: "",
        emoji: defaultCustomProfileEmoji,
      },
      title: generalSectionPresentation.label,
      validateName,
    });
    const modal = await harness.ui.waitForCustomModal();
    modal.press("Enter");
    expect(modal.render().join("\n")).toContain("Name is required.");
    modal.type("existing");
    modal.press("Enter");
    expect(modal.render().join("\n")).toContain("already exists");
    modal.press("CtrlU");
    modal.type("builtin:bad");
    modal.press("Enter");
    expect(modal.render().join("\n")).toContain("reserved prefix");
    modal.press("CtrlU");
    modal.type(" work ");
    modal.press("Enter");
    expect(modal.render().join("\n")).toContain("surrounding whitespace");
    modal.press("CtrlU");
    modal.type("work");
    modal.press("ArrowDown");
    modal.type("Description");
    modal.press("Enter");
    await expect(pending).resolves.toMatchObject({ action: "save" });
  });

  it("returns retained drafts on Escape, root-aborts only through the flow adapter, and fits narrow widths", async () => {
    const harness = createExtensionHarness({ interactiveUi: true });
    const pending = editProfileGeneral({
      ctx: harness.context,
      initial: {
        mode: "edit",
        name: "work",
        description: profileDescription,
        emoji: "",
      },
      title: generalSectionPresentation.label,
      validateName,
    });
    const modal = await harness.ui.waitForCustomModal();
    for (const line of modal.render(12))
      expect(visibleWidth(line)).toBeLessThanOrEqual(12);
    modal.type("-next");
    modal.press("Escape");
    await expect(pending).resolves.toEqual({
      action: "back",
      draft: {
        mode: "edit",
        name: "work-next",
        description: profileDescription,
        emoji: "",
        color: undefined,
      },
    });

    const abortHarness = createExtensionHarness({ interactiveUi: true });
    const flow = createProfileAuthoringFlow({ ctx: abortHarness.context });
    const aborted = editProfileGeneral({
      ctx: abortHarness.context,
      initial: createDraft(),
      title: generalSectionPresentation.label,
      validateName,
      custom: flow.custom,
    });
    const abortModal = await abortHarness.ui.waitForCustomModal();
    abortModal.press("CtrlC");
    await expect(aborted).resolves.toBeNull();
    expect(flow.signal.aborted).toBe(true);
    flow.dispose();
  });
});
