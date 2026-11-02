import {
  Editor,
  type EditorTheme,
  Input,
  Key,
  matchesKey,
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
  type Decision,
  type PathContext,
  type ReadPathContext,
  type WritePathContext,
} from "./policyHelpers";
import type { OrdinaryPathRuleKind, RuleKind } from "./profileConfig";
import {
  builtInRuleKinds,
  inlineAskBuiltInRuleKinds,
  canSaveRuleEditor,
  initializeRuleEditorRows,
  initializeRuleEditorState,
  isBuiltInRuleKind,
  nextRuleEditorDecision,
  nextRuleEditorFocus,
  ruleEditorIdentityHistory,
  transitionRuleEditor,
  validateRuleEditor,
  type EditableRule,
  type EditableRuleCreation,
  type GlobMatcher,
  type ReadPathMatch,
  type RuleDecision,
  type RuleOrigin,
  type RuleEditorOptions,
  type RuleEditorState,
} from "./ruleEditorDomain";
import { terminalSafeText } from "./terminalText";
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
  profileAuthoringSelectedRowMarker,
  profileAuthoringUnselectedRowMarker,
  ruleSectionPresentation,
} from "./profileAuthoringPresentation";
/** Row labels own the selection indicator, so embedded Inputs need no prompt. */
const embeddedInputOptions = { prompt: "" } as const;
const emptyGlobMatcher = (): GlobMatcher => ({ kind: "glob", pattern: "" });

function newEmbeddedInput({ value }: { readonly value: string }): Input {
  const input = new Input(embeddedInputOptions);
  input.setValue(value);
  return input;
}

/** pi-tui keeps Input's cursor private; read it, or fail rather than guess. */
function inputCursor({ input }: { readonly input: Input }): number {
  const cursor: unknown = Reflect.get(input, "cursor");
  if (
    typeof cursor !== "number" ||
    !Number.isInteger(cursor) ||
    cursor < 0 ||
    cursor > input.getValue().length
  )
    throw new Error("pi-tui Input no longer exposes a usable cursor");
  return cursor;
}

/**
 * Draw an embedded Input with its value escaped for the terminal, since
 * values can come from model-controlled tool input. The raw cursor maps onto
 * the escaped prefix; a bracketed paste places the display Input's cursor
 * there before it draws the window.
 */
function renderTerminalSafeInput({
  input,
  width,
}: {
  readonly input: Input;
  readonly width: number;
}): string {
  const value = input.getValue();
  const display = new Input(embeddedInputOptions);
  display.handleInput(
    `\x1b[200~${terminalSafeText({ text: value.slice(0, inputCursor({ input })) })}\x1b[201~`,
  );
  display.setValue(terminalSafeText({ text: value }));
  display.focused = input.focused;
  return display.render(width)[0] ?? "";
}

/** Render only sanitized data through the SDK; never sanitize its styling. */
function renderTerminalSafeGuidance({
  editor,
  display,
  width,
}: {
  readonly editor: Editor;
  readonly display: Editor;
  readonly width: number;
}): string[] {
  const lines = editor.getText().split("\n");
  const cursor = editor.getCursor();
  const line = lines[cursor.line];
  if (line === undefined || cursor.col < 0 || cursor.col > line.length)
    throw new Error("pi-tui Editor exposed an invalid guidance cursor");
  const text = lines.map((text) => terminalSafeText({ text })).join("\n");
  // Preserve the SDK's preferred visual column across consecutive navigation.
  if (display.getText() !== text) display.setText(text);
  placeGuidanceCursor({
    editor: display,
    line: cursor.line,
    col: terminalSafeText({ text: line.slice(0, cursor.col) }).length,
  });
  display.focused = editor.focused;
  return display.render(width);
}

/** The SDK exposes a cursor reader but no setter; validate its state boundary. */
function placeGuidanceCursor({
  editor,
  line,
  col,
}: {
  readonly editor: Editor;
  readonly line: number;
  readonly col: number;
}): void {
  const text = editor.getLines()[line];
  if (
    text === undefined ||
    !Number.isInteger(col) ||
    col < 0 ||
    col > text.length
  )
    throw new Error("Invalid mapped guidance cursor");
  const state: unknown = Reflect.get(editor, "state");
  if (
    typeof state !== "object" ||
    state === null ||
    typeof Reflect.get(state, "cursorLine") !== "number" ||
    typeof Reflect.get(state, "cursorCol") !== "number"
  )
    throw new Error("pi-tui Editor no longer exposes a usable cursor state");
  Reflect.set(state, "cursorLine", line);
  Reflect.set(state, "cursorCol", col);
}

/** Snap a display cursor inside an escape to the nearest raw grapheme edge. */
function mapGuidanceCursorToRaw({
  editor,
  display,
}: {
  readonly editor: Editor;
  readonly display: Editor;
}): void {
  const cursor = display.getCursor();
  const line = editor.getLines()[cursor.line];
  if (line === undefined) throw new Error("Invalid display guidance line");
  let rawCol = 0;
  let displayCol = 0;
  let distance = Math.abs(cursor.col);
  for (const { segment, index } of new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(line)) {
    displayCol += terminalSafeText({ text: segment }).length;
    const nextDistance = Math.abs(cursor.col - displayCol);
    if (nextDistance < distance) {
      distance = nextDistance;
      rawCol = index + segment.length;
    }
  }
  placeGuidanceCursor({ editor, line: cursor.line, col: rawCol });
}

export type { EditableRule, EditableRuleCreation } from "./ruleEditorDomain";

