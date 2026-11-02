import {
  customToolNameError,
  readPathContexts,
  writePathContexts,
  type CustomToolRule,
  type Decision,
  type PathContext,
  type ReadPathRule,
} from "./policyHelpers";
import type { RuleKind } from "./profileConfig";

/** The built-in targets are derived from the profile rule destination type. */
export const builtInRuleKinds = [
  "bash",
  "read",
  "write",
  "protected",
] as const satisfies readonly RuleKind[];
export type BuiltInRuleKind = (typeof builtInRuleKinds)[number];
/** Inline ASK may author only rules that can be persisted by the guard. */
export const inlineAskBuiltInRuleKinds = [
  "bash",
  "read",
  "write",
] as const satisfies readonly BuiltInRuleKind[];
/** `skip` is editor-only; every durable decision comes from policyHelpers. */
export type RuleDecision = Decision | "skip";
export type RuleOrigin = "request" | "existing" | "additional" | "create";
type RuleEditorFocus = "tool" | "path" | "pattern" | "guidance";

export type GlobMatcher = { readonly kind: "glob"; readonly pattern: string };
/** Read rules may match their whole pattern literally instead of as a glob. */
export type ReadPathMatch = NonNullable<ReadPathRule["pathMatch"]>;
/** Canonical clause state. Every clause is identified before it enters state. */
type RuleInput = {
  readonly id: string;
  readonly inputPath: string;
  readonly matcher: GlobMatcher;
};
/** Unidentified data is accepted only at the creation boundary, never in state. */
type RuleInputCreation = {
  readonly inputPath: string;
  readonly matcher: GlobMatcher;
};
export type RuleCreation = Omit<Rule, "inputs"> & {
  readonly inputs: readonly (RuleInput | RuleInputCreation)[];
};
export type EditableRuleCreation = Omit<EditableRule, "rule"> & {
  readonly rule: RuleCreation;
};
/** The transport-independent, plain-data policy editor rule. */
type Rule = {
  readonly toolName: string;
  readonly inputs: readonly RuleInput[];
  readonly contexts?: readonly PathContext[];
  /** Read targets only; carried through the editor, never edited by it. */
  readonly pathMatch?: ReadPathMatch;
  readonly decision: RuleDecision;
  readonly guidance?: string;
  /** Only an intentional edit may replace an adapter-owned raw value. */
  readonly guidanceTouched?: boolean;
};
export type EditableRule = {
  readonly id: string;
  readonly rule: Rule;
  readonly origin: RuleOrigin;
};
type IssuedClauseOwner = {
  readonly clauseId: string;
  readonly ruleId: string;
};
type IssuedRuleOrigin = {
  readonly ruleId: string;
  readonly origin: RuleOrigin;
};
export type RuleEditorState = {
  /** Immutable snapshot captured when this editor invocation opened. */
  readonly baseline: readonly EditableRule[];
  /** Current invocation draft. */
  readonly rows: readonly EditableRule[];
  /** Every rule identity issued for this editor invocation, including removed rows. */
  readonly issuedRuleIds: readonly string[];
  /** Immutable clause-to-rule ownership for every identity issued in this invocation. */
  readonly issuedClauseOwner: readonly IssuedClauseOwner[];
  /** Immutable origin association for every rule identity issued in this invocation. */
  readonly issuedRuleOrigin: readonly IssuedRuleOrigin[];
  readonly selected: number;
  readonly clause: number;
  readonly field: RuleEditorFocus;
};

export type RuleEditorOptions = {
  readonly mode: "ask" | "create" | "edit";
  readonly lockedToolName?: string;
  readonly allowAddRemove?: boolean;
  readonly clearAvailable?: boolean;
  readonly builtin?: {
    readonly allowedTools: readonly BuiltInRuleKind[];
    readonly defaultTool: BuiltInRuleKind;
    readonly defaultDecision?: "allow" | "deny";
  };
};

