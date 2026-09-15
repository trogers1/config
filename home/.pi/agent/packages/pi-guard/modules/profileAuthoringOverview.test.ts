import { describe, expect, it } from "vitest";
import { createExtensionHarness } from "../integrationTests/support/extensionHarness";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  ProfileAuthoringOverview,
  profileAuthoringOverviewGeneralSection,
  profileAuthoringOverviewRuleSection,
  showProfileAuthoringOverview,
  profileAuthoringOverviewSectionIds,
  type ProfileAuthoringOverviewActionId,
  type ProfileAuthoringOverviewDescriptor,
  type ProfileAuthoringOverviewSelection,
} from "./profileAuthoringOverview";
import { createProfileAuthoringFlow } from "./profileAuthoringFlow";
import {
  formatWizardProfileIdentity,
  generalSectionOption,
  profileAuthoringAction,
  profileAuthoringSelectedRowMarker,
  ruleSectionOption,
} from "./profileAuthoringPresentation";

const createMode = "create" as const;
const editMode = "edit" as const;
const submitActionId: ProfileAuthoringOverviewActionId = "submit";
const identity = formatWizardProfileIdentity({
  emoji: "🧪",
  name: "overview-work",
});
const defaultKeybindings = new KeybindingsManager(TUI_KEYBINDINGS);
const remappedOverviewKeybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
  "tui.select.up": "ctrl+k",
  "tui.select.down": "ctrl+j",
  "tui.select.confirm": "space",
  "tui.select.cancel": "ctrl+x",
});
const overviewKeyData = {
  up: "\x0b",
  down: "\x0a",
  confirm: " ",
  remappedCancel: "\x18",
  escape: "\x1b",
  ctrlC: "\x03",
} as const;
const theme = {
  fg: (_args: { color: string; text: string } | string, text?: string) =>
    text ?? "",
  bg: (_args: { color: string; text: string } | string, text?: string) =>
    text ?? "",
  bold: (text: string) => text,
};
function descriptor({
  mode,
}: {
  readonly mode: "create" | "edit";
}): ProfileAuthoringOverviewDescriptor {
  return {
    mode,
    identity,
    details: ["Description: shared overview"],
    sections: [
      profileAuthoringOverviewGeneralSection({
        label: generalSectionOption({ emoji: "🧪", name: "overview-work" }),
      }),
      profileAuthoringOverviewRuleSection({
        kind: "bash",
        label: ruleSectionOption({ kind: "bash", count: 0 }),
      }),
    ],
  };
}
function component({
  mode,
  selections,
  cancelled,
  keybindings = defaultKeybindings,
}: {
  readonly mode: "create" | "edit";
  readonly selections: ProfileAuthoringOverviewSelection[];
  readonly cancelled: { value: boolean };
  readonly keybindings?: KeybindingsManager;
}): ProfileAuthoringOverview {
  return new ProfileAuthoringOverview({
    descriptor: descriptor({ mode }),
    theme,
    keybindings,
    onSelect: ({
      selection,
    }: {
      readonly selection: ProfileAuthoringOverviewSelection;
    }) => selections.push(selection),
    onCancel: () => {
      cancelled.value = true;
    },
  });
}

