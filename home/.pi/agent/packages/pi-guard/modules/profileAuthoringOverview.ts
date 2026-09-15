import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  type Component,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  formatWizardProfileIdentity,
  profileAuthoringAction,
  profileAuthoringSelectedRowMarker,
  profileAuthoringUnselectedRowMarker,
  profileSettingsHeading,
  type ProfileAuthoringAction,
} from "./profileAuthoringPresentation";
import type { RuleKind } from "./profileConfig";
import {
  isProfileAuthoringAbort,
  type ProfileAuthoringCustom,
} from "./profileAuthoringFlow";
import {
  profileAuthoringSectionIds,
  type ProfileAuthoringSectionId,
} from "./profileAuthoringModel";

export const profileAuthoringOverviewSectionIds = profileAuthoringSectionIds;
export type ProfileAuthoringOverviewSectionId = ProfileAuthoringSectionId;
export type ProfileAuthoringOverviewActionId = "submit";
export type ProfileAuthoringOverviewSelection =
  | { readonly kind: "action"; readonly id: ProfileAuthoringOverviewActionId }
  | {
      readonly kind: "section";
      readonly id: ProfileAuthoringOverviewSectionId;
    };

type OverviewMode = "create" | "edit";
type OverviewSection = {
  readonly id: ProfileAuthoringOverviewSectionId;
  readonly label: string;
};
type OverviewItem =
  | {
      readonly kind: "action";
      readonly id: ProfileAuthoringOverviewActionId;
      readonly label: string;
    }
  | { readonly kind: "separator" }
  | {
      readonly kind: "section";
      readonly id: ProfileAuthoringOverviewSectionId;
      readonly label: string;
    };

type ProfileAuthoringOverviewIdentity =
  string | { readonly name: string; readonly emoji: string | undefined };

export type ProfileAuthoringOverviewDescriptor = {
  readonly mode: OverviewMode;
  /** A General draft identity can be supplied directly while it remains mutable. */
  readonly identity: ProfileAuthoringOverviewIdentity;
  readonly details: readonly string[];
  readonly sections: readonly OverviewSection[];
};

type OverviewContext = {
  readonly ui: Pick<ExtensionContext["ui"], "custom">;
};

function overviewIdentity({
  identity,
}: {
  readonly identity: ProfileAuthoringOverviewIdentity;
}): string {
  return typeof identity === "string"
    ? identity
    : formatWizardProfileIdentity(identity);
}
type OverviewTheme = Pick<Theme, "fg" | "bg" | "bold">;
const overviewControls = "↑↓ navigate • enter select • esc cancel";

function actionForMode({
  mode,
}: {
  readonly mode: OverviewMode;
}): ProfileAuthoringAction {
  return mode === "create" ? "create" : "save";
}

function overviewItems({
  descriptor,
}: {
  readonly descriptor: ProfileAuthoringOverviewDescriptor;
}): readonly OverviewItem[] {
  return [
    {
      kind: "action",
      id: "submit",
      label: profileAuthoringAction({
        action: actionForMode({ mode: descriptor.mode }),
      }),
    },
    { kind: "separator" },
    ...descriptor.sections.map((section) => ({
      kind: "section" as const,
      ...section,
    })),
  ];
}

/** A stock-select-like overview with a nonselectable separator after its action. */
export class ProfileAuthoringOverview implements Component {
  private readonly items: readonly OverviewItem[];
  private selectedIndex = 0;
  private completed = false;

  constructor(
    private readonly args: {
      readonly descriptor: ProfileAuthoringOverviewDescriptor;
      readonly theme: OverviewTheme;
      readonly keybindings: Pick<KeybindingsManager, "matches">;
      readonly onSelect: ({
        selection,
      }: {
        readonly selection: ProfileAuthoringOverviewSelection;
      }) => void;
      readonly onCancel: () => void;
      readonly requestRender?: () => void;
    },
  ) {
    this.items = overviewItems({ descriptor: args.descriptor });
  }

