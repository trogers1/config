import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { validateDirectoryGlobs } from "./directoryGlobs";
import {
  isProfileAuthoringAbort,
  showProfileAuthoringCustom,
  type ProfileAuthoringCustom,
} from "./profileAuthoringFlow";
import {
  decodeSandboxAuthoring,
  overwritePathArrayNames,
  serializeSandboxAuthoring,
  type DirectoryGlobsAuthoring,
  type OverwritePathArrayName,
  type PathArrayAuthoring,
  type RawSandboxAuthoring,
} from "./profileAuthoring";
import {
  composeSandboxDeclarations,
  type SandboxConfigOverride,
} from "./policyHelpers";
import {
  metadataSectionPresentation,
  profileAuthoringSelectedRowMarker,
  profileAuthoringUnselectedRowMarker,
  type MetadataSectionPresentation,
} from "./profileAuthoringPresentation";

type TextStyle = (text: string) => string;
type SectionDescriptionLines = {
  readonly purpose: string[];
  readonly examples: string[];
  readonly syntax: string[];
};

function sectionDescriptionLines({
  width,
  presentation,
  purposeStyle,
  mutedStyle,
}: {
  readonly width: number;
  readonly presentation: MetadataSectionPresentation;
  readonly purposeStyle: TextStyle;
  readonly mutedStyle: TextStyle;
}): SectionDescriptionLines {
  return {
    purpose: wrapTextWithAnsi(purposeStyle(presentation.purpose), width),
    examples: wrapTextWithAnsi(mutedStyle(presentation.examples), width),
    syntax: wrapTextWithAnsi(mutedStyle(presentation.syntax), width),
  };
}

const emptyDirectoryGlobsMessage =
  "No Startup Directory globs: declaration will be omitted.";
const directoryControls =
  "Enter save · Esc back · Ctrl+N add · Ctrl+D delete · Ctrl+U clear · ↑↓ select";
const directoryInheritanceContext =
  "Directory activation is local metadata; it does not inherit through extends.";
const sandboxControls =
  "Tab cycles mode/value/path mode · ←→ changes scalar · Ctrl+N/Ctrl+D path row · ↑↓ select · Enter save · Esc back";
const sandboxInheritanceContext =
  "Inheritance emits no local value. Append adds paths; overwrite replaces them.";
/** Parent rows render the selection indicator, so embedded Inputs need none. */
const embeddedInputOptions = { prompt: "" } as const;

/** A section editor returns a retained draft; its caller owns navigation and persistence. */
type MetadataEditorResult<T> = {
  readonly action: "save" | "back";
  readonly draft: T;
} | null;

type EditorContext = {
  readonly ui: Pick<ExtensionContext["ui"], "custom">;
};

function isTrustedStartupCwd({ value }: { readonly value: string }): boolean {
  return !/[?*]/u.test(value) && validateDirectoryGlobs([value]).valid;
}

/**
 * Edit only directory activation metadata. An undefined draft is CREATE's first
 * open; only then is the supplied, trusted startup CWD prefilled exactly.
 */