describe("profile authoring overview", () => {
  it("publishes the stable overview section and action IDs", () => {
    expect(profileAuthoringOverviewSectionIds).toContain("bash");
    expect(profileAuthoringOverviewSectionIds[0]).toBe("general");
    expect(submitActionId).toBe("submit");
  });

  it("renders the create action semantically, with identity and a real blank separator", () => {
    const colors: string[] = [];
    const semanticTheme = {
      ...theme,
      fg: (color: string, text: string) => {
        colors.push(color);
        return text;
      },
    };
    const overview = new ProfileAuthoringOverview({
      descriptor: descriptor({ mode: createMode }),
      theme: semanticTheme,
      keybindings: defaultKeybindings,
      onSelect: () => undefined,
      onCancel: () => undefined,
    });
    const lines = overview.render(160);
    expect(colors).toContain("success");
    expect(lines).toContain(`Create profile: ${identity} · Profile settings`);
    expect(lines.join("\n")).toContain(
      profileAuthoringAction({ action: "create" }),
    );
    const action = lines.indexOf(
      `${profileAuthoringSelectedRowMarker}${profileAuthoringAction({ action: "create" })}`,
    );
    expect(lines[action + 1]).toBe("");

    const general = { emoji: "💅", name: "mutable-work" };
    const mutableOverview = new ProfileAuthoringOverview({
      descriptor: { ...descriptor({ mode: createMode }), identity: general },
      theme,
      keybindings: defaultKeybindings,
      onSelect: () => undefined,
      onCancel: () => undefined,
    });
    expect(mutableOverview.title).toBe("Create profile: 💅 mutable-work");
  });

  it("uses typed IDs, skips its separator, wraps, and cancels", () => {
    const selections: ProfileAuthoringOverviewSelection[] = [];
    const cancelled = { value: false };
    const overview = component({ mode: editMode, selections, cancelled });
    overview.handleInput("\x1b[B");
    overview.handleInput("\n");
    expect(selections).toContainEqual({ kind: "section", id: "general" });

    const wrapped = component({ mode: editMode, selections, cancelled });
    wrapped.handleInput("\x10");
    wrapped.handleInput("\x10");
    wrapped.handleInput("\n");
    expect(selections).toContainEqual({ kind: "action", id: "submit" });

    const cancelledOverview = component({
      mode: editMode,
      selections,
      cancelled,
    });
    cancelledOverview.handleInput("\x1b");
    expect(cancelled.value).toBe(true);
  });

  it("uses the SDK keybinding manager for remapped selection and stock cancellation", () => {
    const selections: ProfileAuthoringOverviewSelection[] = [];
    const cancelled = { value: false };
    const overview = component({
      mode: editMode,
      selections,
      cancelled,
      keybindings: remappedOverviewKeybindings,
    });
    overview.handleInput(overviewKeyData.down);
    overview.handleInput(overviewKeyData.up);
    overview.handleInput(overviewKeyData.confirm);
    expect(selections).toContainEqual({ kind: "action", id: "submit" });

    const remappedDown = component({
      mode: editMode,
      selections,
      cancelled,
      keybindings: remappedOverviewKeybindings,
    });
    remappedDown.handleInput(overviewKeyData.down);
    remappedDown.handleInput(overviewKeyData.confirm);
    expect(selections).toContainEqual({ kind: "section", id: "general" });

    const remappedCancel = component({
      mode: editMode,
      selections,
      cancelled,
      keybindings: remappedOverviewKeybindings,
    });
    remappedCancel.handleInput(overviewKeyData.remappedCancel);
    expect(cancelled.value).toBe(true);

    for (const cancelData of [overviewKeyData.escape, overviewKeyData.ctrlC]) {
      const stockCancelled = { value: false };
      const stockCancel = component({
        mode: editMode,
        selections: [],
        cancelled: stockCancelled,
      });
      stockCancel.handleInput(cancelData);
      expect(stockCancelled.value).toBe(true);
    }
  });

  it("keeps Escape local and gives literal Ctrl+C root abort precedence in the authoring adapter", async () => {
    const escapeHarness = createExtensionHarness({ interactiveUi: true });
    const escapeFlow = createProfileAuthoringFlow({
      ctx: escapeHarness.context,
    });
    const escapePending = showProfileAuthoringOverview({
      ctx: escapeHarness.context,
      descriptor: descriptor({ mode: editMode }),
      custom: escapeFlow.custom,
    });
    const escapeModal = await escapeHarness.ui.waitForCustomModal();
    escapeModal.press("Escape");
    await expect(escapePending).resolves.toBeUndefined();
    expect(escapeFlow.signal.aborted).toBe(false);
    escapeFlow.dispose();

    const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.cancel": "ctrl+c",
    });
    const abortHarness = createExtensionHarness({
      interactiveUi: true,
      keybindings,
    });
    const abortFlow = createProfileAuthoringFlow({
      ctx: abortHarness.context,
    });
    const abortPending = showProfileAuthoringOverview({
      ctx: abortHarness.context,
      descriptor: descriptor({ mode: editMode }),
      custom: abortFlow.custom,
    });
    const abortModal = await abortHarness.ui.waitForCustomModal();
    abortModal.press("CtrlC");
    await expect(abortPending).resolves.toBeUndefined();
    expect(abortFlow.signal.aborted).toBe(true);
    abortFlow.dispose();
  });

  it("constructs both modes and never overflows a narrow terminal", () => {
    const cancelled = { value: false };
    const create = component({ mode: createMode, selections: [], cancelled });
    const edit = component({ mode: editMode, selections: [], cancelled });
    expect(create.render(160)).toContain(
      `${profileAuthoringSelectedRowMarker}${profileAuthoringAction({ action: "create" })}`,
    );
    expect(edit.render(160)).toContain(
      `${profileAuthoringSelectedRowMarker}${profileAuthoringAction({ action: "save" })}`,
    );
    for (const line of create.render(12))
      expect(visibleWidth(line)).toBeLessThanOrEqual(12);
  });
});
