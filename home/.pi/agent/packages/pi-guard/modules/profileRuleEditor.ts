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
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  readPathContexts,
  writePathContexts,
  type PathContext,
  type ReadPathContext,
  type WritePathContext,
} from "./policyHelpers";
import type { OrdinaryPathRuleKind, RuleKind } from "./profileConfig";
import type { ProfileConfigProfile } from "./policyHelpers";

export type RuleSectionEdit<T> =
  { readonly mode: "omit" } | { readonly mode: "set"; readonly value: T };
type ProfileRuleSectionEdits = {
  readonly bash: RuleSectionEdit<
    NonNullable<NonNullable<ProfileConfigProfile["tools"]>["bash"]>
  >;
  readonly readPaths: RuleSectionEdit<
    NonNullable<ProfileConfigProfile["readPaths"]>
  >;
  readonly writePaths: RuleSectionEdit<
    NonNullable<ProfileConfigProfile["writePaths"]>
  >;
  readonly protectedPathRules: RuleSectionEdit<
    NonNullable<ProfileConfigProfile["protectedPathRules"]>
  >;
};
import {
  renderPurposePresentation,
  profileAuthoringSelectedRowMarker,
  profileAuthoringUnselectedRowMarker,
  ruleSectionPresentation,
  type RuleSectionPresentation,
} from "./profileAuthoringPresentation";

type TextStyle = (text: string) => string;

function sectionDescriptionLines({
  width,
  presentation,
  purposeStyles,
  mutedStyle,
}: {
  readonly width: number;
  readonly presentation: RuleSectionPresentation;
  readonly purposeStyles: {
    readonly normal: TextStyle;
    readonly deny: TextStyle;
    readonly allow: TextStyle;
  };
  readonly mutedStyle: TextStyle;
}): {
  readonly purpose: string[];
  readonly examples: string[];
  readonly syntax: string[];
} {
  return {
    purpose: wrapTextWithAnsi(
      renderPurposePresentation({
        purpose: presentation.purposePresentation,
        styles: purposeStyles,
      }),
      width,
    ),
    examples: wrapTextWithAnsi(mutedStyle(presentation.examples), width),
    syntax: wrapTextWithAnsi(mutedStyle(presentation.syntax), width),
  };
}

const emptyRuleSectionMessage = "No rules in this section. Ctrl+N adds one.";
/** Row labels own the selection indicator, so embedded Inputs need no prompt. */
const embeddedInputOptions = { prompt: "" } as const;

function newEmbeddedInput({ value }: { readonly value: string }): Input {
  const input = new Input(embeddedInputOptions);
  input.setValue(value);
  return input;
}

export type AskRuleCandidate =
  | {
      kind: "bash";
      requestedValue: string;
      initialPattern: string;
      currentDecision: "ask";
      matchedRule?: string;
      /** Exact persisted pattern identity used by context-aware replacement. */
      matchedPattern?: string;
    }
  | {
      kind: OrdinaryPathRuleKind;
      context: PathContext;
      requestedValue: string;
      initialPattern: string;
      currentDecision: "ask";
      matchedRule?: string;
      /** Exact persisted pattern identity used by context-aware replacement. */
      matchedPattern?: string;
      source: { tool: string; role?: string };
    };

export type EditableRuleRow = {
  id: string;
  kind: RuleKind;
  pattern: string;
  /** `ask` is a durable decision only when the row belongs to edit mode. */
  decision: "allow" | "ask" | "deny" | "skip";
  guidance?: string;
  contexts?: readonly PathContext[];
  request?: AskRuleCandidate;
  origin: "request" | "additional" | "create" | "existing";
};

type BashDeclaration = NonNullable<
  NonNullable<ProfileConfigProfile["tools"]>["bash"]
>[number];
type ReadDeclaration = NonNullable<ProfileConfigProfile["readPaths"]>[number];
type WriteDeclaration = NonNullable<ProfileConfigProfile["writePaths"]>[number];
type ProtectedDeclaration = NonNullable<
  ProfileConfigProfile["protectedPathRules"]