  get title(): string {
    const verb =
      this.args.descriptor.mode === "create"
        ? "Create profile"
        : "Edit profile";
    return `${verb}: ${overviewIdentity({ identity: this.args.descriptor.identity })}`;
  }

  get options(): readonly OverviewItem[] {
    return this.items;
  }

  private move({ delta }: { readonly delta: -1 | 1 }): void {
    const selectable = this.items.filter(
      (item): item is Exclude<OverviewItem, { readonly kind: "separator" }> =>
        item.kind !== "separator",
    );
    const current = selectable.findIndex(
      (item) => item === this.items[this.selectedIndex],
    );
    const next = (current + delta + selectable.length) % selectable.length;
    const item = selectable[next];
    const index = this.items.findIndex((candidate) => candidate === item);
    if (index >= 0) this.selectedIndex = index;
  }

  private complete({
    selection,
  }: {
    readonly selection: ProfileAuthoringOverviewSelection | undefined;
  }): void {
    if (this.completed) return;
    this.completed = true;
    if (selection) this.args.onSelect({ selection });
    else this.args.onCancel();
  }

  private selectCurrent(): void {
    const item = this.items[this.selectedIndex];
    if (!item || item.kind === "separator") return;
    this.complete({
      selection:
        item.kind === "action"
          ? { kind: "action", id: item.id }
          : { kind: "section", id: item.id },
    });
  }

  handleInput(data: string): void {
    if (this.args.keybindings.matches(data, "tui.select.up")) {
      this.move({ delta: -1 });
    } else if (this.args.keybindings.matches(data, "tui.select.down")) {
      this.move({ delta: 1 });
    } else if (this.args.keybindings.matches(data, "tui.select.confirm")) {
      this.selectCurrent();
    } else if (this.args.keybindings.matches(data, "tui.select.cancel")) {
      this.complete({ selection: undefined });
    } else {
      return;
    }
    this.args.requestRender?.();
  }

  render(width: number): string[] {
    const lines = [
      this.args.theme.fg(
        "accent",
        this.args.theme.bold(`${this.title} · ${profileSettingsHeading}`),
      ),
      ...this.args.descriptor.details.map((detail) =>
        this.args.theme.fg("muted", detail),
      ),
      "",
      ...this.items.map((item, index) => {
        if (item.kind === "separator") return "";
        const prefix =
          index === this.selectedIndex
            ? profileAuthoringSelectedRowMarker
            : profileAuthoringUnselectedRowMarker;
        const text =
          item.kind === "action"
            ? this.args.theme.fg("success", item.label)
            : item.label;
        const row = `${prefix}${text}`;
        return index === this.selectedIndex
          ? this.args.theme.bg("selectedBg", row)
          : row;
      }),
      this.args.theme.fg("dim", overviewControls),
    ];
    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}
}

export async function showProfileAuthoringOverview({
  ctx,
  descriptor,
  custom,
}: {
  readonly ctx: OverviewContext;
  readonly descriptor: ProfileAuthoringOverviewDescriptor;
  readonly custom?: ProfileAuthoringCustom;
}): Promise<ProfileAuthoringOverviewSelection | undefined> {
  const factory = (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (value: ProfileAuthoringOverviewSelection | undefined) => void,
  ) =>
    new ProfileAuthoringOverview({
      descriptor,
      theme,
      keybindings,
      onSelect: ({ selection }) => done(selection),
      onCancel: () => done(undefined),
      requestRender: () => tui.requestRender(),
    });
  const result = custom
    ? await custom({ factory })
    : await ctx.ui.custom(factory);
  return isProfileAuthoringAbort(result) ? undefined : result;
}

export function profileAuthoringOverviewGeneralSection({
  label,
}: {
  readonly label: string;
}): OverviewSection {
  return { id: "general", label };
}

export function profileAuthoringOverviewRuleSection({
  kind,
  label,
}: {
  readonly kind: RuleKind;
  readonly label: string;
}): OverviewSection {
  return { id: kind, label };
}
