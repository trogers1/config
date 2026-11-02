import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  customToolNameSchema,
  customToolRuleSchema,
  type CustomToolRule,
} from "./policyHelpers";
import {
  canSaveRuleEditor,
  customToolInputCandidates,
  initializeRuleEditorRows,
  initializeRuleEditorState,
  decodeCustomRuleGroups,
  encodeCustomRuleGroups,
  normalizeRuleEditorState,
  ruleEditorIdentityHistory,
  nextRuleEditorDecision,
  nextRuleEditorFocus,
  rawGlobWarning,
  transitionRuleEditor,
  validateRuleEditor,
  validateCustomRule,
  type EditableRule,
  type RuleEditorState,
} from "./ruleEditorDomain";

const state = {
  baseline: [],
  rows: [
    {
      id: "one",
      origin: "existing",
      rule: {
        toolName: "deploy",
        inputs: [
          {
            id: "target",
            inputPath: "target",
            matcher: { kind: "glob", pattern: "release" },
          },
          {
            id: "region",
            inputPath: "region",
            matcher: { kind: "glob", pattern: "*" },
          },
        ],
        decision: "allow",
        guidance: "first\n\nsecond",
      },
    },
  ],
  issuedRuleIds: ["one"],
  issuedClauseOwner: [
    { clauseId: "target", ruleId: "one" },
    { clauseId: "region", ruleId: "one" },
  ],
  issuedRuleOrigin: [{ ruleId: "one", origin: "existing" }],
  selected: 0,
  clause: 1,
  field: "pattern",
} satisfies RuleEditorState;