export async function editDirectoryGlobs({
  ctx,
  initial,
  startupCwd,
  title,
  custom,
}: {
  readonly ctx: EditorContext;
  readonly initial: DirectoryGlobsAuthoring | undefined;
  readonly startupCwd: string;
  readonly title: string;
  readonly custom?: ProfileAuthoringCustom;
}): Promise<MetadataEditorResult<DirectoryGlobsAuthoring>> {
  const initialValues = initial?.mode === "set" ? initial.value : [];
  const values =
    initial === undefined && isTrustedStartupCwd({ value: startupCwd })
      ? [startupCwd]
      : initialValues;
  const inputs = values.map((value) => newInput({ value }));

  const snapshot = (): DirectoryGlobsAuthoring => {
    const value = inputs.map((input) => input.getValue().trim());
    return value.length === 0 ? { mode: "omit" } : { mode: "set", value };
  };

  const result = await showProfileAuthoringCustom<
    MetadataEditorResult<DirectoryGlobsAuthoring>
  >({
    ctx,
    custom,
    factory: (tui, theme, _keys, done) => {
      let selected = 0;
      let componentFocused = false;
      let error: string | undefined;
      const focusSelected = () => {
        for (const [index, input] of inputs.entries())
          input.focused = componentFocused && index === selected;
      };
      const save = () => {
        const draft = snapshot();
        if (draft.mode === "set") {
          const validation = validateDirectoryGlobs(draft.value);
          if (!validation.valid) {
            error = `${validation.message} (${validation.code})`;
            return;
          }
        }
        done({ action: "save", draft });
      };
      const add = () => {
        const index = Math.min(selected + 1, inputs.length);
        inputs.splice(index, 0, newInput({ value: "" }));
        selected = index;
        focusSelected();
        error = undefined;
      };
      const remove = () => {
        if (inputs.length === 0) return;
        inputs.splice(selected, 1);
        selected = Math.max(0, Math.min(selected, inputs.length - 1));
        focusSelected();
        error = undefined;
      };
      return {
        get focused() {
          return inputs[selected]?.focused ?? false;
        },
        set focused(value: boolean) {
          componentFocused = value;
          focusSelected();
        },
        render(width: number) {
          const rows =
            inputs.length === 0
              ? [theme.fg("warning", emptyDirectoryGlobsMessage)]
              : inputs.map(
                  (input, index) =>
                    `${index === selected ? profileAuthoringSelectedRowMarker : profileAuthoringUnselectedRowMarker}${input.render(Math.max(1, width - 2))[0] ?? ""}`,
                );
          const description = sectionDescriptionLines({
            width,
            presentation: metadataSectionPresentation.directoryGlobs,
            purposeStyle: (text) => theme.fg("text", text),
            mutedStyle: (text) => theme.fg("dim", text),
          });
          return [
            theme.fg("accent", theme.bold(title)),
            "",
            theme.fg("dim", directoryInheritanceContext),
            "",
            ...description.purpose,
            "",
            ...description.examples,
            ...description.syntax,
            "",
            ...rows,
            ...(error === undefined
              ? []
              : [theme.fg("error", `Invalid: ${error}`)]),
            "",
            theme.fg("dim", directoryControls),
          ].map((line) => truncateToWidth(line, width));
        },
        invalidate() {
          inputs.forEach((input) => input.invalidate());
        },
        handleInput(data: string) {
          if (matchesKey(data, Key.enter)) save();
          else if (matchesKey(data, Key.escape))
            done({ action: "back", draft: snapshot() });
          else if (matchesKey(data, Key.ctrl("n"))) add();
          else if (matchesKey(data, Key.ctrl("d"))) remove();
          else if (matchesKey(data, Key.ctrl("u"))) {
            inputs[selected]?.setValue("");
            error = undefined;
          } else if (matchesKey(data, Key.up)) {
            selected = Math.max(0, selected - 1);
            focusSelected();
          } else if (matchesKey(data, Key.down)) {
            selected = Math.min(inputs.length - 1, selected + 1);
            focusSelected();
          } else {
            inputs[selected]?.handleInput(data);
            error = undefined;
          }
          tui.requestRender();
        },
      };
    },
  });
  return isProfileAuthoringAbort(result) ? null : result;
}

const scalarNames = [
  "network",
  "allowLocalBinding",
  "allowAppleEvents",
  "enableWeakerNetworkIsolation",
  "onUnavailable",
] as const;
type ScalarName = (typeof scalarNames)[number];
type Customize = Extract<RawSandboxAuthoring, { mode: "customize" }>;

const scalarLabels: Record<ScalarName, string> = {
  network: "Network",
  allowLocalBinding: "Local listeners",
  allowAppleEvents: "Apple Events",
  enableWeakerNetworkIsolation: "Weaker network isolation",
  onUnavailable: "When unavailable",
};

function newInput({ value }: { readonly value: string }): Input {
  const input = new Input(embeddedInputOptions);
  input.setValue(value);
  return input;
}