>[number];

type SectionKind = RuleKind;
type DeclarationFor<K extends SectionKind> = K extends "bash"
  ? BashDeclaration
  : K extends "read"
    ? ReadDeclaration
    : K extends "write"
      ? WriteDeclaration
      : ProtectedDeclaration;
/** A destination-fixed raw declaration row used by `/profile-edit`. */
type ProfileRuleEditRow<K extends SectionKind> = {
  readonly id: string;
  readonly kind: K;
  readonly raw: DeclarationFor<K>;
};

export type RuleEditorOptions = {
  mode: "ask" | "create" | "edit";
  rows: readonly EditableRuleRow[];
  /** CREATE sections use a fixed kind. ASK editors may contain mixed kinds. */
  kind?: RuleKind;
  title: string;
  allowAddRemove?: boolean;
  defaultKind?: RuleKind;
  defaultDecision?: "allow" | "deny";
};

export type RuleEditorResult = {
  action: "back" | "save" | "clear";
  rows: EditableRuleRow[];
};

export function ruleDestination(kind: RuleKind): string {
  return kind === "bash"
    ? "tools.bash"
    : kind === "read"
      ? "readPaths"
      : kind === "write"
        ? "writePaths"
        : "protectedPathRules";
}

export function ruleEffect(kind: RuleKind, decision: "allow" | "deny"): string {
  if (kind === "protected")
    return decision === "deny"
      ? "Blocks both reads and writes."
      : "Only exempts a broader protected deny; grants no read or write permission.";
  if (kind === "read")
    return decision === "allow"
      ? "Allows this read context; writes are unaffected."
      : "Denies this read context; writes are unaffected.";
  if (kind === "write")
    return decision === "allow"
      ? "Allows this write context; read-tool access is unaffected."
      : "Denies this write context; read-tool access is unaffected.";
  return decision === "allow"
    ? "Allows this Bash command."
    : "Denies this Bash command.";
}

export function isBroaderPattern(row: EditableRuleRow): boolean {
  return Boolean(
    row.request && row.pattern.trim() !== row.request.initialPattern.trim(),
  );
}

function copyRow(row: EditableRuleRow): EditableRuleRow {
  return { ...row, contexts: row.contexts ? [...row.contexts] : undefined };
}

const contextsByKind: Record<OrdinaryPathRuleKind, readonly PathContext[]> = {
  read: readPathContexts,
  write: writePathContexts,
};

function sameContexts(
  first: readonly PathContext[] | undefined,
  second: readonly PathContext[] | undefined,
): boolean {
  return (
    first === second ||
    (first !== undefined &&
      second !== undefined &&
      first.length === second.length &&
      first.every((context, index) => context === second[index]))
  );
}

/** Convert exact local declarations into rows without resolving inheritance. */
export function profileRuleEditRows<K extends SectionKind>(
  kind: K,
  rules: readonly DeclarationFor<K>[],
): readonly ProfileRuleEditRow<K>[] {
  return rules.map((raw, index) => ({ id: `${kind}-${index}`, kind, raw }));
}

type AnyProfileRuleEditRow =
  | ProfileRuleEditRow<"bash">
  | ProfileRuleEditRow<"read">
  | ProfileRuleEditRow<"write">
  | ProfileRuleEditRow<"protected">;

function editableExistingRow(row: AnyProfileRuleEditRow): EditableRuleRow {
  if (row.kind === "bash")
    return {
      id: row.id,
      kind: row.kind,
      pattern: row.raw.pattern,
      decision: row.raw.decision,
      guidance: row.raw.guidance,
      origin: "existing",
    };
  if (row.kind === "protected")
    return {
      id: row.id,
      kind: row.kind,
      pattern: row.raw.pattern,
      decision: row.raw.decision,
      guidance: row.raw.guidance,
      origin: "existing",
    };
  return {
    id: row.id,
    kind: row.kind,
    pattern: row.raw.pattern,
    decision: row.raw.decision,
    guidance: row.raw.guidance,
    contexts: row.raw.contexts,
    origin: "existing",
  };
}