export type RuleEditorAction =
  | { readonly type: "set-field-value"; readonly value: string }
  | { readonly type: "cycle-built-in-target"; readonly ruleId: string }
  | { readonly type: "focus"; readonly field: RuleEditorFocus }
  | { readonly type: "select-rule"; readonly ruleId: string }
  | {
      readonly type: "select-clause";
      readonly ruleId: string;
      readonly clauseId: string;
    }
  | {
      readonly type: "add-rule";
      /** Added rows are creation data; the domain allocates every identity. */
      readonly rule: Omit<EditableRule, "id" | "rule"> & {
        readonly rule: Omit<Rule, "inputs"> & {
          readonly inputs: readonly RuleInputCreation[];
        };
      };
    }
  | { readonly type: "remove-rule"; readonly ruleId: string }
  | {
      readonly type: "add-clause";
      readonly ruleId: string;
      /** Creation input deliberately cannot nominate a canonical identity. */
      readonly input: RuleInputCreation;
    }
  | {
      readonly type: "remove-clause";
      readonly ruleId: string;
      readonly clauseId: string;
    }
  | {
      readonly type: "set-decision";
      readonly ruleId: string;
      readonly decision: RuleDecision;
    }
  | {
      readonly type: "toggle-context";
      readonly ruleId: string;
      readonly context: PathContext;
    }
  | { readonly type: "reset" }
  | { readonly type: "clear" };

/** Allocate identities exactly once at the untrusted creation boundary. */
export function initializeRuleEditorRows({
  rows,
}: {
  readonly rows: readonly EditableRuleCreation[];
}): readonly EditableRule[] {
  const ruleIds = new Set<string>();
  const clauseIds = new Set<string>();
  return rows.map((row) => {
    if (!row.id)
      throw new Error("rule editor rule is missing an invocation identity");
    if (ruleIds.has(row.id)) throw new Error(`duplicate rule '${row.id}'`);
    ruleIds.add(row.id);
    return {
      ...row,
      rule: {
        ...row.rule,
        inputs: row.rule.inputs.map((input) => {
          const id = "id" in input ? input.id : crypto.randomUUID();
          if (!id)
            throw new Error(
              "rule editor clause is missing an invocation identity",
            );
          if (clauseIds.has(id)) throw new Error(`duplicate clause '${id}'`);
          clauseIds.add(id);
          return { ...input, id };
        }),
      },
    };
  });
}

function assertCanonicalRows({
  rows,
  label,
}: {
  readonly rows: readonly EditableRule[];
  readonly label: string;
}): void {
  const ruleIds = new Set<string>();
  const clauseIds = new Set<string>();
  for (const row of rows) {
    if (!row.id)
      throw new Error("rule editor rule is missing an invocation identity");
    if (ruleIds.has(row.id))
      throw new Error(`duplicate rule '${row.id}' in ${label}`);
    ruleIds.add(row.id);
    for (const input of row.rule.inputs) {
      if (!input.id)
        throw new Error("rule editor clause is missing an invocation identity");
      if (clauseIds.has(input.id))
        throw new Error(`duplicate clause '${input.id}' in ${label}`);
      clauseIds.add(input.id);
    }
  }
}

/** Capture the opening invocation's identity authority as plain data. */
export function ruleEditorIdentityHistory({
  rows,
}: {
  readonly rows: readonly EditableRule[];
}): Pick<
  RuleEditorState,
  "issuedRuleIds" | "issuedClauseOwner" | "issuedRuleOrigin"
> {
  assertCanonicalRows({ rows, label: "opening rows" });
  return {
    issuedRuleIds: rows.map((row) => row.id),
    issuedClauseOwner: rows.flatMap((row) =>
      row.rule.inputs.map((input) => ({ clauseId: input.id, ruleId: row.id })),
    ),
    issuedRuleOrigin: rows.map((row) => ({
      ruleId: row.id,
      origin: row.origin,
    })),
  };
}

