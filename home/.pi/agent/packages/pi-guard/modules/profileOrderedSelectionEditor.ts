import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  isProfileAuthoringAbort,
  showProfileAuthoringCustom,
  type ProfileAuthoringCustom,
} from "./profileAuthoringFlow";
import {
  profileAuthoringSelectedRowMarker,
  profileAuthoringUnselectedRowMarker,
} from "./profileAuthoringPresentation";
import { ProfilePicker, type ProfilePickerItem } from "./profilePicker.lib";

export type OrderedSelectionDraft<Value extends string> =
  | { readonly mode: "omit" }
  | { readonly mode: "set"; readonly value: readonly Value[] };

export type OrderedSelectionOption<Value extends string> = {
  readonly value: Value;
  readonly description: string;
  readonly emoji: string;
};

type EditorContext = {
  readonly ui: Pick<ExtensionContext["ui"], "custom">;
};
type ListResult<Value extends string> =
  | {
      readonly action: "save" | "back";
      readonly draft: OrderedSelectionDraft<Value>;
    }
  | { readonly action: "add"; readonly draft: OrderedSelectionDraft<Value> }
  | null;

function orderedSelectionControls({
  explicitEmpty,
}: {
  readonly explicitEmpty: boolean;
}): string {
  const modeControl = explicitEmpty ? " · Ctrl+O omit/empty" : "";
  return `↑↓ select · Ctrl+N add · Ctrl+D delete · Ctrl+↑/Ctrl+↓ reorder${modeControl} · Enter save · Esc back`;
}
const emptyRow = "No local entries.";

function valuesOf<Value extends string>({
  draft,
}: {
  readonly draft: OrderedSelectionDraft<Value>;
}): readonly Value[] {
  return draft.mode === "set" ? draft.value : [];
}

function pickerItems<Value extends string>({
  options,
}: {
  readonly options: readonly OrderedSelectionOption<Value>[];
}): readonly ProfilePickerItem[] {
  return options.map((option) => ({
    name: option.value,
    description: option.description,
    emoji: option.emoji,
  }));
}

async function chooseOrderedValue<Value extends string>({
  ctx,
  custom,
  title,
  options,
}: {
  readonly ctx: EditorContext;
  readonly custom?: ProfileAuthoringCustom;
  readonly title: string;
  readonly options: readonly OrderedSelectionOption<Value>[];
}): Promise<Value | undefined> {
  const result = await showProfileAuthoringCustom<string | null>({
    ctx,
    custom,
    factory: (tui, theme, _keys, done) => {
      const picker = new ProfilePicker(
        pickerItems({ options }),
        theme,
        done,
        () => done(null),
      );
      return {
        get focused() {
          return picker.focused;
        },
        set focused(value: boolean) {
          picker.focused = value;
        },
        render: (width: number) =>
          [
            theme.fg("accent", theme.bold(title)),
            theme.fg("dim", "Duplicates are allowed and order is meaningful."),
            ...picker.render(width),
          ].map((line) => truncateToWidth(line, width)),
        invalidate: () => picker.invalidate(),
        handleInput: (data: string) => {
          picker.handleInput(data);
          tui.requestRender();
        },
      };
    },
  });
  if (result === null || isProfileAuthoringAbort(result)) return undefined;
  return options.find((option) => option.value === result)?.value;
}

/** Shared ordered duplicate-preserving editor for Composition and Transforms. */
export async function editOrderedSelection<Value extends string>({
  ctx,
  custom,
  title,
  initial,
  options,
  explicitEmpty,
}: {
  readonly ctx: EditorContext;
  readonly custom?: ProfileAuthoringCustom;
  readonly title: string;
  readonly initial: OrderedSelectionDraft<Value>;
  readonly options: readonly OrderedSelectionOption<Value>[];
  readonly explicitEmpty: boolean;
}): Promise<ListResult<Value>> {
  let draft = initial;
  while (true) {
    const result = await showProfileAuthoringCustom<ListResult<Value>>({
      ctx,
      custom,
      factory: (tui, theme, _keys, done) => {
        let selected = 0;
        const snapshot = (): OrderedSelectionDraft<Value> => draft;
        const setValues = ({ value }: { readonly value: readonly Value[] }) => {
          draft =
            value.length > 0 || explicitEmpty
              ? { mode: "set", value }
              : { mode: "omit" };
          selected = Math.max(0, Math.min(selected, value.length - 1));
        };
        const moveEntry = ({ delta }: { readonly delta: -1 | 1 }) => {
          const values = [...valuesOf({ draft })];
          const target = selected + delta;
          if (target < 0 || target >= values.length) return;
          const current = values[selected];
          const replacement = values[target];
          if (current === undefined || replacement === undefined) return;
          values[selected] = replacement;
          values[target] = current;
          selected = target;
          setValues({ value: values });
        };
        return {
          render(width: number) {
            const values = valuesOf({ draft });
            const rows =
              values.length === 0
                ? [theme.fg("warning", emptyRow)]
                : values.map((value, index) => {
                    const marker =
                      index === selected
                        ? profileAuthoringSelectedRowMarker
                        : profileAuthoringUnselectedRowMarker;
                    return `${marker}${index + 1}. ${value}`;
                  });
            return [
              theme.fg("accent", theme.bold(title)),
              theme.fg(
                "dim",
                `Raw mode: ${draft.mode}${draft.mode === "set" && draft.value.length === 0 ? " (explicit empty)" : ""}`,
              ),
              "",
              ...rows,
              "",
              theme.fg("dim", orderedSelectionControls({ explicitEmpty })),
            ].map((line) => truncateToWidth(line, width));
          },
          invalidate() {},
          handleInput(data: string) {
            const values = valuesOf({ draft });
            if (matchesKey(data, Key.enter))
              done({ action: "save", draft: snapshot() });
            else if (matchesKey(data, Key.escape))
              done({ action: "back", draft: snapshot() });
            else if (matchesKey(data, Key.ctrl("n")))
              done({ action: "add", draft: snapshot() });
            else if (matchesKey(data, Key.ctrl("d"))) {
              if (values.length > 0)
                setValues({
                  value: values.filter((_value, index) => index !== selected),
                });
            } else if (matchesKey(data, Key.ctrl("up")))
              moveEntry({ delta: -1 });
            else if (matchesKey(data, Key.ctrl("down")))
              moveEntry({ delta: 1 });
            else if (explicitEmpty && matchesKey(data, Key.ctrl("o")))
              draft =
                draft.mode === "omit"
                  ? { mode: "set", value: [] }
                  : { mode: "omit" };
            else if (matchesKey(data, Key.up))
              selected = Math.max(0, selected - 1);
            else if (matchesKey(data, Key.down))
              selected = Math.min(Math.max(0, values.length - 1), selected + 1);
            tui.requestRender();
          },
        };
      },
    });
    if (result === null || isProfileAuthoringAbort(result)) return null;
    draft = result.draft;
    if (result.action !== "add") return result;
    const selected = await chooseOrderedValue({ ctx, custom, title, options });
    if (selected !== undefined)
      draft = { mode: "set", value: [...valuesOf({ draft }), selected] };
  }
}