function blankCustomize(): Customize {
  return {
    mode: "customize",
    network: { mode: "omitted" },
    allowLocalBinding: { mode: "omitted" },
    allowAppleEvents: { mode: "omitted" },
    enableWeakerNetworkIsolation: { mode: "omitted" },
    onUnavailable: { mode: "omitted" },
    extraWritePaths: { mode: "inherit" },
    extraDenyReadPaths: { mode: "inherit" },
    extraDenyWritePaths: { mode: "inherit" },
    kernelUnenforcedProtectedPaths: { mode: "inherit" },
  };
}

function canonicalizeSandbox(value: RawSandboxAuthoring): RawSandboxAuthoring {
  const serialized = serializeSandboxAuthoring({ value });
  if (serialized === undefined) return { mode: "inherit" };
  if (serialized === false) return { mode: "disabled" };
  return decodeSandboxAuthoring({ raw: serialized });
}

function pathSetting(
  value: Customize,
  name: OverwritePathArrayName,
): PathArrayAuthoring {
  return value[name];
}

function withPathSetting(
  value: Customize,
  name: OverwritePathArrayName,
  setting: PathArrayAuthoring,
): Customize {
  switch (name) {
    case "extraWritePaths":
      return { ...value, extraWritePaths: setting };
    case "extraDenyReadPaths":
      return { ...value, extraDenyReadPaths: setting };
    case "extraDenyWritePaths":
      return { ...value, extraDenyWritePaths: setting };
    case "kernelUnenforcedProtectedPaths":
      return { ...value, kernelUnenforcedProtectedPaths: setting };
  }
}

function nextScalar(value: Customize, name: ScalarName): Customize {
  switch (name) {
    case "network":
      return {
        ...value,
        network:
          value.network.mode === "omitted"
            ? { mode: "local", value: "deny" }
            : { mode: "omitted" },
      };
    case "allowLocalBinding":
      return {
        ...value,
        allowLocalBinding:
          value.allowLocalBinding.mode === "omitted"
            ? { mode: "local", value: false }
            : { mode: "omitted" },
      };
    case "allowAppleEvents":
      return {
        ...value,
        allowAppleEvents:
          value.allowAppleEvents.mode === "omitted"
            ? { mode: "local", value: false }
            : { mode: "omitted" },
      };
    case "enableWeakerNetworkIsolation":
      return {
        ...value,
        enableWeakerNetworkIsolation:
          value.enableWeakerNetworkIsolation.mode === "omitted"
            ? { mode: "local", value: false }
            : { mode: "omitted" },
      };
    case "onUnavailable":
      return {
        ...value,
        onUnavailable:
          value.onUnavailable.mode === "omitted"
            ? { mode: "local", value: "block" }
            : { mode: "omitted" },
      };
  }
}

function toggleScalar(value: Customize, name: ScalarName): Customize {
  switch (name) {
    case "network":
      return value.network.mode === "local"
        ? {
            ...value,
            network: {
              mode: "local",
              value: value.network.value === "allow" ? "deny" : "allow",
            },
          }
        : value;
    case "allowLocalBinding":
      return value.allowLocalBinding.mode === "local"
        ? {
            ...value,
            allowLocalBinding: {
              mode: "local",
              value: !value.allowLocalBinding.value,
            },
          }
        : value;
    case "allowAppleEvents":
      return value.allowAppleEvents.mode === "local"
        ? {
            ...value,
            allowAppleEvents: {
              mode: "local",
              value: !value.allowAppleEvents.value,
            },
          }
        : value;
    case "enableWeakerNetworkIsolation":
      return value.enableWeakerNetworkIsolation.mode === "local"
        ? {
            ...value,
            enableWeakerNetworkIsolation: {
              mode: "local",
              value: !value.enableWeakerNetworkIsolation.value,
            },
          }
        : value;
    case "onUnavailable":
      return value.onUnavailable.mode === "local"
        ? {
            ...value,
            onUnavailable: {
              mode: "local",
              value: value.onUnavailable.value === "warn" ? "block" : "warn",
            },
          }
        : value;
  }
}