/** Validate canonical rows against the invocation-wide identity authority. */
export function initializeRuleEditorState({
  state,
}: {
  readonly state: RuleEditorState;
}): RuleEditorState {
  assertCanonicalRows({ rows: state.baseline, label: "baseline" });
  assertCanonicalRows({ rows: state.rows, label: "draft" });
  const issuedRules = new Set<string>();
  for (const ruleId of state.issuedRuleIds) {
    if (!ruleId)
      throw new Error("rule editor rule is missing an invocation identity");
    if (issuedRules.has(ruleId))
      throw new Error(`duplicate issued rule '${ruleId}'`);
    issuedRules.add(ruleId);
  }
  const issuedOrigins = new Map<string, RuleOrigin>();
  for (const issued of state.issuedRuleOrigin) {
    if (!issuedRules.has(issued.ruleId))
      throw new Error(`unknown rule origin '${issued.ruleId}'`);
    if (issuedOrigins.has(issued.ruleId))
      throw new Error(`duplicate issued rule origin '${issued.ruleId}'`);
    issuedOrigins.set(issued.ruleId, issued.origin);
  }
  if (issuedOrigins.size !== issuedRules.size)
    throw new Error("rule editor rule is missing an invocation origin");
  const issuedClauses = new Map<string, string>();
  for (const owner of state.issuedClauseOwner) {
    if (!owner.clauseId)
      throw new Error("rule editor clause is missing an invocation identity");
    if (!issuedRules.has(owner.ruleId))
      throw new Error(`unknown clause owner '${owner.ruleId}'`);
    if (issuedClauses.has(owner.clauseId))
      throw new Error(`duplicate issued clause '${owner.clauseId}'`);
    issuedClauses.set(owner.clauseId, owner.ruleId);
  }
  for (const [label, rows] of [
    ["baseline", state.baseline],
    ["draft", state.rows],
  ] as const) {
    for (const row of rows) {
      if (!issuedRules.has(row.id))
        throw new Error(`unknown rule '${row.id}' in ${label}`);
      if (issuedOrigins.get(row.id) !== row.origin)
        throw new Error(`reassigned origin for rule '${row.id}'`);
      for (const input of row.rule.inputs) {
        if (issuedClauses.get(input.id) !== row.id)
          throw new Error(`unknown, reused, or misplaced clause '${input.id}'`);
      }
    }
  }
  return state;
}
function selectedRow({
  state,
}: {
  readonly state: RuleEditorState;
}): EditableRule | undefined {
  return state.rows[state.selected];
}
function assertMutable({
  options,
  action,
}: {
  readonly options: RuleEditorOptions;
  readonly action: string;
}): void {
  if (!options.allowAddRemove)
    throw new Error(`${action} is not enabled for this editor`);
}
function assertToolAllowed({
  toolName,
  options,
}: {
  readonly toolName: string;
  readonly options: RuleEditorOptions;
}): void {
  if (
    options.lockedToolName !== undefined &&
    toolName !== options.lockedToolName
  )
    throw new Error(
      `tool '${toolName}' is locked to '${options.lockedToolName}'`,
    );
  if (options.builtin !== undefined && !isBuiltInRuleKind({ value: toolName }))
    throw new Error(`invalid built-in target '${toolName}'`);
  if (
    options.builtin !== undefined &&
    !options.builtin.allowedTools.some((allowed) => allowed === toolName)
  )
    throw new Error(`built-in target '${toolName}' is not enabled`);
}
function replaceRow({
  state,
  index,
  row,
}: {
  readonly state: RuleEditorState;
  readonly index: number;
  readonly row: EditableRule;
}): RuleEditorState {
  const rows = [...state.rows];
  rows[index] = row;
  return { ...state, rows };
}

/** Normalize selection only; authored rows and clauses are never silently dropped. */
export function normalizeRuleEditorState({
  state,
}: {
  readonly state: RuleEditorState;
}): RuleEditorState {
  if (state.rows.length === 0)
    return { ...state, selected: 0, clause: 0, field: "pattern" };
  const selected = Math.min(Math.max(state.selected, 0), state.rows.length - 1);
  const inputs = state.rows[selected]?.rule.inputs ?? [];
  return {
    ...state,
    selected,
    clause:
      inputs.length === 0
        ? 0
        : Math.min(Math.max(state.clause, 0), inputs.length - 1),
  };
}