function durableDecision(row: EditableRuleRow): "allow" | "ask" | "deny" {
  if (row.decision === "skip")
    throw new Error("skip is not valid in an edit section");
  return row.decision;
}
function protectedDecision(row: EditableRuleRow): "allow" | "deny" {
  const decision = durableDecision(row);
  if (decision === "ask")
    throw new Error("ask is not valid for protected rules");
  return decision;
}
function bashRows(
  initial: readonly ProfileRuleEditRow<"bash">[],
  rows: readonly EditableRuleRow[],
): BashDeclaration[] {
  const original = new Map(initial.map((row) => [row.id, row.raw]));
  return rows.map((row) => {
    const raw = original.get(row.id);
    const decision = durableDecision(row);
    if (
      raw &&
      raw.pattern === row.pattern &&
      raw.decision === decision &&
      raw.guidance === row.guidance
    )
      return raw;
    return { ...raw, pattern: row.pattern, decision, guidance: row.guidance };
  });
}
function isReadContext(context: PathContext): context is ReadPathContext {
  return (
    context === "read" ||
    context === "grep" ||
    context === "find" ||
    context === "ls"
  );
}
function isWriteContext(context: PathContext): context is WritePathContext {
  return context === "edit" || context === "write" || context === "bash";
}
function readContexts(
  contexts: readonly PathContext[] | undefined,
): ReadPathContext[] | undefined {
  if (contexts === undefined) return undefined;
  if (!contexts.every(isReadContext))
    throw new Error("read rule contexts must be read contexts");
  return [...contexts];
}
function writeContexts(
  contexts: readonly PathContext[] | undefined,
): WritePathContext[] | undefined {
  if (contexts === undefined) return undefined;
  if (!contexts.every(isWriteContext))
    throw new Error("write rule contexts must be write contexts");
  return [...contexts];
}
function readRows(
  initial: readonly ProfileRuleEditRow<"read">[],
  rows: readonly EditableRuleRow[],
): ReadDeclaration[] {
  const original = new Map(initial.map((row) => [row.id, row.raw]));
  return rows.map((row) => {
    const raw = original.get(row.id);
    const decision = durableDecision(row);
    if (
      raw &&
      raw.pattern === row.pattern &&
      raw.decision === decision &&
      raw.guidance === row.guidance &&
      sameContexts(raw.contexts, row.contexts)
    )
      return raw;
    const rest = { ...raw };
    delete rest.contexts;
    const contexts = readContexts(row.contexts);
    return {
      ...rest,
      pattern: row.pattern,
      decision,
      guidance: row.guidance,
      ...(contexts === undefined ? {} : { contexts }),
    };
  });
}
function writeRows(
  initial: readonly ProfileRuleEditRow<"write">[],
  rows: readonly EditableRuleRow[],
): WriteDeclaration[] {
  const original = new Map(initial.map((row) => [row.id, row.raw]));
  return rows.map((row) => {
    const raw = original.get(row.id);
    const decision = durableDecision(row);
    if (
      raw &&
      raw.pattern === row.pattern &&
      raw.decision === decision &&
      raw.guidance === row.guidance &&
      sameContexts(raw.contexts, row.contexts)
    )
      return raw;
    const rest = { ...raw };
    delete rest.contexts;
    const contexts = writeContexts(row.contexts);
    return {
      ...rest,
      pattern: row.pattern,
      decision,
      guidance: row.guidance,
      ...(contexts === undefined ? {} : { contexts }),
    };
  });
}
function protectedRows(
  initial: readonly ProfileRuleEditRow<"protected">[],
  rows: readonly EditableRuleRow[],
): ProtectedDeclaration[] {
  const original = new Map(initial.map((row) => [row.id, row.raw]));
  return rows.map((row) => {
    const raw = original.get(row.id);
    const decision = protectedDecision(row);
    if (
      raw &&
      raw.pattern === row.pattern &&
      raw.decision === decision &&
      raw.guidance === row.guidance
    )
      return raw;
    return { ...raw, pattern: row.pattern, decision, guidance: row.guidance };
  });
}

