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
import type { ProfilePromptAuthoring } from "./profileAuthoringModel";
import {
  profileAuthoringSelectedRowMarker,
  profileAuthoringUnselectedRowMarker,
  promptSectionPresentation,
} from "./profileAuthoringPresentation";
import { validatePromptFile } from "./profilePromptFile";

type EditorContext = {
  readonly ui: Pick<ExtensionContext["ui"], "custom">;
};
export type ProfilePromptEditorResult = {
  readonly action: "save" | "back";
  readonly draft: ProfilePromptAuthoring;
} | null;

const promptModes = ["inherit", "disable", "file"] as const;
type PromptMode = (typeof promptModes)[number];
const promptModeLabels = {
  inherit: "inherit (omit local declaration)",
  disable: "disable inherited prompt (write null)",
  file: "use file",
} as const satisfies Record<PromptMode, string>;
const promptControls =
  "Tab/←→ mode · Enter save · Esc back · Ctrl+U clear path";
const embeddedInputOptions = { prompt: "" } as const;

function nextMode({
  mode,
  delta,
}: {
  readonly mode: PromptMode;
  readonly delta: -1 | 1;
}): PromptMode {
  const current = promptModes.indexOf(mode);
  return promptModes[
    (current + delta + promptModes.length) % promptModes.length
  ];
}

/** Edit only the raw local prompt declaration. */
export async function editProfilePrompt({
  ctx,
  initial,
  profile,
  title,
  custom,
}: {
  readonly ctx: EditorContext;
  readonly initial: ProfilePromptAuthoring;
  readonly profile: string;
  readonly title: string;
  readonly custom?: ProfileAuthoringCustom;
}): Promise<ProfilePromptEditorResult> {
  let mode = initial.mode;
  const input = new Input(embeddedInputOptions);
  input.setValue(initial.mode === "file" ? initial.path : "");
  const snapshot = (): ProfilePromptAuthoring =>
    mode === "file" ? { mode, path: input.getValue() } : { mode };

  const result = await showProfileAuthoringCustom<ProfilePromptEditorResult>({
    ctx,
    custom,
    factory: (tui, theme, _keys, done) => {
      let error: string | undefined;
      const changeMode = ({ delta }: { readonly delta: -1 | 1 }) => {
        mode = nextMode({ mode, delta });
        error = undefined;
      };
      const save = () => {
        const draft = snapshot();
        if (draft.mode === "file") {
          try {
            validatePromptFile({
              profile,
              declaredPath: draft.path,
              allowMissing: true,
            });
          } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
            return;
          }
        }
        done({ action: "save", draft });
      };
      return {
        get focused() {
          return mode === "file" && input.focused;
        },
        set focused(value: boolean) {
          input.focused = value && mode === "file";
        },
        render(width: number) {
          const purpose = wrapTextWithAnsi(
            theme.fg("text", promptSectionPresentation.purpose),
            width,
          );
          const pathRow =
            mode === "file"
              ? `${profileAuthoringUnselectedRowMarker}Path: ${input.render(Math.max(1, width - 2))[0] ?? ""}`
              : undefined;
          return [
            theme.fg("accent", theme.bold(title)),
            "",
            ...purpose,
            "",
            ...wrapTextWithAnsi(
              theme.fg("dim", promptSectionPresentation.examples),
              width,
            ),
            ...wrapTextWithAnsi(
              theme.fg("dim", promptSectionPresentation.syntax),
              width,
            ),
            "",
            `${profileAuthoringSelectedRowMarker}Mode: ${promptModeLabels[mode]}`,
            ...(pathRow ? [pathRow] : []),
            ...(error ? [theme.fg("error", `Invalid: ${error}`)] : []),
            "",
            theme.fg("dim", promptControls),
          ].map((line) => truncateToWidth(line, width));
        },
        invalidate() {
          input.invalidate();
        },
        handleInput(data: string) {
          if (matchesKey(data, Key.enter)) save();
          else if (matchesKey(data, Key.escape))
            done({ action: "back", draft: snapshot() });
          else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right))
            changeMode({ delta: 1 });
          else if (matchesKey(data, Key.left)) changeMode({ delta: -1 });
          else if (matchesKey(data, Key.ctrl("u"))) {
            input.setValue("");
            error = undefined;
          } else if (mode === "file") {
            input.handleInput(data);
            error = undefined;
          }
          tui.requestRender();
        },
      };
    },
  });
  return isProfileAuthoringAbort(result) ? null : result;
}