/** Single deterministic semantic transition for every editor mutation. */
export function transitionRuleEditor({
  state,
  action,
  options,
}: {
  readonly state: RuleEditorState;
  readonly action: RuleEditorAction;
  readonly options: RuleEditorOptions;
}): RuleEditorState {
  state = initializeRuleEditorState({ state });
  switch (action.type) {
    case "focus":
      return { ...state, field: action.field };
    case "select-rule": {
      const selected = state.rows.findIndex((row) => row.id === action.ruleId);
      if (selected < 0) throw new Error(`unknown rule '${action.ruleId}'`);
      return normalizeRuleEditorState({ state: { ...state, selected } });
    }
    case "select-clause": {
      const selected = state.rows.findIndex((row) => row.id === action.ruleId);
      const row = state.rows[selected];
      const clause =
        row?.rule.inputs.findIndex((input) => input.id === action.clauseId) ??
        -1;
      if (selected < 0 || clause < 0)
        throw new Error(`unknown clause '${action.clauseId}'`);
      return { ...state, selected, clause, field: "pattern" };
    }
    case "set-field-value": {
      const row = selectedRow({ state });
      if (row === undefined) return state;
      if (state.field === "tool") {
        assertToolAllowed({ toolName: action.value, options });
        return replaceRow({
          state,
          index: state.selected,
          row: {
            ...row,
            rule: {
              ...row.rule,
              toolName: action.value,
              // Re-selecting a target is a no-op. In particular, do not lose
              // path contexts while cycling a one-target section.
              ...(row.rule.toolName === action.value
                ? {}
                : { contexts: undefined, pathMatch: undefined }),
            },
          },
        });
      }
      if (state.field === "guidance") {
        const rule: Rule = {
          ...row.rule,
          guidanceTouched: true,
          ...(action.value === ""
            ? { guidance: undefined }
            : { guidance: action.value }),
        };
        return replaceRow({
          state,
          index: state.selected,
          row: { ...row, rule },
        });
      }
      const input = row.rule.inputs[state.clause];
      if (input === undefined) return state;
      const inputs = [...row.rule.inputs];
      inputs[state.clause] =
        state.field === "path"
          ? { ...input, inputPath: action.value }
          : { ...input, matcher: { kind: "glob", pattern: action.value } };
      return replaceRow({
        state,
        index: state.selected,
        row: { ...row, rule: { ...row.rule, inputs } },
      });
    }
    case "cycle-built-in-target": {
      const index = state.rows.findIndex((row) => row.id === action.ruleId);
      const row = state.rows[index];
      if (row === undefined) throw new Error(`unknown rule '${action.ruleId}'`);
      const builtin = options.builtin;
      if (builtin === undefined)
        throw new Error(
          "built-in target cycling is not enabled for this editor",
        );
      if (row.origin === "request")
        throw new Error("request-derived built-in targets are locked");
      const current = builtin.allowedTools.find(
        (tool) => tool === row.rule.toolName,
      );
      if (current === undefined)
        throw new Error(`invalid built-in target '${row.rule.toolName}'`);
      const next =
        builtin.allowedTools[
          (builtin.allowedTools.indexOf(current) + 1) %
            builtin.allowedTools.length
        ];
      if (next === undefined)
        throw new Error("built-in editor has no allowed targets");
      const changed = transitionRuleEditor({
        // Built-in targets are displayed as section labels, not editable text
        // inputs. Return focus to the visible pattern after changing one.
        state: { ...state, selected: index, field: "tool" },
        action: { type: "set-field-value", value: next },
        options,
      });
      return { ...changed, field: "pattern" };
    }
    case "add-rule": {
      assertMutable({ options, action: action.type });
      assertToolAllowed({ toolName: action.rule.rule.toolName, options });
      const ruleId = crypto.randomUUID();
      const inputs = action.rule.rule.inputs.map((input) => ({
        ...input,
        id: crypto.randomUUID(),
      }));
      const row: EditableRule = {
        ...action.rule,
        id: ruleId,
        rule: { ...action.rule.rule, inputs },
      };
      return normalizeRuleEditorState({
        state: initializeRuleEditorState({
          state: {
            ...state,
            rows: [...state.rows, row],
            issuedRuleIds: [...state.issuedRuleIds, ruleId],
            issuedRuleOrigin: [
              ...state.issuedRuleOrigin,
              { ruleId, origin: row.origin },
            ],
            issuedClauseOwner: [
              ...state.issuedClauseOwner,
              ...inputs.map((input) => ({ clauseId: input.id, ruleId })),
            ],
            selected: state.rows.length,
            clause: 0,
          },
        }),
      });
    }
    case "remove-rule": {
      assertMutable({ options, action: action.type });
      const index = state.rows.findIndex((row) => row.id === action.ruleId);
      if (index < 0) throw new Error(`unknown rule '${action.ruleId}'`);
      return normalizeRuleEditorState({
        state: {
          ...state,
          rows: state.rows.filter((row) => row.id !== action.ruleId),
          selected: Math.min(state.selected, index),
        },
      });
    }
    case "add-clause": {
      assertMutable({ options, action: action.type });
      const index = state.rows.findIndex((row) => row.id === action.ruleId);
      const row = state.rows[index];
      if (row === undefined) throw new Error(`unknown rule '${action.ruleId}'`);
      // New clauses receive a fresh invocation identity. Ignore a hostile
      // runtime caller's `id`; a removed original may never be reintroduced
      // as a newly-created clause and borrow its provenance.
      const input: RuleInput = { ...action.input, id: crypto.randomUUID() };
      const inputs = [...row.rule.inputs, input];
      return replaceRow({
        state: {
          ...state,
          issuedClauseOwner: [
            ...state.issuedClauseOwner,
            { clauseId: input.id, ruleId: row.id },
          ],
          selected: index,
          clause: inputs.length - 1,
          // Built-in clauses have an implicit command/path property. Its
          // pattern is the first visible editable field.
          field: options.builtin === undefined ? "path" : "pattern",
        },
        index,
        row: { ...row, rule: { ...row.rule, inputs } },
      });
    }
    case "remove-clause": {
      assertMutable({ options, action: action.type });
      const index = state.rows.findIndex((row) => row.id === action.ruleId);
      const row = state.rows[index];
      if (row === undefined) throw new Error(`unknown rule '${action.ruleId}'`);
      const inputs = row.rule.inputs.filter(
        (input) => input.id !== action.clauseId,
      );
      if (inputs.length === row.rule.inputs.length)
        throw new Error(`unknown clause '${action.clauseId}'`);
      return normalizeRuleEditorState({
        state: replaceRow({
          state,
          index,
          row: { ...row, rule: { ...row.rule, inputs } },
        }),
      });
    }
    case "set-decision": {
      const index = state.rows.findIndex((row) => row.id === action.ruleId);
      const row = state.rows[index];
      if (row === undefined) throw new Error(`unknown rule '${action.ruleId}'`);
      return replaceRow({
        state,
        index,
        row: { ...row, rule: { ...row.rule, decision: action.decision } },
      });
    }
    case "toggle-context": {
      const index = state.rows.findIndex((row) => row.id === action.ruleId);
      const row = state.rows[index];
      if (row === undefined) throw new Error(`unknown rule '${action.ruleId}'`);
      const contexts = row.rule.contexts ?? [];
      const next = contexts.includes(action.context)
        ? contexts.filter((context) => context !== action.context)
        : [...contexts, action.context];
      return replaceRow({
        state,
        index,
        row: {
          ...row,
          rule: {
            ...row.rule,
            ...(next.length === 0
              ? { contexts: undefined }
              : { contexts: next }),
          },
        },
      });
    }
    case "reset":
      return normalizeRuleEditorState({
        state: {
          ...state,
          rows: structuredClone(state.baseline),
          selected: 0,
          clause: 0,
          field: "pattern",
        },
      });
    case "clear":
      if (!options.clearAvailable)
        throw new Error("clear is not enabled for this editor");
      return { ...state, rows: [], selected: 0, clause: 0, field: "pattern" };
    default: {
      const unexpected: never = action;
      throw new Error(`unexpected rule editor action ${String(unexpected)}`);
    }
  }
}