/** Destination-specific arguments preserve the declaration return type. */
type RuleSectionSerializationOptions =
  | {
      readonly kind: "bash";
      readonly initial: readonly ProfileRuleEditRow<"bash">[];
      readonly rows: readonly EditableRuleRow[];
      readonly preserveExplicitEmpty?: boolean;
    }
  | {
      readonly kind: "read";
      readonly initial: readonly ProfileRuleEditRow<"read">[];
      readonly rows: readonly EditableRuleRow[];
      readonly preserveExplicitEmpty?: boolean;
    }
  | {
      readonly kind: "write";
      readonly initial: readonly ProfileRuleEditRow<"write">[];
      readonly rows: readonly EditableRuleRow[];
      readonly preserveExplicitEmpty?: boolean;
    }
  | {
      readonly kind: "protected";
      readonly initial: readonly ProfileRuleEditRow<"protected">[];
      readonly rows: readonly EditableRuleRow[];
      readonly preserveExplicitEmpty?: boolean;
    };

export function serializeProfileRuleSectionEdit({
  kind,
  initial,
  rows,
  preserveExplicitEmpty,
}: Extract<
  RuleSectionSerializationOptions,
  { readonly kind: "bash" }
>): ProfileRuleSectionEdits["bash"];
export function serializeProfileRuleSectionEdit({
  kind,
  initial,
  rows,
  preserveExplicitEmpty,
}: Extract<
  RuleSectionSerializationOptions,
  { readonly kind: "read" }
>): ProfileRuleSectionEdits["readPaths"];
export function serializeProfileRuleSectionEdit({
  kind,
  initial,
  rows,
  preserveExplicitEmpty,
}: Extract<
  RuleSectionSerializationOptions,
  { readonly kind: "write" }
>): ProfileRuleSectionEdits["writePaths"];
export function serializeProfileRuleSectionEdit({
  kind,
  initial,
  rows,
  preserveExplicitEmpty,
}: Extract<
  RuleSectionSerializationOptions,
  { readonly kind: "protected" }
>): ProfileRuleSectionEdits["protectedPathRules"];
export function serializeProfileRuleSectionEdit(
  options: RuleSectionSerializationOptions,
): RuleSectionEdit<readonly unknown[]>;
export function serializeProfileRuleSectionEdit({
  kind,
  initial,
  rows,
  preserveExplicitEmpty = false,
}: RuleSectionSerializationOptions): RuleSectionEdit<readonly unknown[]> {
  if (initial.some((row) => row.kind !== kind))
    throw new Error(`initial row kind does not match ${kind} section`);
  if (rows.some((row) => row.kind !== kind))
    throw new Error(`row kind does not match ${kind} section`);
  if (
    (kind === "bash" || kind === "protected") &&
    rows.some((row) => row.contexts !== undefined)
  )
    throw new Error(`contexts are not valid for ${kind} rules`);
  if (
    kind === "read" &&
    rows.some(
      (row) =>
        row.contexts !== undefined &&
        row.contexts.some((context) => !isReadContext(context)),
    )
  )
    throw new Error("read rule contexts must be read contexts");
  if (
    kind === "write" &&
    rows.some(
      (row) =>
        row.contexts !== undefined &&
        row.contexts.some((context) => !isWriteContext(context)),
    )
  )
    throw new Error("write rule contexts must be write contexts");
  if (rows.length === 0)
    return initial.length === 0 && preserveExplicitEmpty
      ? { mode: "set", value: [] }
      : { mode: "omit" };
  if (kind === "bash") return { mode: "set", value: bashRows(initial, rows) };
  if (kind === "read") return { mode: "set", value: readRows(initial, rows) };
  if (kind === "write") return { mode: "set", value: writeRows(initial, rows) };
  return { mode: "set", value: protectedRows(initial, rows) };
}