function scalarText(value: Customize, name: ScalarName): string {
  const setting = value[name];
  return setting.mode === "omitted" ? "inherit" : String(setting.value);
}

/** Edit the raw local declaration. Resolved parent state is context only. */
export async function editSandboxDeclaration({
  ctx,
  initial,
  resolvedParent,
  title,
  custom,
}: {
  readonly ctx: EditorContext;
  readonly initial: RawSandboxAuthoring | undefined;
  readonly resolvedParent: SandboxConfigOverride | false | undefined;
  readonly title: string;
  readonly custom?: ProfileAuthoringCustom;
}): Promise<MetadataEditorResult<RawSandboxAuthoring>> {
  let draft = canonicalizeSandbox(initial ?? { mode: "inherit" });
  const inputs = new Map<OverwritePathArrayName, Input[]>();
  const selectedRows = new Map<OverwritePathArrayName, number>();
  const rebuildInputs = () => {
    inputs.clear();
    if (draft.mode !== "customize") return;
    for (const name of overwritePathArrayNames) {
      const setting = pathSetting(draft, name);
      inputs.set(
        name,
        setting.mode === "inherit"
          ? []
          : setting.value.map((value) => newInput({ value })),
      );
      selectedRows.set(name, 0);
    }
  };
  rebuildInputs();

  const result = await showProfileAuthoringCustom<
    MetadataEditorResult<RawSandboxAuthoring>
  >({
    ctx,
    custom,
    factory: (tui, theme, _keys, done) => {
      let selected = 0;
      let error: string | undefined;
      const rowCount = () =>
        draft.mode === "customize"
          ? 1 + scalarNames.length + overwritePathArrayNames.length
          : 1;
      const selectedPath = () =>
        selected > scalarNames.length
          ? overwritePathArrayNames[selected - scalarNames.length - 1]
          : undefined;
      const syncPath = (name: OverwritePathArrayName) => {
        if (draft.mode !== "customize") return;
        const setting = pathSetting(draft, name);
        if (setting.mode === "inherit") return;
        const value = (inputs.get(name) ?? []).map((input) => input.getValue());
        draft = withPathSetting(draft, name, { mode: setting.mode, value });
      };
      const changePathMode = (name: OverwritePathArrayName) => {
        if (draft.mode !== "customize") return;
        syncPath(name);
        const setting = pathSetting(draft, name);
        const next: PathArrayAuthoring =
          setting.mode === "inherit"
            ? { mode: "append", value: [] }
            : setting.mode === "append"
              ? { mode: "overwrite", value: setting.value }
              : { mode: "inherit" };
        draft = withPathSetting(draft, name, next);
        inputs.set(
          name,
          next.mode === "inherit"
            ? []
            : next.value.map((value) => newInput({ value })),
        );
        selectedRows.set(name, 0);
      };
      const finish = (action: "save" | "back") => {
        for (const name of overwritePathArrayNames) syncPath(name);
        done({ action, draft: canonicalizeSandbox(draft) });
      };
      return {
        get focused() {
          const name = selectedPath();
          if (!name) return false;
          const index = selectedRows.get(name) ?? 0;
          return inputs.get(name)?.[index]?.focused ?? false;
        },
        set focused(value: boolean) {
          for (const collection of inputs.values())
            collection.forEach((input) => {
              input.focused = false;
            });
          const name = selectedPath();
          if (!name) return;
          const index = selectedRows.get(name) ?? 0;
          const input = inputs.get(name)?.[index];
          if (input) input.focused = value;
        },
        render(width: number) {
          const parent =
            resolvedParent === false
              ? "Parent context: sandbox explicitly disabled."
              : resolvedParent === undefined
                ? "Parent context: none (missing sandbox fails closed)."
                : `Parent context: network ${resolvedParent.network}; local listeners ${resolvedParent.allowLocalBinding ? "on" : "off"}; Apple Events ${resolvedParent.allowAppleEvents ? "on" : "off"}.`;
          const description = sectionDescriptionLines({
            width,
            presentation: metadataSectionPresentation.sandbox,
            purposeStyle: (text) => theme.fg("text", text),
            mutedStyle: (text) => theme.fg("dim", text),
          });
          const lines = [
            theme.fg("accent", theme.bold(title)),
            "",
            theme.fg("dim", parent),
            theme.fg("dim", sandboxInheritanceContext),
            "",
            ...description.purpose,
            "",
            ...description.examples,
            ...description.syntax,
            "",
            `${selected === 0 ? profileAuthoringSelectedRowMarker : profileAuthoringUnselectedRowMarker}Mode: ${draft.mode}`,
          ];
          if (draft.mode === "customize") {
            const customize = draft;
            scalarNames.forEach((name, index) =>
              lines.push(
                `${selected === index + 1 ? profileAuthoringSelectedRowMarker : profileAuthoringUnselectedRowMarker}${scalarLabels[name]}: ${scalarText(customize, name)}`,
              ),
            );
            overwritePathArrayNames.forEach((name, index) => {
              const setting = pathSetting(customize, name);
              const isSelected = selected === scalarNames.length + index + 1;
              lines.push(
                `${isSelected ? profileAuthoringSelectedRowMarker : profileAuthoringUnselectedRowMarker}${name}: ${setting.mode}`,
              );
              if (setting.mode !== "inherit") {
                const collection = inputs.get(name) ?? [];
                const selectedRow = selectedRows.get(name) ?? 0;
                lines.push(
                  ...(collection.length === 0
                    ? ["    (empty)"]
                    : collection.map(
                        (input, row) =>
                          `    ${isSelected && row === selectedRow ? profileAuthoringSelectedRowMarker : profileAuthoringUnselectedRowMarker}${input.render(Math.max(1, width - 6))[0] ?? ""}`,
                      )),
                );
              }
            });
          }
          if (error) lines.push(theme.fg("error", `Invalid: ${error}`));
          lines.push(
            theme.fg(
              "warning",
              "Network, listeners, Apple Events, and weaker isolation can expand capabilities.",
            ),
          );
          lines.push("");
          lines.push(theme.fg("dim", sandboxControls));
          return lines.map((line) => truncateToWidth(line, width));
        },
        invalidate() {
          inputs.forEach((collection) =>
            collection.forEach((input) => input.invalidate()),
          );
        },
        handleInput(data: string) {
          if (matchesKey(data, Key.enter)) finish("save");
          else if (matchesKey(data, Key.escape)) finish("back");
          else if (matchesKey(data, Key.up))
            selected = Math.max(0, selected - 1);
          else if (matchesKey(data, Key.down))
            selected = Math.min(rowCount() - 1, selected + 1);
          else if (matchesKey(data, Key.tab)) {
            if (selected === 0) {
              const next =
                draft.mode === "inherit"
                  ? blankCustomize()
                  : draft.mode === "customize"
                    ? { mode: "disabled" as const }
                    : { mode: "inherit" as const };
              // A customization that merely inherits a restrictive enabled
              // parent is not actionable and can accidentally normalize its
              // raw declaration. Require network before entering Customize.
              const effective = composeSandboxDeclarations(
                resolvedParent,
                serializeSandboxAuthoring({ value: next }),
              );
              if (
                next.mode === "customize" &&
                effective !== false &&
                effective !== undefined &&
                effective.network !== "allow"
              ) {
                error =
                  "Customize requires an effective enabled sandbox with network access.";
              } else {
                draft = next;
                error = undefined;
                rebuildInputs();
                selected = Math.min(selected, rowCount() - 1);
              }
            } else if (
              draft.mode === "customize" &&
              selected <= scalarNames.length
            ) {
              const name = scalarNames[selected - 1];
              if (name) draft = nextScalar(draft, name);
            } else {
              const name = selectedPath();
              if (name) changePathMode(name);
            }
          } else if (
            matchesKey(data, Key.left) ||
            matchesKey(data, Key.right)
          ) {
            if (
              draft.mode === "customize" &&
              selected > 0 &&
              selected <= scalarNames.length
            ) {
              const name = scalarNames[selected - 1];
              if (name) draft = toggleScalar(draft, name);
            }
          } else {
            const name = selectedPath();
            if (draft.mode === "customize" && name) {
              const collection = inputs.get(name) ?? [];
              const setting = pathSetting(draft, name);
              let row = selectedRows.get(name) ?? 0;
              if (
                matchesKey(data, Key.ctrl("n")) &&
                setting.mode !== "inherit"
              ) {
                collection.splice(
                  Math.min(row + 1, collection.length),
                  0,
                  newInput({ value: "" }),
                );
                row = Math.min(row + 1, collection.length - 1);
              } else if (
                matchesKey(data, Key.ctrl("d")) &&
                collection.length > 0
              ) {
                collection.splice(row, 1);
                row = Math.max(0, Math.min(row, collection.length - 1));
              } else collection[row]?.handleInput(data);
              inputs.set(name, collection);
              selectedRows.set(name, row);
              syncPath(name);
            }
          }
          tui.requestRender();
        },
      };
    },
  });
  return isProfileAuthoringAbort(result) ? null : result;
}