export type RuleEditorValidation = {
  readonly ruleId: string;
  readonly message: string;
};
export function validateRuleEditor({
  state,
  options,
}: {
  readonly state: RuleEditorState;
  readonly options: RuleEditorOptions;
}): RuleEditorValidation | undefined {
  state = initializeRuleEditorState({ state });
  for (const row of state.rows) {
    if (row.rule.decision === "skip") continue;
    if (
      options.lockedToolName !== undefined &&
      row.rule.toolName !== options.lockedToolName
    )
      return {
        ruleId: row.id,
        message: `tool '${row.rule.toolName}' is locked to '${options.lockedToolName}'`,
      };
    const builtin = options.builtin;
    const message =
      builtin === undefined
        ? validateCustomRule({ rule: row.rule })
        : validateBuiltInRule({ rule: row.rule, options: builtin });
    if (message !== undefined) return { ruleId: row.id, message };
  }
  return undefined;
}
export function nextRuleEditorFocus({
  state,
  options,
}: {
  readonly state: RuleEditorState;
  readonly options: RuleEditorOptions;
}): RuleEditorFocus {
  const hasClause = selectedRow({ state })?.rule.inputs.length !== 0;
  const clauseFields: readonly RuleEditorFocus[] = hasClause
    ? ["path", "pattern"]
    : [];
  const fields: readonly RuleEditorFocus[] =
    options.builtin !== undefined
      ? hasClause
        ? ["pattern", "guidance"]
        : ["guidance"]
      : options.lockedToolName === undefined
        ? ["tool", ...clauseFields, "guidance"]
        : [...clauseFields, "guidance"];
  const current = fields.indexOf(state.field);
  return fields[(current + 1) % fields.length] ?? fields[0] ?? "pattern";
}
export function canSaveRuleEditor({
  state,
  options,
}: {
  readonly state: RuleEditorState;
  readonly options: RuleEditorOptions;
}): boolean {
  return (
    validateRuleEditor({ state, options }) === undefined &&
    !(
      options.mode === "ask" &&
      state.rows.length > 0 &&
      state.rows.every((row) => row.rule.decision === "skip")
    )
  );
}