type RuleSectionEditorContext = {
  readonly ctx: ExtensionContext;
  readonly mode: "create" | "edit";
  readonly title: string;
  readonly preserveExplicitEmpty?: boolean;
  readonly custom?: ProfileAuthoringCustom;
};
type RuleSectionEditorOptions = RuleSectionEditorContext &
  (
    | {
        readonly kind: "bash";
        readonly initial: readonly ProfileRuleEditRow<"bash">[];
      }
    | {
        readonly kind: "read";
        readonly initial: readonly ProfileRuleEditRow<"read">[];
      }
    | {
        readonly kind: "write";
        readonly initial: readonly ProfileRuleEditRow<"write">[];
      }
    | {
        readonly kind: "protected";
        readonly initial: readonly ProfileRuleEditRow<"protected">[];
      }
  );

export function editProfileRuleSection({
  ctx,
  kind,
  initial,
  title,
  preserveExplicitEmpty,
}: Extract<RuleSectionEditorOptions, { readonly kind: "bash" }>): Promise<{
  action: RuleEditorResult["action"];
  edit: ProfileRuleSectionEdits["bash"];
}>;
export function editProfileRuleSection({
  ctx,
  kind,
  initial,
  title,
  preserveExplicitEmpty,
}: Extract<RuleSectionEditorOptions, { readonly kind: "read" }>): Promise<{
  action: RuleEditorResult["action"];
  edit: ProfileRuleSectionEdits["readPaths"];
}>;
export function editProfileRuleSection({
  ctx,
  kind,
  initial,
  title,
  preserveExplicitEmpty,
}: Extract<RuleSectionEditorOptions, { readonly kind: "write" }>): Promise<{
  action: RuleEditorResult["action"];
  edit: ProfileRuleSectionEdits["writePaths"];
}>;
export function editProfileRuleSection({
  ctx,
  kind,
  initial,
  title,
  preserveExplicitEmpty,
}: Extract<RuleSectionEditorOptions, { readonly kind: "protected" }>): Promise<{
  action: RuleEditorResult["action"];
  edit: ProfileRuleSectionEdits["protectedPathRules"];
}>;
export function editProfileRuleSection(
  options: RuleSectionEditorOptions,
): Promise<{
  action: RuleEditorResult["action"];
  edit: RuleSectionEdit<readonly unknown[]>;
}>;
export async function editProfileRuleSection(
  options: RuleSectionEditorOptions,
): Promise<{
  action: RuleEditorResult["action"];
  edit: RuleSectionEdit<readonly unknown[]>;
}> {
  const { ctx, kind, initial, title } = options;
  const result = await editProfileRuleRows({
    ctx,
    custom: options.custom,
    options: {
      mode: options.mode,
      kind,
      title,
      rows: initial.map(editableExistingRow),
      allowAddRemove: true,
    },
  });
  if (result.action === "clear")
    return { action: result.action, edit: { mode: "set", value: [] } };
  if (options.kind === "bash")
    return {
      action: result.action,
      edit: serializeProfileRuleSectionEdit({ ...options, rows: result.rows }),
    };
  if (options.kind === "read")
    return {
      action: result.action,
      edit: serializeProfileRuleSectionEdit({ ...options, rows: result.rows }),
    };
  if (options.kind === "write")
    return {
      action: result.action,
      edit: serializeProfileRuleSectionEdit({ ...options, rows: result.rows }),
    };
  return {
    action: result.action,
    edit: serializeProfileRuleSectionEdit({ ...options, rows: result.rows }),
  };
}

