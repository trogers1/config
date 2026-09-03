import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  readPathContexts,
  writePathContexts,
  type PathContext,
} from "./policyHelpers";
import type {
  OrdinaryPathRuleKind,
  ProfileMutationTarget,
  RuleKind,
} from "./profileConfig";

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
  decision: "allow" | "deny" | "skip";
  guidance?: string;
  contexts?: readonly PathContext[];
  request?: AskRuleCandidate;
  origin: "request" | "additional" | "create";
};

export type RuleEditorOptions = {
  mode: "ask" | "create";
  rows: readonly EditableRuleRow[];
  /** CREATE sections use a fixed kind. ASK editors may contain mixed kinds. */
  kind?: RuleKind;
  title: string;
  target?: ProfileMutationTarget;
  allowAddRemove?: boolean;
  defaultKind?: RuleKind;
  defaultDecision?: "allow" | "deny";
};

export type RuleEditorResult = {
  action: "back" | "save" | "clear";
  rows: EditableRuleRow[];
  /** Editable only for an ASK that will create a child profile. */
  targetProfile?: string;
};

export const ruleLayerLabel: Record<RuleKind, string> = {
  bash: "⚙️ BASH COMMAND",
  read: "📖 READ PATH",
  write: "✏️ WRITE PATH",
  protected: "🛡️ PROTECTED SAFEGUARD",
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

/** Production-owned multi-row editor shared by ASK and CREATE. */
export async function editProfileRuleRows(
  ctx: ExtensionContext,
  options: RuleEditorOptions,
): Promise<RuleEditorResult> {
  const initialRows = options.rows.map(copyRow);
  const rows: EditableRuleRow[] = options.rows.map(copyRow);
  const inputs: Input[] = [];
  const guidanceInputs: Input[] = [];
  const attachInputs = (row: EditableRuleRow) => {
    const input = new Input();
    input.setValue(row.pattern);
    const guidance = new Input();
    guidance.setValue(row.guidance ?? "");
    inputs.push(input);
    guidanceInputs.push(guidance);
  };
  rows.forEach(attachInputs);

  const snapshot = (): EditableRuleRow[] =>
    rows.map((row, index) => ({
      ...row,
      pattern: inputs[index]?.getValue().trim() ?? row.pattern,
      guidance: guidanceInputs[index]?.getValue().trim() || undefined,
    }));
  const targetInput =
    options.mode === "ask" && options.target?.mode === "create-child"
      ? new Input()
      : undefined;
  targetInput?.setValue(options.target?.profile ?? "");

  const result = await ctx.ui.custom<RuleEditorResult | null>(
    (tui, theme, _keys, done) => {
      let selected = targetInput ? -1 : 0;
      let guidanceFocused = false;
      const finish = (action: RuleEditorResult["action"]) =>
        done({
          action,
          rows: snapshot(),
          targetProfile: targetInput?.getValue().trim(),
        });
      const submit = () => {
        const current = snapshot();
        if (targetInput && !targetInput.getValue().trim()) return;
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
      if (targetInput) wire(targetInput);
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
        selected = targetInput ? -1 : 0;
        guidanceFocused = false;
      };

      return {
        get focused() {
          if (selected === -1) return targetInput?.focused ?? false;
          return (
            (guidanceFocused ? guidanceInputs[selected] : inputs[selected])
              ?.focused ?? false
          );
        },
        set focused(value: boolean) {
          if (targetInput) targetInput.focused = value && selected === -1;
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
          const invalid =
            changed.some((row) => !row.pattern) ||
            Boolean(targetInput && !targetInput.getValue().trim());
          const targetLines = options.target
            ? options.target.mode === "update"
              ? [`Target  ${options.target.profile} (existing custom profile)`]
              : [
                  `Target  ${selected === -1 ? "> " : "  "}${targetInput?.render(Math.max(1, width - 12))[0] ?? options.target.profile} (new custom profile)`,
                  `Extends ${options.target.extends[0]}`,
                ]
            : [];
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
            ...targetLines.map((line) => theme.fg("dim", line)),
            ...(options.kind === "protected" ||
            current.some((row) => row.kind === "protected")
              ? [
                  theme.fg(
                    "warning",
                    "Protected denies block both reads and writes. Protected allows only create exceptions to broader protected denies; they grant no read or write permission.",
                  ),
                ]
              : []),
            ...(current.length === 0
              ? [theme.fg("dim", "No rules in this section. Ctrl+N adds one.")]
              : []),
            ...current.flatMap((row, index) => {
              const decision = row.decision;
              const mark =
                decision === "allow" ? "✅" : decision === "deny" ? "⛔️" : "⏭️";
              const request = row.request;
              const destination = `profiles.${targetInput?.getValue().trim() || options.target?.profile || "<new-profile>"}.${ruleDestination(row.kind)}`;
              const lines = [
                `${index === selected ? ">" : " "} ${ruleLayerLabel[row.kind]} ${mark} ${inputs[index]?.render(Math.max(1, width - 26))[0] ?? ""}`,
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
              if (!request && (row.kind === "read" || row.kind === "write"))
                lines.push(
                  `    Context          ${row.contexts?.join(", ") ?? "all contexts"}`,
                );
              lines.push(
                `    Writes to        ${destination}`,
                `    Effective change ${decision === "skip" ? "unchanged; remains ASK" : `ASK → ${decision === "allow" ? "✅ ALLOW" : "⛔️ DENY"}`}`,
              );
              if (decision !== "skip")
                lines.push(
                  `    Effect           ${ruleEffect(row.kind, decision)}`,
                );
              if (request && isBroaderPattern(row))
                lines.push(
                  "    ⚠ Broader/custom pattern: this rule may affect paths beyond this request.",
                );
              if (decision === "deny" && row.kind !== "protected")
                lines.push(
                  `${index === selected && guidanceFocused ? ">" : " "}   Guidance         ${guidanceInputs[index]?.getValue() ? guidanceInputs[index]?.render(Math.max(1, width - 24))[0] : theme.fg("dim", "Add persistent steering…")}`,
                );
              return lines;
            }),
            theme.fg(
              "dim",
              options.mode === "ask" && changed.length === 0
                ? "Save disabled: every row is skipped. Tab a row to allow or deny."
                : invalid
                  ? "Save disabled: changed rules need a pattern."
                  : options.mode === "ask"
                    ? `Enter save ${changed.length} rule${changed.length === 1 ? "" : "s"} and re-check request · Tab allow/deny/skip · Ctrl+N add · Ctrl+K kind · Ctrl+X context · Esc Back`
                    : "Enter save section · Tab allow/deny · Ctrl+N add · Ctrl+D remove · Ctrl+X context · Ctrl+Shift+R clear · Esc Back",
            ),
          ].map((line) => truncateToWidth(line, width));
        },
        invalidate: () => {
          targetInput?.invalidate();
          inputs.forEach((input) => input.invalidate());
          guidanceInputs.forEach((input) => input.invalidate());
        },
        handleInput: (data) => {
          if (matchesKey(data, Key.ctrlShift("r"))) {
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
            else selected = Math.max(targetInput ? -1 : 0, selected - 1);
          } else if (matchesKey(data, Key.down)) {
            if (selected === -1) selected = 0;
            else if (
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
            if (selected === -1) selected = 0;
            const row = rows[selected];
            if (row) {
              row.decision =
                options.mode === "ask"
                  ? row.decision === "allow"
                    ? "deny"
                    : row.decision === "deny"
                      ? "skip"
                      : "allow"
                  : row.decision === "allow"
                    ? "deny"
                    : "allow";
              if (row.decision !== "deny") guidanceFocused = false;
            }
          } else if (selected === -1) {
            targetInput?.handleInput(data);
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
  );

  return (
    result ?? {
      action: "back",
      rows: snapshot(),
      targetProfile: targetInput?.getValue().trim(),
    }
  );
}