/** The decision sequence is policy semantics; transports only request its next value. */
export function nextRuleEditorDecision({
  state,
  ruleId,
  options,
}: {
  readonly state: RuleEditorState;
  readonly ruleId: string;
  readonly options: RuleEditorOptions;
}): RuleDecision {
  const row = state.rows.find((candidate) => candidate.id === ruleId);
  if (row === undefined) throw new Error(`unknown rule '${ruleId}'`);
  if (options.mode === "ask")
    return row.rule.decision === "allow"
      ? "deny"
      : row.rule.decision === "deny"
        ? "skip"
        : "allow";
  if (
    options.mode === "edit" &&
    (options.builtin === undefined || row.rule.toolName !== "protected")
  )
    return row.rule.decision === "allow"
      ? "deny"
      : row.rule.decision === "deny"
        ? "ask"
        : "allow";
  return row.rule.decision === "allow" ? "deny" : "allow";
}

type CustomToolInputCandidate = {
  readonly inputPath: string;
  readonly value: string;
  readonly initialPattern: string;
  readonly rawGlobWarning?: string;
};
export type CustomRuleGroups = Readonly<
  Record<string, readonly CustomToolRule[]>
>;

/** Warn that a prefilled request value is a raw glob, not an exact literal. */
export function rawGlobWarning({
  inputPath,
}: {
  readonly inputPath: string;
}): string {
  return `${inputPath} is prefilled as a raw glob; wildcard or backslash characters may match more than this exact value.`;
}