describe("rule editor domain", () => {
  it("keeps editable values in canonical state while selecting and removing clauses", () => {
    const changed = transitionRuleEditor({
      state,
      action: { type: "set-field-value", value: "us-*" },
      options: { mode: "edit", allowAddRemove: true },
    });
    expect(changed.rows[0]?.rule.inputs[1]?.matcher.pattern).toBe("us-*");
    const removed = transitionRuleEditor({
      state: changed,
      action: {
        type: "remove-clause",
        ruleId: "one",
        clauseId: changed.rows[0]?.rule.inputs[1]?.id ?? "missing",
      },
      options: { mode: "edit", allowAddRemove: true },
    });
    expect(removed.rows[0]?.rule.inputs).toEqual([
      expect.objectContaining({
        inputPath: "target",
        matcher: { kind: "glob", pattern: "release" },
      }),
    ]);
    expect(removed.clause).toBe(0);
    expect(
      transitionRuleEditor({
        state: removed,
        action: { type: "remove-rule", ruleId: "one" },
        options: { mode: "edit", allowAddRemove: true },
      }).rows,
    ).toEqual([]);
  });

  it("assigns stable clause identities and removes only the addressed clause", () => {
    const initial: RuleEditorState = {
      baseline: [],
      rows: [
        {
          id: "custom-rule",
          origin: "existing",
          rule: {
            toolName: "subagent",
            inputs: [
              {
                id: "agent",
                inputPath: "agent",
                matcher: { kind: "glob", pattern: "*" },
              },
              {
                id: "cwd",
                inputPath: "cwd",
                matcher: { kind: "glob", pattern: "~/Code/**" },
              },
            ],
            decision: "allow",
          },
        },
      ],
      issuedRuleIds: ["custom-rule"],
      issuedClauseOwner: [
        { clauseId: "agent", ruleId: "custom-rule" },
        { clauseId: "cwd", ruleId: "custom-rule" },
      ],
      issuedRuleOrigin: [{ ruleId: "custom-rule", origin: "existing" }],
      selected: 0,
      clause: 0,
      field: "path",
    };
    const removedOriginal = transitionRuleEditor({
      state: initial,
      options: { mode: "edit", allowAddRemove: true },
      action: {
        type: "remove-clause",
        ruleId: "custom-rule",
        clauseId: "agent",
      },
    });
    const added = transitionRuleEditor({
      state: removedOriginal,
      options: { mode: "edit", allowAddRemove: true },
      action: {
        type: "add-clause",
        ruleId: "custom-rule",
        input: {
          inputPath: "agent",
          matcher: { kind: "glob", pattern: "replacement" },
        },
      },
    });
    const replacement = added.rows[0]?.rule.inputs.at(-1);
    if (replacement === undefined)
      throw new Error("missing replacement clause");
    const removedReplacement = transitionRuleEditor({
      state: added,
      options: { mode: "edit", allowAddRemove: true },
      action: {
        type: "remove-clause",
        ruleId: "custom-rule",
        clauseId: replacement.id ?? "missing",
      },
    });
    expect(removedReplacement.rows[0]?.rule.inputs).toEqual([
      expect.objectContaining({ id: "cwd", inputPath: "cwd" }),
    ]);
    expect(() =>
      transitionRuleEditor({
        state: removedReplacement,
        options: { mode: "edit", allowAddRemove: true },
        action: {
          type: "remove-clause",
          ruleId: "custom-rule",
          clauseId: "agent",
        },
      }),
    ).toThrow("unknown clause");
    expect(() =>
      validateRuleEditor({
        state: {
          ...initial,
          rows: [
            {
              ...initial.rows[0],
              rule: {
                ...initial.rows[0].rule,
                inputs: [
                  initial.rows[0].rule.inputs[0],
                  { ...initial.rows[0].rule.inputs[1], id: "agent" },
                ],
              },
            },
          ],
        },
        options: { mode: "edit" },
      }),
    ).toThrow("duplicate clause");
  });

  it("rejects missing rule identities at the untrusted creation boundary", () => {
    expect(() =>
      initializeRuleEditorRows({
        rows: [
          {
            id: "",
            origin: "existing",
            rule: { toolName: "deploy", inputs: [], decision: "allow" },
          },
        ],
      }),
    ).toThrow("rule editor rule is missing");
    expect(() =>
      initializeRuleEditorState({
        state: {
          ...state,
          rows: [{ ...state.rows[0], id: "" }],
        },
      }),
    ).toThrow("rule editor rule is missing");
    const missingId = { ...state.rows[0] };
    Reflect.deleteProperty(missingId, "id");
    expect(() =>
      initializeRuleEditorState({ state: { ...state, rows: [missingId] } }),
    ).toThrow("rule editor rule is missing");
  });

  it("rejects ambiguous rule identities and never reuses a removed clause identity", () => {
    expect(() =>
      transitionRuleEditor({
        state: {
          ...state,
          rows: [state.rows[0], { ...state.rows[0] }],
        },
        action: { type: "reset" },
        options: { mode: "edit", allowAddRemove: true },
      }),
    ).toThrow("duplicate rule");
    const removed = transitionRuleEditor({
      state,
      action: { type: "remove-clause", ruleId: "one", clauseId: "target" },
      options: { mode: "edit", allowAddRemove: true },
    });
    // Runtime callers cannot smuggle a removed original identity through the
    // creation boundary: add-clause always allocates a fresh identity.
    const suppliedCreation = Object.assign(
      {
        inputPath: "target",
        matcher: { kind: "glob" as const, pattern: "new" },
      },
      { id: "target" },
    );
    const added = transitionRuleEditor({
      state: removed,
      action: { type: "add-clause", ruleId: "one", input: suppliedCreation },
      options: { mode: "edit", allowAddRemove: true },
    });
    expect(added.rows[0]?.rule.inputs.at(-1)?.id).not.toBe("target");
  });

  it("never reissues a removed rule or clause identity to new rows", () => {
    const initialRow: EditableRule = {
      id: "A",
      origin: "existing",
      rule: {
        toolName: "deploy",
        inputs: [
          {
            id: "c",
            inputPath: "target",
            matcher: { kind: "glob", pattern: "release" },
          },
        ],
        decision: "allow",
      },
    };
    const initial: RuleEditorState = {
      baseline: [initialRow],
      rows: [initialRow],
      ...ruleEditorIdentityHistory({ rows: [initialRow] }),
      selected: 0,
      clause: 0,
      field: "pattern",
    };
    const options = { mode: "edit" as const, allowAddRemove: true };
    const removedRule = transitionRuleEditor({
      state: initial,
      action: { type: "remove-rule", ruleId: "A" },
      options,
    });
    const replacementRule = transitionRuleEditor({
      state: removedRule,
      action: {
        type: "add-rule",
        rule: {
          origin: "create",
          rule: { toolName: "deploy", inputs: [], decision: "deny" },
        },
      },
      options,
    });
    expect(replacementRule.rows).toHaveLength(1);
    expect(replacementRule.rows[0]?.id).not.toBe("A");

    const removedClause = transitionRuleEditor({
      state: initial,
      action: { type: "remove-clause", ruleId: "A", clauseId: "c" },
      options,
    });
    const suppliedHistoricalClause = Object.assign(
      {
        inputPath: "target",
        matcher: { kind: "glob" as const, pattern: "new" },
      },
      { id: "c" },
    );
    const addedRule = transitionRuleEditor({
      state: removedClause,
      action: {
        type: "add-rule",
        rule: {
          origin: "create",
          rule: {
            toolName: "deploy",
            inputs: [suppliedHistoricalClause],
            decision: "deny",
          },
        },
      },
      options,
    });
    expect(addedRule.rows).toHaveLength(2);
    expect(addedRule.rows[1]?.rule.inputs[0]?.id).not.toBe("c");
  });

  it("allows ASK for a custom tool named protected but not for the protected adapter", () => {
    const custom = {
      ...state,
      rows: [
        {
          ...state.rows[0],
          rule: {
            ...state.rows[0].rule,
            toolName: "protected",
            decision: "deny",
          },
        },
      ],
    } satisfies RuleEditorState;
    expect(
      validateRuleEditor({ state: custom, options: { mode: "edit" } }),
    ).toBeUndefined();
    expect(
      nextRuleEditorDecision({
        state: custom,
        ruleId: "one",
        options: { mode: "edit" },
      }),
    ).toBe("ask");
  });

  it("normalizes empty and out-of-range selections and expands built-in clauses", () => {
    expect(
      normalizeRuleEditorState({ state: { ...state, selected: 9, clause: 9 } }),
    ).toMatchObject({ selected: 0, clause: 1 });
    expect(
      normalizeRuleEditorState({ state: { ...state, rows: [] } }),
    ).toMatchObject({ selected: 0, clause: 0 });
  });

  it("encodes declarations linked to the authoritative custom-tool schema", () => {
    const declaration = {
      decision: "allow",
      guidance: "Only deploy reviewed builds.",
      match: { environment: "production" },
    } satisfies CustomToolRule;
    const encoded = encodeCustomRuleGroups({
      rows: [
        {
          id: "deploy-production",
          origin: "existing",
          rule: {
            toolName: "deploy",
            inputs: [
              {
                id: "environment",
                inputPath: "environment",
                matcher: { kind: "glob", pattern: "production" },
              },
            ],
            decision: declaration.decision,
            guidance: declaration.guidance,
          },
        },
      ],
    });
    expect(Value.Check(customToolNameSchema, "deploy")).toBe(true);
    expect(Value.Check(customToolRuleSchema, encoded.deploy?.[0])).toBe(true);
  });

  it("decodes and encodes own special-name groups without prototype-backed grouping", () => {
    const tools = {
      constructor: [{ decision: "allow" as const, match: { task: "review" } }],
    };
    const rows = decodeCustomRuleGroups({ tools });
    const encoded = encodeCustomRuleGroups({ rows, emptyToolNames: ["empty"] });
    expect(Object.hasOwn(encoded, "constructor")).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(encoded, "constructor")?.value,
    ).toEqual([{ decision: "allow", match: { task: "review" } }]);
    expect(encoded.empty).toEqual([]);
    expect(
      customToolInputCandidates({ input: { nested: [null, 2] } }).candidates,
    ).toEqual([
      expect.objectContaining({
        inputPath: "nested.0",
        initialPattern: "null",
      }),
      expect.objectContaining({ inputPath: "nested.1", initialPattern: "2" }),
    ]);
  });

  it("validates named custom clauses without treating multiline guidance as invalid", () => {
    expect(validateCustomRule({ rule: state.rows[0].rule })).toBeUndefined();
    expect(
      validateCustomRule({
        rule: {
          ...state.rows[0].rule,
          inputs: [
            {
              id: "invalid-path",
              inputPath: "",
              matcher: { kind: "glob", pattern: "*" },
            },
          ],
        },
      }),
    ).toContain("nonempty");
    expect(
      transitionRuleEditor({
        state,
        action: {
          type: "add-clause",
          ruleId: "one",
          input: { inputPath: "", matcher: { kind: "glob", pattern: "" } },
        },
        options: { mode: "edit", allowAddRemove: true },
      }).field,
    ).toBe("path");
  });

  it("has equivalent semantic transitions for a rule and its id-addressed clause", () => {
    const added = transitionRuleEditor({
      state,
      options: { mode: "edit", allowAddRemove: true },
      action: {
        type: "add-clause",
        ruleId: "one",
        input: {
          inputPath: "cwd",
          matcher: { kind: "glob", pattern: "~/Code/**" },
        },
      },
    });
    const addedInput = added.rows[0]?.rule.inputs.at(-1);
    if (addedInput === undefined) throw new Error("missing added clause");
    const selected = transitionRuleEditor({
      state: added,
      options: { mode: "edit", allowAddRemove: true },
      action: {
        type: "select-clause",
        ruleId: "one",
        clauseId: addedInput.id,
      },
    });
    const changed = transitionRuleEditor({
      state: selected,
      options: { mode: "edit", allowAddRemove: true },
      action: { type: "set-field-value", value: "~/Code/config/**" },
    });
    expect(changed.rows[0]?.rule.inputs.at(-1)?.matcher.pattern).toBe(
      "~/Code/config/**",
    );
  });

  it("cycles only editable fields and preserves contexts when a fixed built-in target is reselected", () => {
    const builtinState: RuleEditorState = {
      ...state,
      clause: 0,
      field: "pattern",
      baseline: [],
      rows: [
        {
          ...state.rows[0],
          rule: {
            ...state.rows[0].rule,
            toolName: "read",
            inputs: [
              {
                id: "read-path",
                inputPath: "path",
                matcher: { kind: "glob", pattern: "src/**" },
              },
            ],
            contexts: ["grep"],
          },
        },
      ],
      ...ruleEditorIdentityHistory({
        rows: [
          {
            ...state.rows[0],
            rule: {
              ...state.rows[0].rule,
              toolName: "read",
              inputs: [
                {
                  id: "read-path",
                  inputPath: "path",
                  matcher: { kind: "glob", pattern: "src/**" },
                },
              ],
              contexts: ["grep"],
            },
          },
        ],
      }),
    };
    const fixedBuiltin = {
      mode: "edit" as const,
      builtin: {
        allowedTools: ["read"] as const,
        defaultTool: "read" as const,
      },
    };
    expect(
      nextRuleEditorFocus({ state: builtinState, options: fixedBuiltin }),
    ).toBe("guidance");
    expect(
      nextRuleEditorFocus({
        state: { ...builtinState, field: "guidance" },
        options: fixedBuiltin,
      }),
    ).toBe("pattern");
    expect(
      nextRuleEditorFocus({
        state: { ...state, field: "tool" },
        options: { mode: "edit" },
      }),
    ).toBe("path");
    expect(
      nextRuleEditorFocus({
        state: { ...state, field: "path" },
        options: { mode: "ask", lockedToolName: "deploy" },
      }),
    ).toBe("pattern");
    const cycled = transitionRuleEditor({
      state: builtinState,
      options: fixedBuiltin,
      action: { type: "cycle-built-in-target", ruleId: "one" },
    });
    expect(cycled.rows[0]?.rule.contexts).toEqual(["grep"]);
    expect(cycled.field).toBe("pattern");
    expect(() =>
      transitionRuleEditor({
        state: builtinState,
        options: { mode: "edit" },
        action: { type: "cycle-built-in-target", ruleId: "one" },
      }),
    ).toThrow("not enabled");
  });

  it("allows a zero-clause ASK catch-all to leave the editor for submission confirmation", () => {
    const catchAll = {
      ...state,
      rows: [{ ...state.rows[0], rule: { ...state.rows[0].rule, inputs: [] } }],
    };
    expect(
      validateRuleEditor({ state: catchAll, options: { mode: "ask" } }),
    ).toBeUndefined();
    expect(
      canSaveRuleEditor({ state: catchAll, options: { mode: "ask" } }),
    ).toBe(true);
  });

  it("skips invalid drafts, enforces built-in constraints, and resets to its invocation baseline", () => {
    const baseline = [state.rows[0]];
    const invocation = { ...state, baseline };
    const skipped = transitionRuleEditor({
      state: invocation,
      options: { mode: "ask", allowAddRemove: true },
      action: { type: "set-decision", ruleId: "one", decision: "skip" },
    });
    expect(
      validateRuleEditor({ state: skipped, options: { mode: "ask" } }),
    ).toBeUndefined();
    expect(
      encodeCustomRuleGroups({
        rows: [
          {
            ...skipped.rows[0],
            rule: {
              ...skipped.rows[0].rule,
              toolName: "",
              inputs: [
                {
                  id: "skipped-invalid-path",
                  inputPath: "",
                  matcher: { kind: "glob", pattern: "" },
                },
              ],
            },
          },
        ],
      }),
    ).toEqual({});
    expect(
      canSaveRuleEditor({ state: skipped, options: { mode: "ask" } }),
    ).toBe(false);
    const changed = transitionRuleEditor({
      state: invocation,
      action: { type: "set-field-value", value: "different" },
      options: { mode: "edit", allowAddRemove: true },
    });
    expect(
      transitionRuleEditor({
        state: changed,
        options: { mode: "edit" },
        action: { type: "reset" },
      }).rows,
    ).toMatchObject(baseline);
    const protectedAsk = {
      ...state.rows[0],
      rule: {
        ...state.rows[0].rule,
        toolName: "protected",
        decision: "ask",
        inputs: [
          {
            id: "target",
            inputPath: "path",
            matcher: { kind: "glob", pattern: "*" },
          },
        ],
      },
    } satisfies EditableRule;
    const protectedOptions = {
      mode: "edit" as const,
      builtin: {
        allowedTools: ["protected"] as const,
        defaultTool: "protected" as const,
      },
    };
    expect(
      validateRuleEditor({
        state: { ...invocation, rows: [protectedAsk] },
        options: protectedOptions,
      })?.message,
    ).toContain("ask is not valid");
    expect(
      nextRuleEditorDecision({
        state: {
          ...invocation,
          rows: [
            {
              ...protectedAsk,
              rule: { ...protectedAsk.rule, decision: "allow" },
            },
          ],
        },
        ruleId: "one",
        options: protectedOptions,
      }),
    ).toBe("deny");
  });

  it("prefills URL queries and backslash-containing values as warned raw globs", () => {
    const rawUrl = "https://example.test/search?q=one";
    const rawPath = "workspace\\reports\\today";
    expect(
      customToolInputCandidates({
        input: { url: rawUrl, resourcePath: rawPath },
      }).candidates,
    ).toEqual([
      {
        inputPath: "url",
        value: rawUrl,
        initialPattern: rawUrl,
        rawGlobWarning: rawGlobWarning({ inputPath: "url" }),
      },
      {
        inputPath: "resourcePath",
        value: rawPath,
        initialPattern: rawPath,
        rawGlobWarning: rawGlobWarning({ inputPath: "resourcePath" }),
      },
    ]);
  });

  it("visits aliased scalar leaves, but not cycles, while using own enumerable keys", () => {
    const shared = { leaf: "*" };
    const cyclic: { self?: unknown; value: string } = { value: "safe" };
    cyclic.self = cyclic;
    const inherited = { own: "yes" };
    Object.setPrototypeOf(inherited, { ignored: "nope" });
    const { candidates, unconstrainedPaths } = customToolInputCandidates({
      input: { first: shared, second: shared, cyclic, inherited },
    });
    expect(unconstrainedPaths).toEqual(["cyclic.self"]);
    expect(
      candidates.find((candidate) => candidate.inputPath === "first.leaf")
        ?.rawGlobWarning,
    ).toBe(rawGlobWarning({ inputPath: "first.leaf" }));
    expect(
      candidates.find((candidate) => candidate.inputPath === "second.leaf")
        ?.rawGlobWarning,
    ).toBe(rawGlobWarning({ inputPath: "second.leaf" }));
    expect(candidates.map((candidate) => candidate.inputPath)).toEqual(
      expect.arrayContaining(["cyclic.value", "inherited.own"]),
    );
  });
});