export type EditRulesOptions = {
  readonly mode: RuleEditorOptions["mode"];
  readonly title: string;
  /** Unidentified clauses are accepted only while opening this invocation. */
  readonly rows: readonly EditableRuleCreation[];
  /** ASK locks the invoked tool; profile authoring intentionally does not. */
  readonly lockedToolName?: string;
  /** Raw request-glob warnings, kept separate from durable policy guidance. */
  readonly requestWarnings?: readonly string[];
  readonly clearAvailable?: boolean;
  /** Adapter options for built-in implicit command/path clauses. */
  readonly builtin?: {
    readonly allowedTools: readonly RuleKind[];
    readonly defaultTool: RuleKind;
    readonly defaultDecision?: "allow" | "deny";
    readonly requestDetails?: Readonly<Record<string, AskRuleCandidate>>;
  };
};
export type EditRulesResult = {
  readonly action: "back" | "save" | "clear";
  readonly rows: readonly EditableRule[];
};

/**
 * The one rule editor. Inline ASK, `/profile-add`, and `/profile-edit` use
 * this state machine, renderer, and input loop for built-in sections and
 * custom tools alike, rather than adapters inventing a second workflow.
 */
export async function editRules({
  ctx,
  options,
  custom,
}: {
  readonly ctx: { readonly ui: Pick<ExtensionContext["ui"], "custom"> };
  readonly options: EditRulesOptions;
  readonly custom?: ProfileAuthoringCustom;
}): Promise<EditRulesResult> {
  const domainOptions: RuleEditorOptions = {
    mode: options.mode,
    lockedToolName: options.lockedToolName,
    allowAddRemove: true,
    clearAvailable: options.clearAvailable,
    builtin: options.builtin,
  };
  const invocationRows = initializeRuleEditorRows({ rows: options.rows });
  let state: RuleEditorState = initializeRuleEditorState({
    state: {
      baseline: structuredClone(invocationRows),
      rows: structuredClone(invocationRows),
      ...ruleEditorIdentityHistory({ rows: invocationRows }),
      selected: 0,
      clause: 0,
      field: "pattern",
    },
  });
  const toolInputs: Input[] = [];
  const pathInputs: Input[][] = [];
  const patternInputs: Input[][] = [];
  const guidanceEditors: Editor[] = [];
  const guidanceDisplays: Editor[] = [];
  let focused = false;
  let rebuildInputAdapters: () => void = () => undefined;
  // Pi Inputs are cursor adapters only. Domain state is the sole draft state;
  // adapters are rebuilt for structural changes, never after each keystroke.
  const snapshot = (): readonly EditableRule[] => structuredClone(state.rows);
  const syncActiveFocus = (): void => {
    toolInputs.flat().forEach((input) => (input.focused = false));
    pathInputs.flat().forEach((input) => (input.focused = false));
    patternInputs.flat().forEach((input) => (input.focused = false));
    guidanceEditors.forEach((editor) => (editor.focused = false));
    if (!focused) return;
    const input = activeInput();
    const guidance = activeGuidanceEditor();
    if (input) input.focused = true;
    if (guidance) guidance.focused = true;
  };
  const dispatch = ({
    action,
    rebuild = false,
  }: {
    readonly action: Parameters<typeof transitionRuleEditor>[0]["action"];
    readonly rebuild?: boolean;
  }): void => {
    state = transitionRuleEditor({ state, action, options: domainOptions });
    if (rebuild) rebuildInputAdapters();
    syncActiveFocus();
  };
  const commitActiveInput = (): void => {
    const input = activeInput();
    if (input === undefined) return;
    dispatch({ action: { type: "set-field-value", value: input.getValue() } });
  };
  const activeInput = (): Input | undefined =>
    state.field === "tool"
      ? toolInputs[state.selected]
      : state.field === "path"
        ? pathInputs[state.selected]?.[state.clause]
        : state.field === "pattern"
          ? patternInputs[state.selected]?.[state.clause]
          : undefined;
  const activeGuidanceEditor = (): Editor | undefined =>
    state.field === "guidance" ? guidanceEditors[state.selected] : undefined;
  const result = await showProfileAuthoringCustom<EditRulesResult | null>({
    ctx,
    custom,
    factory: (tui, theme, keys, done) => {
      const editorTheme: EditorTheme = {
        borderColor: (text) => theme.fg("accent", text),
        selectList: {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      };
      let guidanceWidth = Math.max(1, tui.terminal.columns - 4);
      rebuildInputAdapters = (): void => {
        toolInputs.splice(0);
        pathInputs.splice(0);
        patternInputs.splice(0);
        guidanceEditors.splice(0);
        guidanceDisplays.splice(0);
        state.rows.forEach((editable) => {
          toolInputs.push(newEmbeddedInput({ value: editable.rule.toolName }));
          pathInputs.push(
            editable.rule.inputs.map((input) =>
              newEmbeddedInput({ value: input.inputPath }),
            ),
          );
          patternInputs.push(
            editable.rule.inputs.map((input) =>
              newEmbeddedInput({ value: input.matcher.pattern }),
            ),
          );
          const guidance = new Editor(tui, editorTheme);
          guidance.setText(editable.rule.guidance ?? "");
          guidance.onChange = () =>
            dispatch({
              action: {
                type: "set-field-value",
                value: guidance.getExpandedText(),
              },
            });
          guidanceEditors.push(guidance);
          guidanceDisplays.push(new Editor(tui, editorTheme));
        });
        syncActiveFocus();
      };
      rebuildInputAdapters();
      const finish = ({
        action,
      }: {
        readonly action: EditRulesResult["action"];
      }): void => done({ action, rows: snapshot() });
      const addRule = (): void => {
        const toolName =
          options.lockedToolName ?? options.builtin?.defaultTool ?? "";
        dispatch({
          action: {
            type: "add-rule",
            rule: {
              origin: (options.mode === "ask"
                ? "additional"
                : "create") satisfies RuleOrigin,
              rule: {
                toolName,
                inputs: options.builtin
                  ? [
                      {
                        inputPath: toolName === "bash" ? "command" : "path",
                        matcher: emptyGlobMatcher(),
                      },
                    ]
                  : [],
                decision:
                  options.builtin?.defaultDecision ??
                  (options.mode === "ask" ? "allow" : "deny"),
                ...(options.builtin &&
                (toolName === "read" || toolName === "write")
                  ? {
                      contexts: state.rows.find(
                        (row) => row.rule.toolName === toolName,
                      )?.rule.contexts,
                    }
                  : {}),
              },
            },
          },
          rebuild: true,
        });
        dispatch({
          action: {
            type: "focus",
            // A locked custom target is displayed, not editable. Its first
            // valid visible field is guidance until the author adds a
            // named clause. Built-ins always have an implicit clause.
            field: options.builtin
              ? "pattern"
              : options.lockedToolName === undefined
                ? "tool"
                : "guidance",
          },
        });
      };
      const addClause = (): void => {
        const row = state.rows[state.selected];
        if (row === undefined) return;
        dispatch({
          action: {
            type: "add-clause",
            ruleId: row.id,
            input: {
              inputPath: options.builtin
                ? row.rule.toolName === "bash"
                  ? "command"
                  : "path"
                : "",
              matcher: emptyGlobMatcher(),
            },
          },
          rebuild: true,
        });
      };
      const validation = () =>
        validateRuleEditor({ state, options: domainOptions });
      const decisionLabel = ({
        decision,
      }: {
        readonly decision: RuleDecision;
      }): string =>
        decision === "allow"
          ? "✅ ALLOW"
          : decision === "deny"
            ? "⛔️ DENY"
            : decision === "ask"
              ? "❓ ASK"
              : "SKIP";
      const presentation =
        options.builtin?.allowedTools.length === 1
          ? ruleSectionPresentation[options.builtin.allowedTools[0]]
          : undefined;
      return {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          syncActiveFocus();
        },
        render: (width) => {
          guidanceWidth = Math.max(1, width - 4);
          const invalid = validation();
          return [
            theme.fg(
              "accent",
              theme.bold(terminalSafeText({ text: options.title })),
            ),
            "",
            ...(presentation === undefined
              ? []
              : [
                  ...wrapTextWithAnsi(presentation.purpose, width),
                  "",
                  ...wrapTextWithAnsi(presentation.examples, width),
                  ...wrapTextWithAnsi(presentation.syntax, width),
                  "",
                ]),
            ...(options.builtin
              ? presentation === undefined
                ? [
                    "Built-in rules use command/path raw-glob clauses. Multiple clauses expand to ordinary declarations.",
                  ]
                : []
              : [
                  "Custom-tool rules use AND across named raw-glob clauses. A rule with no clauses is a catch-all.",
                ]),
            ...(options.requestWarnings ?? []).flatMap((warning) =>
              wrapTextWithAnsi(
                theme.fg("warning", `⚠ ${terminalSafeText({ text: warning })}`),
                width,
              ),
            ),
            ...(state.rows.length === 0
              ? [
                  theme.fg(
                    "warning",
                    options.builtin
                      ? "No rules in this section. Ctrl+N adds one."
                      : "No custom-tool rules. Ctrl+N adds one.",
                  ),
                ]
              : state.rows.flatMap((_, index) => {
                  const editable = state.rows[index];
                  const rule = editable.rule;
                  const mark =
                    index === state.selected
                      ? profileAuthoringSelectedRowMarker
                      : profileAuthoringUnselectedRowMarker;
                  const tool = toolInputs[index];
                  const details =
                    options.builtin?.requestDetails?.[editable.id];
                  const builtInTarget = { value: rule.toolName };
                  const target =
                    options.builtin && isBuiltInRuleKind(builtInTarget)
                      ? ruleSectionPresentation[builtInTarget.value].label
                      : options.builtin || options.lockedToolName
                        ? terminalSafeText({ text: rule.toolName })
                        : `Tool ${tool ? renderTerminalSafeInput({ input: tool, width: Math.max(1, width - 24) }) : ""}`;
                  const lines = [
                    `${mark}${target} · ${rule.decision.toUpperCase()}`,
                    ...(options.builtin
                      ? [
                          `    Local decision  ${decisionLabel({ decision: rule.decision })}`,
                          ...(options.mode === "ask" && rule.decision !== "skip"
                            ? [
                                `    ASK → ${decisionLabel({ decision: rule.decision })}`,
                              ]
                            : []),
                        ]
                      : []),
                    ...(options.mode === "ask" &&
                    editable.origin === "additional"
                      ? [
                          "    Additional profile rule (not required by this ASK)",
                        ]
                      : []),
                  ];
                  if (details) {
                    lines.push(
                      `    Requested value  ${terminalSafeText({ text: details.requestedValue })}`,
                    );
                    if (details.kind !== "bash")
                      lines.push(
                        `    Context/source   ${details.context} · ${terminalSafeText({ text: details.source.tool })}${details.source.role ? ` (${terminalSafeText({ text: details.source.role })})` : ""}`,
                      );
                    lines.push(
                      `    Matched rule     ${details.matchedRule === undefined ? "none (fallback ASK)" : terminalSafeText({ text: details.matchedRule })}`,
                    );
                    if (details.kind !== "bash") {
                      lines.push(
                        `    Writes to        profile ${ruleDestination({ kind: details.kind })}`,
                        `    ${ruleEffect({ kind: details.kind, decision: rule.decision === "deny" ? "deny" : "allow" })}`,
                      );
                    }
                    if (rule.decision === "skip")
                      lines.push(
                        "    Request draft retained; unchanged; remains ASK",
                      );
                    if (
                      rule.inputs.some((input) =>
                        isBroaderPattern({
                          pattern: input.matcher.pattern,
                          pathMatch: rule.pathMatch,
                          request: details,
                        }),
                      )
                    )
                      lines.push(
                        theme.fg(
                          "warning",
                          "    ⚠ Broader/custom pattern: this rule may affect paths beyond this request.",
                        ),
                      );
                  }
                  for (const [inputIndex, input] of rule.inputs.entries()) {
                    const active =
                      inputIndex === state.clause && index === state.selected;
                    const path = pathInputs[index]?.[inputIndex];
                    const pattern = patternInputs[index]?.[inputIndex];
                    const fieldWidth = Math.max(1, width - 14);
                    if (!options.builtin)
                      lines.push(
                        `    ${active ? "→" : " "} Path    ${path ? renderTerminalSafeInput({ input: path, width: fieldWidth }) : terminalSafeText({ text: input.inputPath })}`,
                      );
                    // Keep the active matcher in its own budgeted line, so
                    // narrow viewports retain both its cursor and meaning.
                    lines.push(
                      `    ${active ? "→" : " "} Pattern ${pattern ? renderTerminalSafeInput({ input: pattern, width: fieldWidth }) : terminalSafeText({ text: input.matcher.pattern })}`,
                    );
                  }
                  if (rule.inputs.length === 0)
                    lines.push(
                      options.builtin
                        ? "    No command/path clauses"
                        : "    Catch-all (no match clauses)",
                    );
                  if (rule.toolName === "read")
                    lines.push(
                      `    Path match       ${rule.pathMatch ?? "glob"}`,
                    );
                  if (
                    (rule.toolName === "read" &&
                      rule.pathMatch === undefined) ||
                    rule.toolName === "write"
                  )
                    lines.push(
                      "    PATH GLOB/PATTERN — interpreted as a glob, not a literal path (e.g. src/**/*.ts).",
                    );
                  if (rule.toolName === "read" || rule.toolName === "write")
                    lines.push(
                      `    Context          ${rule.contexts?.join(", ") ?? "all contexts"}`,
                    );
                  if (options.mode === "ask" && rule.inputs.length === 1)
                    lines.push(
                      `    Draft pattern    ${terminalSafeText({ text: rule.inputs[0]?.matcher.pattern ?? "" })}`,
                    );
                  const guidance = guidanceEditors[index];
                  lines.push("    Guidance:");
                  lines.push(
                    ...(guidance && guidanceDisplays[index]
                      ? renderTerminalSafeGuidance({
                          editor: guidance,
                          display: guidanceDisplays[index],
                          width: Math.max(1, width - 4),
                        })
                      : [theme.fg("dim", "none")]
                    ).map((line) => `    ${line}`),
                  );
                  return lines;
                })),
            "",
            ...(validation() === undefined &&
            options.mode === "ask" &&
            state.rows.length > 0 &&
            state.rows.every((row) => row.rule.decision === "skip")
              ? [theme.fg("warning", "Save disabled: every row is skipped"), ""]
              : []),
            ...(options.mode === "ask" &&
            state.rows.some(
              (row) =>
                row.rule.decision !== "skip" && row.rule.inputs.length === 0,
            )
              ? [
                  theme.fg(
                    "warning",
                    "⚠ Tool-wide catch-all: Save opens a separate confirmation before this rule is persisted.",
                  ),
                  "",
                ]
              : []),
            theme.fg(
              "dim",
              invalid
                ? `Save disabled: ${terminalSafeText({ text: invalid.message })}`
                : `Enter save · Ctrl+K field${options.builtin ? " · Ctrl+Shift+K target" : ""} · Tab decision · Ctrl+↑/↓ rule · Ctrl+←/→ clause · Ctrl+N add rule · Ctrl+A add clause · Ctrl+D remove rule · Ctrl+Shift+D remove clause · Ctrl+X context · Ctrl+Shift+R reset${options.clearAvailable ? " · Ctrl+Shift+X clear" : ""} · Ctrl+J newline in guidance (Shift/Ctrl+Enter need extended keys) · Esc back`,
            ),
          ].flatMap((line) => wrapTextWithAnsi(line, width));
        },
        invalidate: () => undefined,
        handleInput: (data) => {
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")))
            finish({ action: "back" });
          else if (matchesKey(data, Key.ctrlShift("r")))
            dispatch({ action: { type: "reset" }, rebuild: true });
          else if (
            matchesKey(data, Key.ctrlShift("x")) &&
            options.clearAvailable
          ) {
            dispatch({ action: { type: "clear" }, rebuild: true });
            finish({ action: "clear" });
          } else if (matchesKey(data, Key.ctrl("n"))) addRule();
          else if (matchesKey(data, Key.ctrl("a"))) addClause();
          else if (matchesKey(data, Key.ctrlShift("d"))) {
            const row = state.rows[state.selected];
            const input = row?.rule.inputs[state.clause];
            if (row !== undefined && input !== undefined) {
              dispatch({
                action: {
                  type: "remove-clause",
                  ruleId: row.id,
                  clauseId: input.id,
                },
                rebuild: true,
              });
              dispatch({
                action: {
                  type: "focus",
                  field: row.rule.inputs.length === 1 ? "guidance" : "pattern",
                },
              });
            }
          } else if (matchesKey(data, Key.ctrl("d"))) {
            const row = state.rows[state.selected];
            if (row !== undefined)
              dispatch({
                action: { type: "remove-rule", ruleId: row.id },
                rebuild: true,
              });
          } else if (matchesKey(data, Key.tab)) {
            const row = state.rows[state.selected];
            if (row !== undefined)
              dispatch({
                action: {
                  type: "set-decision",
                  ruleId: row.id,
                  decision: nextRuleEditorDecision({
                    state,
                    ruleId: row.id,
                    options: domainOptions,
                  }),
                },
              });
          } else if (matchesKey(data, Key.ctrl("x"))) {
            const row = state.rows[state.selected];
            if (
              row &&
              row.origin !== "request" &&
              (row.rule.toolName === "read" || row.rule.toolName === "write")
            ) {
              const contexts = contextsByKind[row.rule.toolName];
              const current =
                row.rule.contexts?.length === 1
                  ? contexts.indexOf(row.rule.contexts[0])
                  : -1;
              const next = contexts[current + 1];
              for (const context of row.rule.contexts ?? [])
                dispatch({
                  action: { type: "toggle-context", ruleId: row.id, context },
                });
              if (next !== undefined)
                dispatch({
                  action: {
                    type: "toggle-context",
                    ruleId: row.id,
                    context: next,
                  },
                });
            }
          } else if (
            matchesKey(data, Key.ctrl("left")) ||
            matchesKey(data, Key.ctrl("right"))
          ) {
            const row = state.rows[state.selected];
            if (row !== undefined && row.rule.inputs.length > 0) {
              const index = matchesKey(data, Key.ctrl("left"))
                ? Math.max(0, state.clause - 1)
                : Math.min(row.rule.inputs.length - 1, state.clause + 1);
              const input = row.rule.inputs[index];
              if (input !== undefined)
                dispatch({
                  action: {
                    type: "select-clause",
                    ruleId: row.id,
                    clauseId: input.id,
                  },
                });
            }
          } else if (
            matchesKey(data, Key.ctrl("up")) ||
            matchesKey(data, Key.ctrl("down"))
          ) {
            const index = matchesKey(data, Key.ctrl("up"))
              ? Math.max(0, state.selected - 1)
              : Math.min(state.rows.length - 1, state.selected + 1);
            const row = state.rows[index];
            if (row !== undefined)
              dispatch({ action: { type: "select-rule", ruleId: row.id } });
          } else if (
            state.field === "guidance" &&
            // Legacy terminals send Ctrl+J, and unextended Shift/Ctrl+Enter,
            // as a raw line feed that also matches Enter. Guidance takes it
            // as a newline before Enter can save.
            (data === "\n" ||
              keys.matches(data, "tui.input.newLine") ||
              matchesKey(data, Key.ctrl("enter")))
          ) {
            activeGuidanceEditor()?.insertTextAtCursor("\n");
          } else if (matchesKey(data, Key.enter)) {
            if (canSaveRuleEditor({ state, options: domainOptions }))
              finish({ action: "save" });
          } else if (matchesKey(data, Key.ctrlShift("k"))) {
            const row = state.rows[state.selected];
            // Destination-fixed profile sections expose one allowed target;
            // this remains a domain no-op and preserves path contexts.
            if (options.builtin && row && row.origin !== "request") {
              // Rebuild adapter state after the structural target change;
              // the domain returns focus to the visible pattern field.
              dispatch({
                action: { type: "cycle-built-in-target", ruleId: row.id },
                rebuild: true,
              });
            }
          } else if (matchesKey(data, Key.ctrl("k"))) {
            dispatch({
              action: {
                type: "focus",
                field: nextRuleEditorFocus({ state, options: domainOptions }),
              },
            });
          } else {
            const guidance = activeGuidanceEditor();
            if (guidance) {
              const display = guidanceDisplays[state.selected];
              const visualNavigation = [
                "tui.editor.cursorUp",
                "tui.editor.cursorDown",
                "tui.editor.pageUp",
                "tui.editor.pageDown",
              ] as const;
              if (
                visualNavigation.some((action) => keys.matches(data, action))
              ) {
                if (!display)
                  throw new Error("Missing guidance display editor");
                // Synchronize before navigation even if edits arrived before
                // the next scheduled render. Layout includes escape expansion.
                renderTerminalSafeGuidance({
                  editor: guidance,
                  display,
                  width: guidanceWidth,
                });
                display.handleInput(data);
                mapGuidanceCursorToRaw({ editor: guidance, display });
              } else {
                guidance.handleInput(data);
                // Horizontal motion or editing starts a new preferred-column
                // sequence; the next render rebuilds only this display copy.
                display?.setText("");
              }
            } else {
              activeInput()?.handleInput(data);
              commitActiveInput();
            }
          }
          tui.requestRender();
        },
      };
    },
  });
  // Back abandons this modal invocation and restores its opening draft. The
  // permission guard, rather than an unsubmitted ASK editor, retains skipped
  // request drafts after a successful partial save.
  if (isProfileAuthoringAbort(result) || result?.action === "back")
    return { action: "back", rows: structuredClone(state.baseline) };
  if (result === null || result === undefined)
    return { action: "back", rows: structuredClone(state.baseline) };
  return result;
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
      pathMatch?: ReadPathMatch;
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
  /** `skip` is transient; all durable decisions are schema-derived. */
  decision: RuleDecision;
  guidance?: string;
  /** True only when the editor intentionally changed or cleared guidance. */
  guidanceTouched?: boolean;
  contexts?: readonly PathContext[];
  pathMatch?: ReadPathMatch;
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

export type EditRuleRowsOptions = {
  mode: RuleEditorOptions["mode"];
  rows: readonly EditableRuleRow[];
  /** CREATE sections use a fixed kind. ASK editors may contain mixed kinds. */
  kind?: RuleKind;
  title: string;
  allowAddRemove?: boolean;
  defaultKind?: RuleKind;
  defaultDecision?: "allow" | "deny";
};

export type EditRuleRowsResult = {
  action: EditRulesResult["action"];
  rows: EditableRuleRow[];
};

export function ruleDestination({ kind }: { readonly kind: RuleKind }): string {
  return kind === "bash"
    ? "tools.bash"
    : kind === "read"
      ? "readPaths"
      : kind === "write"
        ? "writePaths"
        : "protectedPathRules";
}

export function ruleEffect({
  kind,
  decision,
}: {
  readonly kind: RuleKind;
  readonly decision: Exclude<Decision, "ask">;
}): string {
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

export function isBroaderPattern({
  pattern,
  pathMatch,
  request,
}: {
  readonly pattern: string;
  readonly pathMatch: ReadPathMatch | undefined;
  readonly request: AskRuleCandidate | undefined;
}): boolean {
  return Boolean(
    request &&
    (pathMatch === undefined
      ? pattern.trim() !== request.initialPattern.trim()
      : pattern !== request.initialPattern),
  );
}

const contextsByKind: Record<OrdinaryPathRuleKind, readonly PathContext[]> = {
  read: readPathContexts,
  write: writePathContexts,
};

function sameContexts({
  first,
  second,
}: {
  readonly first: readonly PathContext[] | undefined;
  readonly second: readonly PathContext[] | undefined;
}): boolean {
  return (
    first === second ||
    (first !== undefined &&
      second !== undefined &&
      first.length === second.length &&
      first.every((context, index) => context === second[index]))
  );
}

/** Convert exact local declarations into rows without resolving inheritance. */
export function profileRuleEditRows<K extends SectionKind>({
  kind,
  rules,
}: {
  readonly kind: K;
  readonly rules: readonly DeclarationFor<K>[];
}): readonly ProfileRuleEditRow<K>[] {
  return rules.map((raw, index) => ({ id: `${kind}-${index}`, kind, raw }));
}

type AnyProfileRuleEditRow =
  | ProfileRuleEditRow<"bash">
  | ProfileRuleEditRow<"read">
  | ProfileRuleEditRow<"write">
  | ProfileRuleEditRow<"protected">;

function editableExistingRow({
  row,
}: {
  readonly row: AnyProfileRuleEditRow;
}): EditableRuleRow {
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
    pathMatch: row.kind === "read" ? row.raw.pathMatch : undefined,
    origin: "existing",
  };
}

function durableDecision({ row }: { readonly row: EditableRuleRow }): Decision {
  if (row.decision === "skip")
    throw new Error("skip is not valid in an edit section");
  return row.decision;
}
function protectedDecision({
  row,
}: {
  readonly row: EditableRuleRow;
}): Exclude<Decision, "ask"> {
  const decision = durableDecision({ row });
  if (decision === "ask")
    throw new Error("ask is not valid for protected rules");
  return decision;
}
function bashRows({
  initial,
  rows,
}: {
  readonly initial: readonly ProfileRuleEditRow<"bash">[];
  readonly rows: readonly EditableRuleRow[];
}): BashDeclaration[] {
  const original = new Map(initial.map((row) => [row.id, row.raw]));
  return rows.map((row) => {
    const raw = original.get(row.id);
    const decision = durableDecision({ row });
    // The form supplies semantic fields, but only a touched optional field is
    // authority to replace its raw declaration. This preserves both omitted
    // and deliberately empty guidance when another row/section is edited.
    const guidance =
      row.guidanceTouched || raw === undefined ? row.guidance : raw.guidance;
    if (
      raw &&
      raw.pattern === row.pattern &&
      raw.decision === decision &&
      raw.guidance === guidance
    )
      return raw;
    const declaration = { ...raw, pattern: row.pattern, decision };
    if (row.guidanceTouched || raw === undefined) {
      if (row.guidance === undefined) delete declaration.guidance;
      else declaration.guidance = row.guidance;
    }
    return declaration;
  });
}
type PathContextArgument = { readonly context: PathContext };
type ReadPathContextArgument = { readonly context: ReadPathContext };
type WritePathContextArgument = { readonly context: WritePathContext };

function isReadContext(
  argument: PathContextArgument,
): argument is ReadPathContextArgument {
  return (
    argument.context === "read" ||
    argument.context === "grep" ||
    argument.context === "find" ||
    argument.context === "ls"
  );
}
function isWriteContext(
  argument: PathContextArgument,
): argument is WritePathContextArgument {
  return (
    argument.context === "edit" ||
    argument.context === "write" ||
    argument.context === "bash"
  );
}
function readContexts({
  contexts,
}: {
  readonly contexts: readonly PathContext[] | undefined;
}): ReadPathContext[] | undefined {
  if (contexts === undefined) return undefined;
  const argumentsForContexts = contexts.map((context) => ({ context }));
  if (!argumentsForContexts.every(isReadContext))
    throw new Error("read rule contexts must be read contexts");
  return argumentsForContexts.map((argument) => argument.context);
}
function writeContexts({
  contexts,
}: {
  readonly contexts: readonly PathContext[] | undefined;
}): WritePathContext[] | undefined {
  if (contexts === undefined) return undefined;
  const argumentsForContexts = contexts.map((context) => ({ context }));
  if (!argumentsForContexts.every(isWriteContext))
    throw new Error("write rule contexts must be write contexts");
  return argumentsForContexts.map((argument) => argument.context);
}
function readRows({
  initial,
  rows,
}: {
  readonly initial: readonly ProfileRuleEditRow<"read">[];
  readonly rows: readonly EditableRuleRow[];
}): ReadDeclaration[] {
  const original = new Map(initial.map((row) => [row.id, row.raw]));
  return rows.map((row) => {
    const raw = original.get(row.id);
    const decision = durableDecision({ row });
    if (
      raw &&
      raw.pattern === row.pattern &&
      raw.decision === decision &&
      raw.pathMatch === row.pathMatch &&
      raw.guidance === (row.guidanceTouched ? row.guidance : raw.guidance) &&
      sameContexts({ first: raw.contexts, second: row.contexts })
    )
      return raw;
    const rest = { ...raw };
    delete rest.contexts;
    delete rest.pathMatch;
    if (row.guidanceTouched || raw === undefined) {
      if (row.guidance === undefined) delete rest.guidance;
      else rest.guidance = row.guidance;
    }
    const contexts = readContexts({ contexts: row.contexts });
    return {
      ...rest,
      pattern: row.pattern,
      ...(row.pathMatch === undefined ? {} : { pathMatch: row.pathMatch }),
      decision,
      ...(contexts === undefined ? {} : { contexts }),
    };
  });
}
function writeRows({
  initial,
  rows,
}: {
  readonly initial: readonly ProfileRuleEditRow<"write">[];
  readonly rows: readonly EditableRuleRow[];
}): WriteDeclaration[] {
  const original = new Map(initial.map((row) => [row.id, row.raw]));
  return rows.map((row) => {
    const raw = original.get(row.id);
    const decision = durableDecision({ row });
    if (
      raw &&
      raw.pattern === row.pattern &&
      raw.decision === decision &&
      raw.guidance === (row.guidanceTouched ? row.guidance : raw.guidance) &&
      sameContexts({ first: raw.contexts, second: row.contexts })
    )
      return raw;
    const rest = { ...raw };
    delete rest.contexts;
    if (row.guidanceTouched || raw === undefined) {
      if (row.guidance === undefined) delete rest.guidance;
      else rest.guidance = row.guidance;
    }
    const contexts = writeContexts({ contexts: row.contexts });
    return {
      ...rest,
      pattern: row.pattern,
      decision,
      ...(contexts === undefined ? {} : { contexts }),
    };
  });
}
function protectedRows({
  initial,
  rows,
}: {
  readonly initial: readonly ProfileRuleEditRow<"protected">[];
  readonly rows: readonly EditableRuleRow[];
}): ProtectedDeclaration[] {
  const original = new Map(initial.map((row) => [row.id, row.raw]));
  return rows.map((row) => {
    const raw = original.get(row.id);
    const decision = protectedDecision({ row });
    if (
      raw &&
      raw.pattern === row.pattern &&
      raw.decision === decision &&
      raw.guidance === (row.guidanceTouched ? row.guidance : raw.guidance)
    )
      return raw;
    const declaration = { ...raw, pattern: row.pattern, decision };
    if (row.guidanceTouched || raw === undefined) {
      if (row.guidance === undefined) delete declaration.guidance;
      else declaration.guidance = row.guidance;
    }
    return declaration;
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
  // SKIP is a transient ASK-editor choice. Exclude it before every durable
  // validation so incomplete skipped drafts cannot block serialization.
  const durableRows = rows.filter((row) => row.decision !== "skip");
  if (initial.some((row) => row.kind !== kind))
    throw new Error(`initial row kind does not match ${kind} section`);
  if (durableRows.some((row) => row.kind !== kind))
    throw new Error(`row kind does not match ${kind} section`);
  if (
    (kind === "bash" || kind === "protected") &&
    durableRows.some((row) => row.contexts !== undefined)
  )
    throw new Error(`contexts are not valid for ${kind} rules`);
  if (
    kind === "read" &&
    durableRows.some(
      (row) =>
        row.contexts !== undefined &&
        row.contexts.some((context) => !isReadContext({ context })),
    )
  )
    throw new Error("read rule contexts must be read contexts");
  if (
    kind === "write" &&
    durableRows.some(
      (row) =>
        row.contexts !== undefined &&
        row.contexts.some((context) => !isWriteContext({ context })),
    )
  )
    throw new Error("write rule contexts must be write contexts");
  if (durableRows.length === 0)
    return initial.length === 0 && preserveExplicitEmpty
      ? { mode: "set", value: [] }
      : { mode: "omit" };
  if (kind === "bash")
    return { mode: "set", value: bashRows({ initial, rows: durableRows }) };
  if (kind === "read")
    return { mode: "set", value: readRows({ initial, rows: durableRows }) };
  if (kind === "write")
    return { mode: "set", value: writeRows({ initial, rows: durableRows }) };
  return { mode: "set", value: protectedRows({ initial, rows: durableRows }) };
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
  action: EditRuleRowsResult["action"];
  edit: ProfileRuleSectionEdits["bash"];
}>;
export function editProfileRuleSection({
  ctx,
  kind,
  initial,
  title,
  preserveExplicitEmpty,
}: Extract<RuleSectionEditorOptions, { readonly kind: "read" }>): Promise<{
  action: EditRuleRowsResult["action"];
  edit: ProfileRuleSectionEdits["readPaths"];
}>;
export function editProfileRuleSection({
  ctx,
  kind,
  initial,
  title,
  preserveExplicitEmpty,
}: Extract<RuleSectionEditorOptions, { readonly kind: "write" }>): Promise<{
  action: EditRuleRowsResult["action"];
  edit: ProfileRuleSectionEdits["writePaths"];
}>;
export function editProfileRuleSection({
  ctx,
  kind,
  initial,
  title,
  preserveExplicitEmpty,
}: Extract<RuleSectionEditorOptions, { readonly kind: "protected" }>): Promise<{
  action: EditRuleRowsResult["action"];
  edit: ProfileRuleSectionEdits["protectedPathRules"];
}>;
export function editProfileRuleSection(
  options: RuleSectionEditorOptions,
): Promise<{
  action: EditRuleRowsResult["action"];
  edit: RuleSectionEdit<readonly unknown[]>;
}>;
export async function editProfileRuleSection(
  options: RuleSectionEditorOptions,
): Promise<{
  action: EditRuleRowsResult["action"];
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
      rows: initial.map((row) => editableExistingRow({ row })),
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

/**
 * Built-in policy adapter for the canonical editor. Bash and path declarations
 * are represented as their implicit logical input (command or path); the
 * editor can therefore use the same rule, clause, focus, render, and input
 * state machine as custom tools. A multi-clause built-in rule expands back to
 * ordinary declarations at this boundary.
 */
export async function editProfileRuleRows({
  ctx,
  options,
  custom,
}: {
  readonly ctx: { readonly ui: Pick<ExtensionContext["ui"], "custom"> };
  readonly options: EditRuleRowsOptions;
  readonly custom?: ProfileAuthoringCustom;
}): Promise<EditRuleRowsResult> {
  if (
    options.mode === "ask" &&
    (options.defaultKind === "protected" ||
      options.rows.some((row) => row.kind === "protected"))
  )
    throw new Error(
      "inline ASK only supports non-empty bash, read, and write rules",
    );
  const inputPath = ({
    kind,
  }: {
    readonly kind: RuleKind;
  }): "command" | "path" => (kind === "bash" ? "command" : "path");
  const editableRows: EditableRule[] = options.rows.map((row) => ({
    id: row.id,
    origin: row.origin,
    rule: {
      toolName: row.kind,
      inputs: [
        {
          id: `${row.id}:clause`,
          inputPath: inputPath({ kind: row.kind }),
          matcher: { kind: "glob", pattern: row.pattern },
        },
      ],
      contexts: row.contexts,
      pathMatch: row.pathMatch,
      decision: row.decision,
      guidance: row.guidance,
    },
  }));
  const clauseProvenance = new Map(
    options.rows.map((row) => [
      `${row.id}:clause`,
      { id: row.id, request: row.request },
    ]),
  );
  const requestDetails: Record<string, AskRuleCandidate> = Object.fromEntries(
    options.rows.flatMap((row) =>
      row.request === undefined ? [] : [[row.id, row.request]],
    ),
  );
  const result = await editRules({
    ctx,
    custom,
    options: {
      mode: options.mode,
      title: options.title,
      rows: editableRows,
      clearAvailable: options.mode !== "ask",
      builtin: {
        allowedTools: options.kind
          ? [options.kind]
          : options.mode === "ask"
            ? inlineAskBuiltInRuleKinds
            : builtInRuleKinds,
        defaultTool: options.kind ?? options.defaultKind ?? "bash",
        defaultDecision: options.defaultDecision,
        requestDetails,
      },
    },
  });
  const rows = result.rows.flatMap((editable) => {
    // Preserve transient SKIP rows for the permission guard. Durable section
    // serializers filter them before validation and persistence.
    const target = { value: editable.rule.toolName };
    if (!isBuiltInRuleKind(target))
      throw new Error(
        `editor returned non-built-in target '${editable.rule.toolName}'`,
      );
    return editable.rule.inputs.map((input) => {
      const provenance = clauseProvenance.get(input.id);
      return {
        id: provenance?.id ?? `${editable.id}-clause-${input.id}`,
        kind: target.value,
        // Literal path matches use the exact text; globs ignore edge spaces.
        pattern:
          editable.rule.pathMatch === undefined
            ? input.matcher.pattern.trim()
            : input.matcher.pattern,
        decision: editable.rule.decision,
        // Optional raw fields belong to their original declaration, not the
        // first clause currently displayed. New clauses receive guidance only
        // after an intentional edit in this invocation.
        ...(editable.rule.guidance === undefined ||
        (!editable.rule.guidanceTouched && provenance === undefined)
          ? {}
          : { guidance: editable.rule.guidance }),
        ...(editable.rule.guidanceTouched === undefined
          ? {}
          : { guidanceTouched: editable.rule.guidanceTouched }),
        contexts: editable.rule.contexts,
        pathMatch: editable.rule.pathMatch,
        request: provenance?.request ?? requestDetails[provenance?.id ?? ""],
        origin: editable.origin,
      } satisfies EditableRuleRow;
    });
  });
  return { action: result.action, rows };
}