/** Warn that a request path has no clause, so any value there still matches. */
export function unconstrainedPathWarning({
  inputPath,
}: {
  readonly inputPath: string;
}): string {
  return `${inputPath} cannot be matched and is unconstrained by this rule.`;
}

export type CustomToolInputCandidates = {
  readonly candidates: readonly CustomToolInputCandidate[];
  /**
   * Request paths no clause can represent: keys that cannot round-trip
   * through dot-separated lookup, containers without own enumerable entries,
   * cycles, and values without a matchable representation. A rule prefilled from this
   * request leaves each of them unconstrained.
   */
  readonly unconstrainedPaths: readonly string[];
};

/** Display a property path, bracketing segments dot lookup cannot express. */
function displayInputPath({
  path,
}: {
  readonly path: readonly string[];
}): string {
  if (path.length === 0) return "(input)";
  return path
    .map((segment, index) =>
      segment.length === 0 || segment.includes(".")
        ? `[${JSON.stringify(segment)}]`
        : index === 0
          ? segment
          : `.${segment}`,
    )
    .join("");
}

/**
 * Extract every representable scalar leaf of a plain-data tool input (the
 * guard passes its structured clone of the call). Ancestor tracking permits
 * aliases but stops cycles; no whole-object or catch-all candidate is made.
 */