/** Production-owned multi-row editor shared by ASK, CREATE, and local edits. */
export async function editProfileRuleRows({
  ctx,
  options,
  custom,
}: {
  readonly ctx: { readonly ui: Pick<ExtensionContext["ui"], "custom"> };
  readonly options: RuleEditorOptions;
  readonly custom?: ProfileAuthoringCustom;
}): Promise<RuleEditorResult> {
  const initialRows = options.rows.map(copyRow);
  const rows: EditableRuleRow[] = options.rows.map(copyRow);
  const inputs: Input[] = [];
  const guidanceInputs: Input[] = [];
  const attachInputs = (row: EditableRuleRow) => {
    inputs.push(newEmbeddedInput({ value: row.pattern }));
    guidanceInputs.push(newEmbeddedInput({ value: row.guidance ?? "" }));
  };
  rows.forEach(attachInputs);

  const snapshot = (): EditableRuleRow[] =>
    rows.map((row, index) => ({
      ...row,
      pattern: inputs[index]?.getValue().trim() ?? row.pattern,
      guidance: guidanceInputs[index]?.getValue().trim() || undefined,
    }));
  const result = await showProfileAuthoringCustom<RuleEditorResult | null>({
    ctx,
    custom,
    factory: (tui, theme, _keys, done) => {
      let selected = 0;
      let guidanceFocused = false;
      const finish = (action: RuleEditorResult["action"]) =>
        done({
          action,
          rows: snapshot(),
        });
      const submit = () => {
        const current = snapshot();
        if (
          options.mode === "ask" &&
          current.every((row) => row.decision === "skip")
        )
          return;
        if (
          current.some(
            (row) => row.decision !== "skip" && row.pattern.length === 0,
          )
        )
          return;
        finish("save");
      };
      const wire = (input: Input) => {
        input.onSubmit = submit;
        input.onEscape = () => finish("back");
      };
      [...inputs, ...guidanceInputs].forEach(wire);
      const addRow = () => {
        const selectedRow = rows[selected];
        const row: EditableRuleRow = {
          id: `additional-${crypto.randomUUID()}`,
          kind:
            options.kind ?? selectedRow?.kind ?? options.defaultKind ?? "bash",
          pattern: "",
          decision: options.defaultDecision ?? "deny",
          contexts: selectedRow?.contexts,
          origin: options.mode === "ask" ? "additional" : "create",
        };
        rows.push(row);
        attachInputs(row);
        wire(inputs.at(-1)!);
        wire(guidanceInputs.at(-1)!);
        selected = rows.length - 1;
        guidanceFocused = false;
      };
      const removeRow = () => {
        if (rows[selected]?.origin === "request") return;
        rows.splice(selected, 1);
        inputs.splice(selected, 1);
        guidanceInputs.splice(selected, 1);
        selected = Math.max(0, Math.min(selected, rows.length - 1));
        guidanceFocused = false;
      };
      const reset = () => {
        rows.splice(0, rows.length, ...initialRows.map(copyRow));
        inputs.splice(0);
        guidanceInputs.splice(0);
        rows.forEach(attachInputs);
        [...inputs, ...guidanceInputs].forEach(wire);
        selected = 0;
        guidanceFocused = false;
      };

      return {
        get focused() {
          return (
            (guidanceFocused ? guidanceInputs[selected] : inputs[selected])
              ?.focused ?? false
          );
        },
        set focused(value: boolean) {
          inputs.forEach(
            (input, index) =>
              (input.focused = value && index === selected && !guidanceFocused),
          );
          guidanceInputs.forEach(
            (input, index) =>
              (input.focused = value && index === selected && guidanceFocused),
          );
        },
        render: (width) => {
          const current = snapshot();
          const changed = current.filter((row) => row.decision !== "skip");
          const invalid = changed.some((row) => !row.pattern);
          const description = options.kind
            ? sectionDescriptionLines({
                width,
                presentation: ruleSectionPresentation[options.kind],
                purposeStyles: {
                  normal: (text) => theme.fg("text", text),
                  deny: (text) => theme.fg("error", text),
                  allow: (text) => theme.fg("success", text),
                },
                mutedStyle: (text) => theme.fg("dim", text),
              })
            : undefined;
          return [
            theme.fg(
              "accent",
              theme.bold(
                options.mode === "ask"
                  ? options.title.replace(
                      /\b\d+ profile changes?\b/,
                      `${changed.length} profile change${changed.length === 1 ? "" : "s"}`,
                    )
                  : options.title,
              ),
            ),
            "",
            ...(description ? description.purpose : []),
            ...(description ? [""] : []),
            ...(description
              ? [...description.examples, ...description.syntax]
              : []),
            ...(description ? [""] : []),
            ...(current.length === 0
              ? [theme.fg("warning", emptyRuleSectionMessage)]
              : []),
            ...current.flatMap((row, index) => {
              const decision = row.decision;
              const mark =
                decision === "allow"
                  ? "✅"
                  : decision === "deny"
                    ? "⛔️"
                    : decision === "ask"
                      ? "❓"
                      : "⏭️";
              const request = row.request;
              const destination = `profile ${ruleDestination(row.kind)}`;
              const lines = [
                `${
                  index === selected
                    ? profileAuthoringSelectedRowMarker
                    : profileAuthoringUnselectedRowMarker
                }${ruleSectionPresentation[row.kind].label} ${mark} ${
                  inputs[index]?.render(Math.max(1, width - 26))[0] ?? ""
                }`,
              ];
              if (request) {
                lines.push(`    Requested value  ${request.requestedValue}`);
                if (request.kind !== "bash")
                  lines.push(
                    `    Context/source   ${request.context} · ${request.source.tool}${request.source.role ? ` (${request.source.role})` : ""}`,
                  );
                lines.push(
                  `    Matched rule     ${request.matchedRule ?? "none (fallback ASK)"}`,
                );
              } else if (row.origin === "additional") {
                lines.push(
                  "    Additional profile rule (not required by this ASK)",
                );
              }
              if (row.kind === "read" || row.kind === "write")
                lines.push(
                  "    PATH GLOB/PATTERN — interpreted as a glob, not a literal path (e.g. src/**/*.ts).",
                );
              if (!request && (row.kind === "read" || row.kind === "write"))
                lines.push(
                  `    Context          ${row.contexts?.join(", ") ?? "all contexts"}`,
                );
              lines.push(
                `    Writes to        ${destination}`,
                options.mode === "edit"
                  ? `    Local decision  ${decision === "ask" ? "❓ ASK" : decision === "allow" ? "✅ ALLOW" : "⛔️ DENY"}`
                  : `    Effective change ${decision === "skip" ? "unchanged; remains ASK" : `ASK → ${decision === "allow" ? "✅ ALLOW" : "⛔️ DENY"}`}`,
              );
              if (decision === "allow" || decision === "deny")
                lines.push(
                  `    Effect           ${ruleEffect(row.kind, decision)}`,
                );
              if (request && isBroaderPattern(row))
                lines.push(
                  "    ⚠ Broader/custom pattern: this rule may affect paths beyond this request.",
                );
              if (decision === "deny" && row.kind !== "protected")
                lines.push(
                  `${
                    index === selected && guidanceFocused
                      ? profileAuthoringSelectedRowMarker
                      : profileAuthoringUnselectedRowMarker
                  }  Guidance         ${
                    guidanceInputs[index]?.getValue()
                      ? guidanceInputs[index]?.render(
                          Math.max(1, width - 24),
                        )[0]
                      : theme.fg("dim", "Add persistent steering…")
                  }`,
                );
              return lines;
            }),
            "",
            theme.fg(
              "dim",
              options.mode === "ask" && changed.length === 0
                ? "Save disabled: every row is skipped. Tab a row to allow or deny."
                : invalid
                  ? "Save disabled: changed rules need a pattern."
                  : options.mode === "ask"
                    ? `Enter save ${changed.length} rule${changed.length === 1 ? "" : "s"} and re-check request · Tab allow/deny/skip · Ctrl+N add · Ctrl+K kind · Ctrl+X context · Esc Back`
                    : options.mode === "edit"
                      ? "Enter save local rules · Tab allow/deny/ask · Ctrl+N add · Ctrl+D remove · Ctrl+X context · Ctrl+Shift+R clear · Esc Back"
                      : "Enter save section · Tab allow/deny · Ctrl+N add · Ctrl+D remove · Ctrl+X context · Ctrl+Shift+R clear · Esc Back",
            ),
          ].map((line) => truncateToWidth(line, width));
        },
        invalidate: () => {
          inputs.forEach((input) => input.invalidate());
          guidanceInputs.forEach((input) => input.invalidate());
        },
        handleInput: (data) => {
          // Empty forms have no Input to receive Escape, so handle it before
          // forwarding input. Populated forms retain their existing onEscape.
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
            finish("back");
          } else if (matchesKey(data, Key.ctrlShift("r"))) {
            if (options.mode === "ask") reset();
            else finish("clear");
          } else if (matchesKey(data, Key.ctrl("n"))) {
            if (options.allowAddRemove !== false) addRow();
          } else if (matchesKey(data, Key.ctrl("d"))) {
            if (options.allowAddRemove !== false) removeRow();
          } else if (matchesKey(data, Key.ctrl("k"))) {
            const row = rows[selected];
            if (row?.origin === "additional" && options.kind === undefined) {
              const kinds: RuleKind[] = ["bash", "read", "write"];
              row.kind =
                kinds[(kinds.indexOf(row.kind) + 1) % kinds.length] ?? "bash";
              row.contexts = undefined;
            }
          } else if (matchesKey(data, Key.ctrl("x"))) {
            const row = rows[selected];
            if (
              row &&
              row.origin !== "request" &&
              (row.kind === "read" || row.kind === "write")
            ) {
              const contexts = contextsByKind[row.kind];
              const current =
                row.contexts?.length === 1
                  ? contexts.indexOf(row.contexts[0])
                  : -1;
              const next = current + 1;
              row.contexts =
                next >= contexts.length ? undefined : [contexts[next]];
            }
          } else if (matchesKey(data, Key.up)) {
            if (guidanceFocused) guidanceFocused = false;
            else selected = Math.max(0, selected - 1);
          } else if (matchesKey(data, Key.down)) {
            if (
              !guidanceFocused &&
              rows[selected]?.decision === "deny" &&
              rows[selected]?.kind !== "protected"
            )
              guidanceFocused = true;
            else {
              guidanceFocused = false;
              selected = Math.min(rows.length - 1, selected + 1);
            }
          } else if (matchesKey(data, Key.tab)) {
            const row = rows[selected];
            if (row) {
              row.decision =
                options.mode === "ask"
                  ? row.decision === "allow"
                    ? "deny"
                    : row.decision === "deny"
                      ? "skip"
                      : "allow"
                  : options.mode === "edit" && row.kind !== "protected"
                    ? row.decision === "allow"
                      ? "deny"
                      : row.decision === "deny"
                        ? "ask"
                        : "allow"
                    : row.decision === "allow"
                      ? "deny"
                      : "allow";
              if (row.decision !== "deny") guidanceFocused = false;
            }
          } else {
            (guidanceFocused
              ? guidanceInputs[selected]
              : inputs[selected]
            )?.handleInput(data);
          }
          tui.requestRender();
        },
      };
    },
  });

  if (isProfileAuthoringAbort(result))
    return { action: "back", rows: snapshot() };
  return result ?? { action: "back", rows: snapshot() };
}
