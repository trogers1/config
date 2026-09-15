import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  isProfileAuthoringAbort,
  showProfileAuthoringCustom,
  type ProfileAuthoringCustom,
} from "./profileAuthoringFlow";
import { profileColorNames, type ProfileColor } from "./policyHelpers";
import type { ProfileGeneralDraft } from "./profileAuthoringModel";
import {
  generalSectionPresentation,
  profileAuthoringSelectedRowMarker,
  profileAuthoringUnselectedRowMarker,
} from "./profileAuthoringPresentation";

export type ProfileGeneralNameValidator = ({
  name,
}: {
  readonly name: string;
}) => string | undefined;

export type ProfileGeneralEditorResult = {
  readonly action: "save" | "back" | "cancel";
  readonly draft: ProfileGeneralDraft;
} | null;
type EditorContext = {
  readonly ui: Pick<ExtensionContext["ui"], "custom">;
};

const embeddedInputOptions = { prompt: "" } as const;
const generalControls =
  "↑↓ select · ←→ color · Enter save · Esc back · Ctrl+U clear";
const generalFields = ["name", "description", "emoji", "color"] as const;
type GeneralField = (typeof generalFields)[number];
const generalFieldLabels = {
  name: "Name (required)",
  description: "Description (required)",
  emoji: "Emoji (optional)",
  color: "Color (inherit if unset)",
} as const satisfies Record<GeneralField, string>;

function newInput({ value }: { readonly value: string }): Input {
  const input = new Input(embeddedInputOptions);
  input.setValue(value);
  input.handleInput("\u001b[F");
  return input;
}

function nextColor({
  color,
  delta,
}: {
  readonly color: ProfileColor | undefined;
  readonly delta: -1 | 1;
}): ProfileColor | undefined {
  const choices: readonly (ProfileColor | undefined)[] = [
    undefined,
    ...profileColorNames,
  ];
  const current = choices.findIndex((candidate) => candidate === color);
  const next = (current + delta + choices.length) % choices.length;
  return choices[next];
}

/** Shared CREATE/EDIT/ASK identity editor; policy validation stays injected. */
export async function editProfileGeneral({
  ctx,
  initial,
  title,
  validateName,
  custom,
}: {
  readonly ctx: EditorContext;
  readonly initial: ProfileGeneralDraft;
  readonly title: string;
  readonly validateName: ProfileGeneralNameValidator;
  readonly custom?: ProfileAuthoringCustom;
}): Promise<ProfileGeneralEditorResult> {
  const inputs = {
    name: newInput({ value: initial.name }),
    description: newInput({ value: initial.description }),
    emoji: newInput({ value: initial.emoji }),
  } as const;
  let color = initial.color;
  const snapshot = (): ProfileGeneralDraft => ({
    mode: initial.mode,
    name: inputs.name.getValue(),
    description: inputs.description.getValue(),
    emoji: inputs.emoji.getValue(),
    color,
  });

  const result = await showProfileAuthoringCustom<ProfileGeneralEditorResult>({
    ctx,
    custom,
    factory: (tui, theme, _keys, done) => {
      let selected = 0;
      let focused = false;
      let error: string | undefined;
      const selectedField = (): GeneralField =>
        generalFields[selected] ?? "name";
      const focusSelected = () => {
        const field = selectedField();
        for (const [name, input] of Object.entries(inputs))
          input.focused = focused && name === field;
      };
      const save = () => {
        const draft = snapshot();
        if (draft.name.length === 0) {
          error = "Name is required.";
          return;
        }
        const nameError = validateName({ name: draft.name });
        if (nameError !== undefined) {
          error = nameError;
          return;
        }
        if (draft.description.length === 0) {
          error = "Description is required.";
          return;
        }
        done({ action: "save", draft });
      };
      const changeColor = ({ delta }: { readonly delta: -1 | 1 }) => {
        color = nextColor({ color, delta });
        error = undefined;
      };
      return {
        get focused() {
          const field = selectedField();
          return field === "color" ? false : inputs[field].focused;
        },
        set focused(value: boolean) {
          focused = value;
          focusSelected();
        },
        render(width: number) {
          const rows = generalFields.map((field, index) => {
            const marker =
              index === selected
                ? profileAuthoringSelectedRowMarker
                : profileAuthoringUnselectedRowMarker;
            const value =
              field === "color"
                ? (color ?? "inherit")
                : (inputs[field].render(Math.max(1, width - 2))[0] ?? "");
            return `${marker}${generalFieldLabels[field]}: ${value}`;
          });
          const purpose = wrapTextWithAnsi(
            theme.fg("text", generalSectionPresentation.purpose),
            width,
          );
          const examples = wrapTextWithAnsi(
            theme.fg("dim", generalSectionPresentation.examples),
            width,
          );
          const syntax = wrapTextWithAnsi(
            theme.fg("dim", generalSectionPresentation.syntax),
            width,
          );
          return [
            theme.fg("accent", theme.bold(title)),
            "",
            ...purpose,
            "",
            ...examples,
            ...syntax,
            "",
            ...rows,
            ...(error === undefined
              ? []
              : [theme.fg("error", `Invalid: ${error}`)]),
            "",
            theme.fg("dim", generalControls),
          ].map((line) => truncateToWidth(line, width));
        },
        invalidate() {
          Object.values(inputs).forEach((input) => input.invalidate());
        },
        handleInput(data: string) {
          const field = selectedField();
          if (matchesKey(data, Key.enter)) save();
          else if (matchesKey(data, Key.escape))
            done({ action: "back", draft: snapshot() });
          else if (matchesKey(data, Key.ctrl("c")))
            done({ action: "cancel", draft: snapshot() });
          else if (matchesKey(data, Key.up)) {
            selected = Math.max(0, selected - 1);
            focusSelected();
          } else if (matchesKey(data, Key.down)) {
            selected = Math.min(generalFields.length - 1, selected + 1);
            focusSelected();
          } else if (
            field === "color" &&
            (matchesKey(data, Key.left) || matchesKey(data, Key.right))
          ) {
            changeColor({ delta: matchesKey(data, Key.left) ? -1 : 1 });
          } else if (matchesKey(data, Key.ctrl("u"))) {
            if (field === "color") color = undefined;
            else inputs[field].setValue("");
            error = undefined;
          } else if (field !== "color") {
            inputs[field].handleInput(data);
            error = undefined;
          }
          tui.requestRender();
        },
      };
    },
  });
  return isProfileAuthoringAbort(result) ? null : result;
}