export function customToolInputCandidates({
  input,
}: {
  readonly input: unknown;
}): CustomToolInputCandidates {
  const candidates: CustomToolInputCandidate[] = [];
  const unconstrainedPaths: string[] = [];
  const visit = ({
    value,
    path,
    ancestors,
  }: {
    readonly value: unknown;
    readonly path: readonly string[];
    readonly ancestors: ReadonlySet<object>;
  }): void => {
    if (path.some((segment) => segment.length === 0 || segment.includes("."))) {
      unconstrainedPaths.push(displayInputPath({ path }));
      return;
    }
    if (
      typeof value === "string" ||
      value === null ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      if (path.length === 0) {
        unconstrainedPaths.push(displayInputPath({ path }));
        return;
      }
      const rendered =
        typeof value === "string" ? value : JSON.stringify(value);
      candidates.push({
        inputPath: path.join("."),
        value: rendered,
        initialPattern: rendered,
        ...(/[*?\\]/u.test(rendered)
          ? { rawGlobWarning: rawGlobWarning({ inputPath: path.join(".") }) }
          : {}),
      });
      return;
    }
    const container =
      typeof value === "object" && value !== null && !ancestors.has(value)
        ? value
        : undefined;
    const entries =
      container === undefined
        ? []
        : Array.isArray(container)
          ? Array.from(
              { length: container.length },
              (_, index): [string, unknown] => [
                String(index),
                container[index],
              ],
            )
          : Object.entries(container);
    // Scalars without a matchable form, containers without own enumerable
    // entries (including Date and Map), and cycles have no clause; the
    // request still constrains nothing there.
    if (container === undefined || entries.length === 0) {
      unconstrainedPaths.push(displayInputPath({ path }));
      return;
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(container);
    for (const [key, child] of entries)
      visit({ value: child, path: [...path, key], ancestors: nextAncestors });
  };
  visit({ value: input, path: [], ancestors: new Set<object>() });
  return { candidates, unconstrainedPaths };
}

export function decodeCustomRuleGroups({
  tools,
}: {
  readonly tools: CustomRuleGroups;
}): readonly EditableRule[] {
  return Object.entries(tools).flatMap(([toolName, declarations]) =>
    declarations.map((declaration, index): EditableRule => {
      const inputs: readonly RuleInput[] = Object.entries(
        declaration.match ?? {},
      ).map(([inputPath, pattern], inputIndex): RuleInput => ({
        id: `custom-${toolName}-${index}:clause:${inputIndex}`,
        inputPath,
        matcher: { kind: "glob", pattern },
      }));
      return {
        id: `custom-${toolName}-${index}`,
        origin: "existing",
        rule: {
          toolName,
          inputs,
          decision: declaration.decision,
          guidance: declaration.guidance,
        },
      };
    }),
  );
}
export function encodeCustomRuleGroups({
  rows,
  emptyToolNames = [],
}: {
  readonly rows: readonly EditableRule[];
  readonly emptyToolNames?: readonly string[];
}): Record<string, CustomToolRule[]> {
  const output: Record<string, CustomToolRule[]> = {};
  Object.setPrototypeOf(output, null);
  for (const name of emptyToolNames) output[name] = [];
  for (const editable of rows) {
    // SKIP is an editor-only ASK disposition, never a durable declaration.
    // Ignore it before validating fields that cannot be serialized.
    if (editable.rule.decision === "skip") continue;
    const error = validateCustomRule({ rule: editable.rule });
    if (error !== undefined) throw new Error(error);
    const match = Object.fromEntries(
      editable.rule.inputs.map((input) => [
        input.inputPath,
        input.matcher.pattern,
      ]),
    );
    const declaration = {
      decision: editable.rule.decision,
      ...(editable.rule.guidance === undefined
        ? {}
        : { guidance: editable.rule.guidance }),
      ...(editable.rule.inputs.length === 0 ? {} : { match }),
    } satisfies CustomToolRule;
    (output[editable.rule.toolName] ??= []).push(declaration);
  }
  return output;
}
export function isBuiltInRuleKind(args: {
  readonly value: string;
}): args is { readonly value: BuiltInRuleKind } {
  return builtInRuleKinds.some((kind) => kind === args.value);
}
export function validateCustomRule({
  rule,
}: {
  readonly rule: RuleCreation;
}): string | undefined {
  const nameError = customToolNameError({ name: rule.toolName });
  if (nameError !== undefined) return nameError;
  if (rule.contexts !== undefined)
    return "contexts are only valid for read or write rules";
  if (rule.pathMatch !== undefined)
    return "pathMatch is only valid for read rules";
  const paths = new Set<string>();
  for (const input of rule.inputs) {
    if (
      input.inputPath.length === 0 ||
      input.inputPath.split(".").some((part) => part.length === 0)
    )
      return "custom rule input paths must be nonempty dot-separated properties";
    if (paths.has(input.inputPath))
      return `duplicate custom rule input path '${input.inputPath}'`;
    paths.add(input.inputPath);
  }
  return undefined;
}
function validateBuiltInRule({
  rule,
  options,
}: {
  readonly rule: Rule;
  readonly options: NonNullable<RuleEditorOptions["builtin"]>;
}): string | undefined {
  const target = { value: rule.toolName };
  if (
    !isBuiltInRuleKind(target) ||
    !options.allowedTools.some((allowed) => allowed === target.value)
  )
    return `invalid built-in target '${rule.toolName}'`;
  if (
    rule.inputs.length === 0 ||
    rule.inputs.some(
      (input) =>
        (rule.pathMatch === undefined
          ? input.matcher.pattern.trim()
          : input.matcher.pattern
        ).length === 0,
    )
  )
    return "changed rules need a pattern";
  if (
    (rule.toolName === "bash" || rule.toolName === "protected") &&
    rule.contexts !== undefined
  )
    return `contexts are not valid for ${rule.toolName} rules`;
  if (rule.pathMatch !== undefined && rule.toolName !== "read")
    return `pathMatch is not valid for ${rule.toolName} rules`;
  if (rule.toolName === "protected" && rule.decision === "ask")
    return "ask is not valid for protected rules";
  const allowedContexts =
    rule.toolName === "read"
      ? readPathContexts
      : rule.toolName === "write"
        ? writePathContexts
        : undefined;
  if (
    rule.contexts !== undefined &&
    (allowedContexts === undefined ||
      !rule.contexts.every((context) =>
        allowedContexts.some((allowed) => allowed === context),
      ))
  )
    return `invalid contexts for ${rule.toolName} rules`;
  return undefined;
}