type SecurityExpansionSummary = {
  readonly unsafe: boolean;
  readonly warnings: readonly string[];
};

type EffectiveSandbox = SandboxConfigOverride | false | undefined;

/** Compare current and candidate effective sandboxes, not raw authoring. */
export function summarizeSandboxSecurityExpansion({
  current,
  candidate,
}: {
  readonly current: EffectiveSandbox;
  readonly candidate: EffectiveSandbox;
}): SecurityExpansionSummary {
  const warnings: string[] = [];
  if (candidate === false && current !== false)
    warnings.push(
      current === undefined
        ? "Disables the fail-closed no-parent sandbox baseline."
        : "Disables the resolved sandbox.",
    );
  if (candidate === false) return { unsafe: warnings.length > 0, warnings };
  const before = current || {};
  const after = candidate || {};
  if (after.network === "allow" && before.network !== "allow")
    warnings.push("Adds external network access.");
  if (after.allowLocalBinding && !before.allowLocalBinding)
    warnings.push("Adds local socket or loopback listeners.");
  if (after.allowAppleEvents && !before.allowAppleEvents)
    warnings.push("Adds Apple Events or LaunchServices access.");
  if (
    after.enableWeakerNetworkIsolation &&
    !before.enableWeakerNetworkIsolation
  )
    warnings.push("Enables weaker network isolation.");
  if (after.onUnavailable === "warn" && before.onUnavailable !== "warn")
    warnings.push("Adds warn-and-continue sandbox fallback.");
  for (const name of overwritePathArrayNames) {
    const oldPaths = before[name] ?? [];
    const newPaths = after[name] ?? [];
    if (
      name === "extraWritePaths" &&
      newPaths.some((value) => !oldPaths.includes(value))
    )
      warnings.push("Adds writable sandbox roots.");
    if (
      name === "kernelUnenforcedProtectedPaths" &&
      newPaths.some((value) => !oldPaths.includes(value))
    )
      warnings.push("Adds protected-path kernel waivers.");
    if (
      name === "extraDenyReadPaths" &&
      oldPaths.some((value) => !newPaths.includes(value))
    )
      warnings.push("Removes inherited read denies.");
    if (
      name === "extraDenyWritePaths" &&
      oldPaths.some((value) => !newPaths.includes(value))
    )
      warnings.push("Removes inherited write denies.");
  }
  return { unsafe: warnings.length > 0, warnings };
}

/**
 * Conservative confirmation heuristic. Glob containment is deliberately not
 * inferred from specificity: equal-specificity and disjoint patterns can
 * select different directories. Until matcher-set containment is proven, only
 * an identical ordered declaration is known not to broaden activation.
 */
export function isConservativelyBroadDirectoryActivation({
  candidate,
  existing,
}: {
  readonly candidate: readonly string[];
  readonly existing: readonly string[];
}): boolean {
  return (
    candidate.length !== existing.length ||
    candidate.some((glob, index) => glob !== existing[index])
  );
}
